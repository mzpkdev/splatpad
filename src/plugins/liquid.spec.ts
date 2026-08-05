import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, describe as context, expect, it, vi } from "vitest"
import { liquidPlugin } from "./liquid"

describe("liquidPlugin", () => {
  let siteRoot: string

  beforeEach(async () => {
    siteRoot = await mkdtemp(join(tmpdir(), "splatpad-liquid-"))
    await Promise.all(
      ["data", "layouts", "pages", "partials"].map((directory) => mkdir(join(siteRoot, directory))),
    )
    await writeFile(join(siteRoot, "pages/index.liquid"), "Hello, {{ site.name }}!")
    await writeFile(
      join(siteRoot, "data/site.json"),
      JSON.stringify({ site: { name: "Splatpad" } }),
    )
  })

  afterEach(async () => {
    await rm(siteRoot, { recursive: true })
  })

  it("renders the configured page using site JSON", async () => {
    const plugin = liquidPlugin({ root: siteRoot })
    const transform = plugin.transformIndexHtml

    expect(transform).toBeTypeOf("object")
    if (typeof transform !== "object" || transform === null) {
      throw new Error("Expected an object transform hook")
    }

    const render = transform.handler as () => Promise<string>
    await expect(render()).resolves.toBe("Hello, Splatpad!")
  })

  context("when a template references missing data", () => {
    it("rejects the render instead of silently producing empty output", async () => {
      await writeFile(join(siteRoot, "pages/index.liquid"), "Hello, {{ missing.name }}!")
      const plugin = liquidPlugin({ root: siteRoot })
      const transform = plugin.transformIndexHtml

      if (typeof transform !== "object" || transform === null) {
        throw new Error("Expected an object transform hook")
      }

      const render = transform.handler as () => Promise<string>
      await expect(render()).rejects.toThrow()
    })
  })

  context.each([
    ["a Liquid template", "pages/about.liquid"],
    ["a Liquid template below .well-known", ".well-known/page.liquid"],
    ["a Liquid template below ..draft", "..draft/page.liquid"],
    ["site JSON data", "data/navigation.json"],
  ])("when %s changes", (_description, relativeFile) => {
    it("requests a full browser reload", () => {
      const send = vi.fn()
      const plugin = liquidPlugin({ root: siteRoot })
      const hook = plugin.handleHotUpdate
      const handleHotUpdate = typeof hook === "function" ? hook : hook?.handler

      const result = handleHotUpdate?.call(
        {} as never,
        {
          file: join(siteRoot, relativeFile),
          server: { ws: { send } },
        } as never,
      )

      expect(send).toHaveBeenCalledWith({ type: "full-reload" })
      expect(result).toEqual([])
    })
  })

  context("when a custom data file is configured", () => {
    context.each([
      ["that data file", "site.json"],
      ["sibling JSON", "navigation.json"],
    ])("and %s changes", (_description, relativeFile) => {
      it("requests a full browser reload", async () => {
        const contentRoot = join(siteRoot, "content")
        await mkdir(contentRoot)
        await writeFile(
          join(contentRoot, "site.json"),
          JSON.stringify({ site: { name: "Custom Splatpad" } }),
        )
        const send = vi.fn()
        const plugin = liquidPlugin({
          root: siteRoot,
          data: "content/site.json",
        })
        const hook = plugin.handleHotUpdate
        const handleHotUpdate = typeof hook === "function" ? hook : hook?.handler

        const result = handleHotUpdate?.call(
          {} as never,
          {
            file: join(contentRoot, relativeFile),
            server: { ws: { send } },
          } as never,
        )

        expect(send).toHaveBeenCalledWith({ type: "full-reload" })
        expect(result).toEqual([])
      })
    })
  })

  context("when a Liquid template outside the site root changes", () => {
    it("leaves Vite hot updates unchanged", () => {
      const send = vi.fn()
      const plugin = liquidPlugin({ root: siteRoot })
      const hook = plugin.handleHotUpdate
      const handleHotUpdate = typeof hook === "function" ? hook : hook?.handler

      const result = handleHotUpdate?.call(
        {} as never,
        {
          file: join(siteRoot, "..", "outside.liquid"),
          server: { ws: { send } },
        } as never,
      )

      expect(send).not.toHaveBeenCalled()
      expect(result).toBeUndefined()
    })
  })

  context.each([
    ["a non-template file", "src/main.ts"],
    ["JSON outside the data directory", "pages/content.json"],
  ])("when %s changes", (_description, relativeFile) => {
    it("leaves Vite hot updates unchanged", () => {
      const send = vi.fn()
      const plugin = liquidPlugin({ root: siteRoot })
      const hook = plugin.handleHotUpdate
      const handleHotUpdate = typeof hook === "function" ? hook : hook?.handler

      const result = handleHotUpdate?.call(
        {} as never,
        {
          file: join(siteRoot, relativeFile),
          server: { ws: { send } },
        } as never,
      )

      expect(send).not.toHaveBeenCalled()
      expect(result).toBeUndefined()
    })
  })
})
