import { defineOption } from "cmdore"

export const outDir = defineOption({
  name: "out-dir",
  description: "Directory where the built site is written.",
  arity: 1,
})
