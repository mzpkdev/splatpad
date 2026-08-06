import * as fs from "node:fs/promises"
import * as url from "node:url"
import { execute } from "cmdore"
import { buildCommand, designCommand, serveCommand } from "./commands/index"

interface PackageMetadata {
  name?: string
  version?: string
  description?: string
}

export const main = async (...argv: string[]): Promise<number> => {
  const packagePath = url.fileURLToPath(new URL("../package.json", import.meta.url))
  const packageJson = JSON.parse(await fs.readFile(packagePath, "utf8")) as PackageMetadata

  return execute([buildCommand, designCommand, serveCommand], {
    argv,
    metadata: {
      name: packageJson.name ?? "splatpad",
      version: packageJson.version,
      description: packageJson.description,
    },
    onError: "throw",
  })
}
