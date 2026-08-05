import {
  afterEach,
  beforeEach,
  describe,
  describe as context,
  expect,
  it,
  vi,
} from "vitest"

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  terminal: { error: vi.fn() },
}))

vi.mock("cmdore", () => ({
  defineArgument: vi.fn((value) => value),
  defineCommand: vi.fn((value) => value),
  defineOption: vi.fn((value) => value),
  effect: vi.fn((value) => value),
  execute: mocks.execute,
  terminal: mocks.terminal,
}))

describe("the Splatpad CLI", () => {
  let originalExitCode: string | number | null | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.execute.mockReset()
    originalExitCode = process.exitCode
    process.exitCode = undefined
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit must not be called")
    })
  })

  afterEach(() => {
    process.exitCode = originalExitCode
    vi.restoreAllMocks()
    vi.resetModules()
  })

  context("when a command completes successfully", () => {
    it("assigns the command result to process.exitCode without exiting", async () => {
      mocks.execute.mockResolvedValue(23)

      await import("./cli")
      await vi.waitFor(() => expect(process.exitCode).toBe(23))

      expect(process.exit).not.toHaveBeenCalled()
      expect(mocks.terminal.error).not.toHaveBeenCalled()
    })
  })

  context("when command execution fails", () => {
    it("reports the error and assigns exit code 1 without exiting", async () => {
      mocks.execute.mockRejectedValue(new Error("site build failed"))

      await import("./cli")
      await vi.waitFor(() => expect(process.exitCode).toBe(1))

      expect(mocks.terminal.error).toHaveBeenCalledWith("site build failed")
      expect(process.exit).not.toHaveBeenCalled()
    })
  })
})
