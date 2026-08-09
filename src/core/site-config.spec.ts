import { beforeEach, describe, describe as context, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  designerPlugin: vi.fn(() => ({ name: "splatpad:designer" })),
  liquidPlugin: vi.fn(() => ({ name: "splatpad:liquid" })),
  presetWind4: vi.fn(() => ({ name: "wind4-preset" })),
  terminal: { quiet: false, jsonMode: false },
  unoCss: vi.fn(() => ({ name: "unocss" })),
  routes: [
    {
      entry: "/sites/example/index.html",
      inputName: "index",
      route: "/",
      template: "/sites/example/pages/index.liquid",
      templateName: "index",
    },
    {
      entry: "/sites/example/menu/index.html",
      inputName: "menu",
      route: "/menu/",
      template: "/sites/example/pages/menu.liquid",
      templateName: "menu",
    },
    {
      entry: "/sites/example/journal/post/index.html",
      inputName: "journal/post",
      route: "/journal/post/",
      template: "/sites/example/pages/journal/post.liquid",
      templateName: "journal/post",
    },
  ],
}))

vi.mock("@unocss/preset-wind4", () => ({ presetWind4: mocks.presetWind4 }))
vi.mock("cmdore", () => ({ terminal: mocks.terminal }))
vi.mock("unocss/vite", () => ({ default: mocks.unoCss }))
vi.mock("../plugins/designer", () => ({ designerPlugin: mocks.designerPlugin }))
vi.mock("../plugins/liquid", () => ({ liquidPlugin: mocks.liquidPlugin }))
vi.mock("./site-routes", () => ({ discoverSiteRoutes: vi.fn(() => mocks.routes) }))

import { createSiteConfig } from "./site-config"

describe("createSiteConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.terminal.quiet = false
    mocks.terminal.jsonMode = false
  })

  it("creates an isolated site configuration with Liquid and Wind4", () => {
    const server = { host: "127.0.0.1", port: 4173 }
    const config = createSiteConfig("/sites/example", {
      outDir: "/sites/example/dist",
      server,
    })

    expect(config).toMatchObject({
      root: "/sites/example",
      appType: "mpa",
      configFile: false,
      logLevel: "info",
      server,
    })
    expect(config.build).toEqual({
      outDir: "/sites/example/dist",
      emptyOutDir: true,
      rollupOptions: {
        input: {
          index: "/sites/example/index.html",
          menu: "/sites/example/menu/index.html",
          "journal/post": "/sites/example/journal/post/index.html",
        },
      },
    })
    expect(mocks.liquidPlugin).toHaveBeenCalledWith({
      root: "/sites/example",
      routes: mocks.routes,
    })
    expect(mocks.presetWind4).toHaveBeenCalledOnce()
    expect(mocks.unoCss).toHaveBeenCalledWith({
      configFile: false,
      inspector: false,
      presets: [{ name: "wind4-preset" }],
    })
  })

  context("when no build output is configured", () => {
    it("lets Vite use its normal build defaults", () => {
      expect(createSiteConfig("/sites/example").build).toBeUndefined()
    })
  })

  context("when design mode is enabled", () => {
    it("mounts the designer before the site renderer", () => {
      const config = createSiteConfig("/sites/example", { design: true })

      expect(config.plugins).toMatchObject([
        { name: "splatpad:designer" },
        { name: "splatpad:liquid" },
        { name: "unocss" },
      ])
      expect(mocks.designerPlugin).toHaveBeenCalledWith({ root: "/sites/example" })
    })
  })

  context.each([
    ["quiet mode", "quiet"],
    ["JSON mode", "jsonMode"],
  ] as const)("when terminal %s is enabled", (_description, mode) => {
    it("silences Vite logging", () => {
      mocks.terminal[mode] = true

      expect(createSiteConfig("/sites/example").logLevel).toBe("silent")
    })
  })
})
