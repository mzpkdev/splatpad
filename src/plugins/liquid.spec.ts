import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, describe as context, expect, it, vi } from "vitest"
import type { Plugin } from "vite"
import { discoverSiteRoutes } from "../core/site-routes"
import { liquidPlugin } from "./liquid"

const renderFor = async (plugin: Plugin, requestPath: string): Promise<string | void> => {
  const transform = plugin.transformIndexHtml
  if (typeof transform !== "object" || transform === null) {
    throw new Error("Expected an object transform hook")
  }
  const result = await transform.handler.call({} as never, "entry", { path: requestPath } as never)
  if (result !== undefined && typeof result !== "string") {
    throw new Error("Expected the transform hook to return HTML")
  }
  return result
}

const triggerHotUpdate = async (
  plugin: Plugin,
  type: "create" | "update" | "delete",
  file: string,
  send: ReturnType<typeof vi.fn>,
): Promise<unknown> => {
  const hook = plugin.hotUpdate
  const handler = typeof hook === "object" ? hook.handler : hook
  return handler?.call(
    { environment: {} } as never,
    {
      type,
      file,
      modules: [],
      read: vi.fn(),
      server: { hot: { send } },
      timestamp: Date.now(),
    } as never,
  )
}

describe("liquidPlugin", () => {
  let siteRoot: string

  beforeEach(async () => {
    siteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "splatpad-liquid-"))
    await Promise.all(
      ["data", "layouts", "pages", "partials"].map((directory) =>
        fs.mkdir(path.join(siteRoot, directory)),
      ),
    )
    await fs.writeFile(path.join(siteRoot, "pages/index.liquid"), "Hello, {{ site.name }}!")
    await fs.writeFile(
      path.join(siteRoot, "data/site.json"),
      JSON.stringify({ site: { name: "Splatpad" }, pages: { "/": { title: "Home" } } }),
    )
  })

  afterEach(async () => {
    vi.useRealTimers()
    await fs.rm(siteRoot, { recursive: true })
  })

  it("renders a discovered page using site JSON", async () => {
    const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

    await expect(renderFor(plugin, "/")).resolves.toBe("Hello, Splatpad!")
  })

  it.each([
    ["about.html", "/about/"],
    ["contact.liquid.html", "/contact/"],
  ])("renders the %s alias through LiquidJS", async (file, route) => {
    await fs.writeFile(path.join(siteRoot, "pages", file), `Alias {{ route }}`)
    const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

    await expect(renderFor(plugin, route)).resolves.toBe(`Alias ${route}`)
  })

  it("renders nested templates with optional route data", async () => {
    await fs.mkdir(path.join(siteRoot, "pages", "journal"))
    await fs.writeFile(
      path.join(siteRoot, "pages", "journal", "post.liquid"),
      "{{ route }} {{ page.title }}",
    )
    await fs.writeFile(
      path.join(siteRoot, "data/site.json"),
      JSON.stringify({ pages: { "/journal/post/": { title: "Post" } } }),
    )
    const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

    await expect(renderFor(plugin, "/journal/post/index.html")).resolves.toBe("/journal/post/ Post")
  })

  it("renders a discovered route without a matching pages data key", async () => {
    await fs.writeFile(path.join(siteRoot, "pages", "about.liquid"), "{{ route }}")
    const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

    await expect(renderFor(plugin, "/about/")).resolves.toBe("/about/")
  })

  context("when rendering an unknown route", () => {
    it("rejects instead of selecting another page", async () => {
      const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

      await expect(renderFor(plugin, "/missing/")).rejects.toThrow(
        'Unknown site route "/missing/".',
      )
    })
  })

  context("when a template references missing data", () => {
    it("rejects the render instead of silently producing empty output", async () => {
      await fs.writeFile(path.join(siteRoot, "pages/index.liquid"), "Hello, {{ missing.name }}!")
      const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

      await expect(renderFor(plugin, "/")).rejects.toThrow()
    })
  })

  it.each(["create", "update", "delete"] as const)(
    "queues a full reload when a page receives a %s event",
    async (type) => {
      vi.useFakeTimers()
      const send = vi.fn()
      const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

      await triggerHotUpdate(plugin, type, path.join(siteRoot, "pages", "about.liquid"), send)
      await vi.advanceTimersByTimeAsync(25)

      expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" })
    },
  )

  it.each(["layouts/base.liquid", "partials/card.liquid", "data/site.json"])(
    "queues a full reload when %s changes",
    async (relativeFile) => {
      vi.useFakeTimers()
      const send = vi.fn()
      const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

      await triggerHotUpdate(plugin, "update", path.join(siteRoot, relativeFile), send)
      await vi.advanceTimersByTimeAsync(25)

      expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" })
    },
  )

  it.each(["pages/about.html", "layouts/base.liquid.html", "partials/card.html"])(
    "queues a full reload for the template alias %s",
    async (relativeFile) => {
      vi.useFakeTimers()
      const send = vi.fn()
      const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

      await triggerHotUpdate(plugin, "update", path.join(siteRoot, relativeFile), send)
      await vi.advanceTimersByTimeAsync(25)

      expect(send).toHaveBeenCalledWith({ type: "full-reload", path: "*" })
    },
  )

  it("debounces related file events into one reload", async () => {
    vi.useFakeTimers()
    const send = vi.fn()
    const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })

    await triggerHotUpdate(plugin, "delete", path.join(siteRoot, "pages", "old.liquid"), send)
    await triggerHotUpdate(plugin, "create", path.join(siteRoot, "pages", "new.liquid"), send)
    await vi.advanceTimersByTimeAsync(25)

    expect(send).toHaveBeenCalledOnce()
  })

  context("when a custom data file is configured", () => {
    it("watches that exact data file", async () => {
      vi.useFakeTimers()
      const contentRoot = path.join(siteRoot, "content")
      await fs.mkdir(contentRoot)
      await fs.writeFile(path.join(contentRoot, "site.json"), JSON.stringify({ site: {} }))
      const send = vi.fn()
      const plugin = liquidPlugin({
        root: siteRoot,
        data: "content/site.json",
        routes: discoverSiteRoutes(siteRoot),
      })

      await triggerHotUpdate(plugin, "update", path.join(contentRoot, "site.json"), send)
      await vi.advanceTimersByTimeAsync(25)

      expect(send).toHaveBeenCalledOnce()
    })
  })

  it.each(["outside.liquid", "pages/content.json", "data/navigation.json", "src/main.ts"])(
    "leaves unrelated update %s to Vite",
    async (relativeFile) => {
      vi.useFakeTimers()
      const send = vi.fn()
      const plugin = liquidPlugin({ root: siteRoot, routes: discoverSiteRoutes(siteRoot) })
      const file =
        relativeFile === "outside.liquid"
          ? path.join(siteRoot, "..", relativeFile)
          : path.join(siteRoot, relativeFile)

      const result = await triggerHotUpdate(plugin, "update", file, send)
      await vi.advanceTimersByTimeAsync(25)

      expect(send).not.toHaveBeenCalled()
      expect(result).toBeUndefined()
    },
  )

  it("provides virtual HTML only for discovered build entries", async () => {
    const routes = discoverSiteRoutes(siteRoot)
    const plugin = liquidPlugin({ root: siteRoot, routes })
    const resolveId =
      typeof plugin.resolveId === "object" ? plugin.resolveId.handler : plugin.resolveId
    const load = typeof plugin.load === "object" ? plugin.load.handler : plugin.load

    expect(await resolveId?.call({} as never, routes[0]!.entry, undefined, {} as never)).toBe(
      routes[0]!.entry,
    )
    expect(await load?.call({} as never, routes[0]!.entry)).toContain("<!doctype html>")
    expect(
      await resolveId?.call(
        {} as never,
        path.join(siteRoot, "missing.html"),
        undefined,
        {} as never,
      ),
    ).toBeNull()
  })
})
