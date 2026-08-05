import { beforeEach, describe, describe as context, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  liquidPlugin: vi.fn(() => ({ name: "splatpad:liquid" })),
  presetWind4: vi.fn(() => ({ name: "wind4-preset" })),
  terminal: { quiet: false, jsonMode: false },
  unoCss: vi.fn(() => ({ name: "unocss" })),
}))

vi.mock("@unocss/preset-wind4", () => ({ presetWind4: mocks.presetWind4 }))
vi.mock("cmdore", () => ({ terminal: mocks.terminal }))
vi.mock("unocss/vite", () => ({ default: mocks.unoCss }))
vi.mock("../plugins/liquid", () => ({ liquidPlugin: mocks.liquidPlugin }))

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
      configFile: false,
      logLevel: "info",
      build: { outDir: "/sites/example/dist", emptyOutDir: true },
      server,
    })
    expect(mocks.liquidPlugin).toHaveBeenCalledWith({ root: "/sites/example" })
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
