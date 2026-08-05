import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { execute, terminal } from 'cmdore'
import { buildCommand, serveCommand } from './commands/index'

interface PackageMetadata {
  name?: string
  version?: string
  description?: string
}

export const main = async (...argv: string[]): Promise<number> => {
  const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
  const packageJson = JSON.parse(
    await readFile(packagePath, 'utf8'),
  ) as PackageMetadata

  return execute([buildCommand, serveCommand], {
    argv,
    metadata: {
      name: packageJson.name ?? 'splatpad',
      version: packageJson.version,
      description: packageJson.description,
    },
    onError: 'throw',
  })
}

main(...process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    terminal.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
