import { defineOption } from "cmdore"

export const port = defineOption({
  name: "port",
  description: "Port for the development server.",
  arity: 1,
  coerce: (raw, { label }) => {
    const value = Number(raw)

    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
      throw new Error(`${label} must be an integer from 1 to 65535`)
    }

    return value
  },
})
