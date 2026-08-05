import { terminal } from "cmdore"
import { main } from "./main"

try {
  process.exitCode = await main(...process.argv.slice(2))
} catch (error: unknown) {
  terminal.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
