import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  discoverSiteRoutes,
  findSiteRoute,
  isTemplateFile,
  routeFromRequestPath,
  templateExtensionFor,
} from "./site-routes"

describe("site routes", () => {
  let siteRoot: string

  beforeEach(async () => {
    siteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "splatpad-routes-"))
    await fs.mkdir(path.join(siteRoot, "pages"))
  })

  afterEach(async () => {
    await fs.rm(siteRoot, { recursive: true })
  })

  it("discovers all supported extensions across root, flat, and nested routes", async () => {
    await fs.mkdir(path.join(siteRoot, "pages", "journal"), { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(siteRoot, "pages", "index.liquid"), "Home"),
      fs.writeFile(path.join(siteRoot, "pages", "about.html"), "About"),
      fs.writeFile(path.join(siteRoot, "pages", "journal", "index.liquid.html"), "Journal"),
      fs.writeFile(path.join(siteRoot, "pages", "journal", "post.liquid"), "Post"),
      fs.writeFile(path.join(siteRoot, "pages", "ignored.txt"), "ignored"),
    ])

    expect(
      discoverSiteRoutes(siteRoot).map(({ route, templateName }) => ({ route, templateName })),
    ).toEqual([
      { route: "/", templateName: "index" },
      { route: "/about/", templateName: "about" },
      { route: "/journal/", templateName: "journal/index" },
      { route: "/journal/post/", templateName: "journal/post" },
    ])
  })

  it.each([
    ["page.liquid.html", ".liquid.html"],
    ["page.liquid", ".liquid"],
    ["page.html", ".html"],
  ])("matches the longest supported suffix for %s", (file, extension) => {
    expect(templateExtensionFor(file)).toBe(extension)
    expect(isTemplateFile(file)).toBe(true)
  })

  it("ignores unsupported page extensions", () => {
    expect(isTemplateFile("page.txt")).toBe(false)
    expect(isTemplateFile("page.md")).toBe(false)
  })

  it("returns output-shaped entry paths without requiring the files", async () => {
    await fs.mkdir(path.join(siteRoot, "pages", "journal"), { recursive: true })
    await fs.writeFile(path.join(siteRoot, "pages", "journal", "post.liquid"), "Post")

    expect(discoverSiteRoutes(siteRoot)).toEqual([
      {
        entry: path.join(siteRoot, "journal", "post", "index.html"),
        inputName: "journal/post",
        route: "/journal/post/",
        template: path.join(siteRoot, "pages", "journal", "post.liquid"),
        templateName: "journal/post",
      },
    ])
  })

  it("rejects templates that collapse onto the same route", async () => {
    await fs.mkdir(path.join(siteRoot, "pages", "blog"), { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(siteRoot, "pages", "blog.liquid"), "Blog"),
      fs.writeFile(path.join(siteRoot, "pages", "blog", "index.html"), "Blog index"),
    ])

    expect(() => discoverSiteRoutes(siteRoot)).toThrow('Route collision for "/blog/"')
  })

  it("rejects extension aliases for the same page", async () => {
    await Promise.all([
      fs.writeFile(path.join(siteRoot, "pages", "about.liquid"), "Liquid"),
      fs.writeFile(path.join(siteRoot, "pages", "about.liquid.html"), "Liquid HTML"),
      fs.writeFile(path.join(siteRoot, "pages", "about.html"), "HTML"),
    ])

    expect(() => discoverSiteRoutes(siteRoot)).toThrow('Route collision for "/about/"')
  })

  it.each([
    ["/", "/"],
    ["/index.html", "/"],
    ["/journal/post", "/journal/post/"],
    ["/journal/post/", "/journal/post/"],
    ["/journal/post/index.html?preview=true", "/journal/post/"],
  ])("normalizes request path %s to %s", (requestPath, route) => {
    expect(routeFromRequestPath(requestPath)).toBe(route)
  })

  it("finds known routes and returns undefined for unknown routes", async () => {
    await fs.writeFile(path.join(siteRoot, "pages", "index.liquid"), "Home")
    const routes = discoverSiteRoutes(siteRoot)

    expect(findSiteRoute(routes, "/")?.templateName).toBe("index")
    expect(findSiteRoute(routes, "/missing/")).toBeUndefined()
  })

  it("rejects symbolic links inside pages", async () => {
    const outside = path.join(siteRoot, "outside.liquid")
    await fs.writeFile(outside, "Outside")
    await fs.symlink(outside, path.join(siteRoot, "pages", "linked.liquid"))

    expect(() => discoverSiteRoutes(siteRoot)).toThrow("Page templates cannot be symbolic links")
  })

  it.each(["about us.html", "Uppercase.liquid.html", "..liquid", "journal/.html"])(
    "rejects the invalid page path %s",
    async (relativeTemplate) => {
      const template = path.join(siteRoot, "pages", relativeTemplate)
      await fs.mkdir(path.dirname(template), { recursive: true })
      await fs.writeFile(template, "Invalid")

      expect(() => discoverSiteRoutes(siteRoot)).toThrow("must be lowercase kebab-case")
    },
  )
})
