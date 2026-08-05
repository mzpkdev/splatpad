import { resolve } from 'node:path'
import { defineCommand, effect, terminal } from 'cmdore'
import { createServer } from 'vite'
import { siteRoot } from '../arguments/index'
import { createSiteConfig } from '../core/site-config'
import { untilTerminated } from '../core/until-terminated'
import { host, port } from '../options/index'

export const serve = async (
  root = '.',
  hostname?: string,
  portNumber?: number,
  waitForTermination: () => Promise<void> = untilTerminated,
): Promise<void> => {
  const absoluteRoot = resolve(process.cwd(), root)
  const server = await createServer(
    createSiteConfig(absoluteRoot, {
      server: { host: hostname, port: portNumber },
    }),
  )

  try {
    await server.listen()
    if (!terminal.quiet && !terminal.jsonMode) server.printUrls()
    terminal.json({
      command: 'serve',
      root: absoluteRoot,
      urls: server.resolvedUrls,
    })
    await waitForTermination()
  } finally {
    await server.close()
  }
}

export default defineCommand({
  name: 'serve',
  description: 'Serve a Liquid site with Vite.',
  arguments: [siteRoot],
  options: [host, port],
  run: ({ root, host: hostname, port: portNumber }) =>
    effect(() => serve(root, hostname, portNumber)),
})
