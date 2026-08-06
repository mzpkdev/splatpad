import { resolve } from "node:path"
import { beforeEach, describe, describe as context, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  close: vi.fn(),
  createServer: vi.fn(),
  createSiteConfig: vi.fn(() => ({ config: true })),
  listen: vi.fn(),
  terminal: { json: vi.fn(), log: vi.fn(), quiet: false, jsonMode: false },
}))

vi.mock("cmdore", () => ({
  defineArgument: vi.fn((value) => value),
  defineCommand: vi.fn((value) => value),
  defineOption: vi.fn((value) => value),
  effect: vi.fn((value) => value),
  terminal: mocks.terminal,
}))
vi.mock("vite", () => ({ createServer: mocks.createServer }))
vi.mock("../core/site-config", () => ({
  createSiteConfig: mocks.createSiteConfig,
}))

import { design } from "./design"

describe("design", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.terminal.quiet = false
    mocks.terminal.jsonMode = false
    mocks.createServer.mockResolvedValue({
      close: mocks.close,
      listen: mocks.listen,
      resolvedUrls: {
        local: ["http://localhost:4173/"],
        network: ["http://192.168.1.4:4173/"],
      },
    })
  })

  it("serves the requested site with the designer enabled", async () => {
    const waitForTermination = vi.fn().mockResolvedValue(undefined)
    const absoluteRoot = resolve(process.cwd(), "fixtures/site")

    await design("fixtures/site", "127.0.0.1", 4173, waitForTermination)

    expect(mocks.createSiteConfig).toHaveBeenCalledWith(absoluteRoot, {
      design: true,
      server: { host: "127.0.0.1", port: 4173 },
    })
    expect(mocks.listen).toHaveBeenCalledOnce()
    expect(mocks.terminal.log).toHaveBeenCalledWith("http://localhost:4173/__splatpad/design/")
    expect(mocks.terminal.log).toHaveBeenCalledWith("http://192.168.1.4:4173/__splatpad/design/")
    expect(waitForTermination).toHaveBeenCalledOnce()
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  context("when terminal output is machine-readable", () => {
    it("reports design URLs without interactive output", async () => {
      mocks.terminal.jsonMode = true

      await design(".", undefined, undefined, async () => undefined)

      expect(mocks.terminal.log).not.toHaveBeenCalled()
      expect(mocks.terminal.json).toHaveBeenCalledWith({
        command: "design",
        root: process.cwd(),
        urls: {
          local: ["http://localhost:4173/__splatpad/design/"],
          network: ["http://192.168.1.4:4173/__splatpad/design/"],
        },
      })
    })
  })

  context("when termination waiting fails", () => {
    it("closes the Vite server before propagating the failure", async () => {
      const failure = new Error("termination failed")

      await expect(
        design(".", undefined, undefined, async () => Promise.reject(failure)),
      ).rejects.toBe(failure)
      expect(mocks.close).toHaveBeenCalledOnce()
    })
  })
})
