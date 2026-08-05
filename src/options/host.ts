import { defineOption } from "cmdore"

export const host = defineOption({
  name: "host",
  description: "Host interface for the development server.",
  arity: 1,
})
