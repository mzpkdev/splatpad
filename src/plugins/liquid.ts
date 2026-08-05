import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { Liquid } from 'liquidjs'
import type { Plugin } from 'vite'

interface LiquidPluginOptions {
  root: string
  page?: string
  data?: string
}

export function liquidPlugin({
  root,
  page = 'index',
  data = 'data/site.json',
}: LiquidPluginOptions): Plugin {
  const siteRoot = resolve(root)
  const dataFile = resolve(siteRoot, data)
  const dataRoot = dirname(dataFile)
  const engine = new Liquid({
    root: resolve(siteRoot, 'pages'),
    layouts: resolve(siteRoot, 'layouts'),
    partials: resolve(siteRoot, 'partials'),
    extname: '.liquid',
    cache: false,
    strictFilters: true,
    strictVariables: true,
  })

  const render = async (): Promise<string> => {
    const context = JSON.parse(await readFile(dataFile, 'utf8')) as object
    const html = await engine.renderFile(page, context)

    if (html === undefined) {
      throw new Error(`Liquid page not found: ${page}`)
    }

    return html
  }

  return {
    name: 'splatpad:liquid',
    enforce: 'pre',
    transformIndexHtml: {
      order: 'pre',
      handler: render,
    },
    handleHotUpdate({ file, server }) {
      const sitePath = relative(siteRoot, file)
      const dataPath = relative(dataRoot, file)
      const isOutsideRoot = (path: string): boolean =>
        path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path)
      const isSiteFile =
        sitePath !== '' && !isOutsideRoot(sitePath)
      const isDataFile =
        dataPath !== '' && !isOutsideRoot(dataPath)

      if (
        !isSiteFile ||
        (!file.endsWith('.liquid') && !(isDataFile && file.endsWith('.json')))
      ) {
        return
      }

      server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}
