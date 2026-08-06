import { resolve } from "node:path"
import { defineCommand, effect, terminal } from "cmdore"
import { createServer, type ResolvedServerUrls } from "vite"
import { siteRoot } from "../arguments/index"
import { createSiteConfig } from "../core/site-config"
import { untilTerminated } from "../core/until-terminated"
import { host, port } from "../options/index"
import { designPath } from "../plugins/designer"

const appendDesignPath = (serverUrl: string): string => new URL(designPath, serverUrl).toString()

const designUrls = (urls: ResolvedServerUrls | null): ResolvedServerUrls => ({
  local: urls?.local.map(appendDesignPath) ?? [],
  network: urls?.network.map(appendDesignPath) ?? [],
})

export const design = async (
  root = ".",
  hostname?: string,
  portNumber?: number,
  waitForTermination: () => Promise<void> = untilTerminated,
): Promise<void> => {
  const absoluteRoot = resolve(process.cwd(), root)
  const server = await createServer(
    createSiteConfig(absoluteRoot, {
      design: true,
      server: { host: hostname, port: portNumber },
    }),
  )

  try {
    await server.listen()
    const urls = designUrls(server.resolvedUrls)
    if (!terminal.quiet && !terminal.jsonMode) {
      for (const serverUrl of [...urls.local, ...urls.network]) {
        terminal.log(serverUrl)
      }
    }
    terminal.json({ command: "design", root: absoluteRoot, urls })
    await waitForTermination()
  } finally {
    await server.close()
  }
}

export default defineCommand({
  name: "design",
  description: "Show every site route on a read-only design canvas.",
  arguments: [siteRoot],
  options: [host, port],
  run: ({ root, host: hostname, port: portNumber }) =>
    effect(() => design(root, hostname, portNumber)),
})
