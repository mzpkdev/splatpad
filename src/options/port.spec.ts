import { describe, describe as context, expect, it, vi } from "vitest"

vi.mock("cmdore", () => ({ defineOption: vi.fn((value) => value) }))

import { port } from "./port"

const coerce = port.coerce as (raw: string, context: { label: string }) => number

describe("port option coercion", () => {
  it("accepts integer ports across the valid range", () => {
    expect(coerce("1", { label: "--port" })).toBe(1)
    expect(coerce("4173", { label: "--port" })).toBe(4173)
    expect(coerce("65535", { label: "--port" })).toBe(65_535)
  })

  context.each(["0", "65536", "1.5", "not-a-number"])("when the raw value is %s", (raw) => {
    it("rejects it with the option label and allowed range", () => {
      expect(() => coerce(raw, { label: "--port" })).toThrow(
        "--port must be an integer from 1 to 65535",
      )
    })
  })
})
