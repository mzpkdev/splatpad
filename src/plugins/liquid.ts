import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Liquid } from "liquidjs"
import type { Plugin, ViteDevServer } from "vite"
import {
  discoverSiteRoutes,
  findSiteRoute,
  isTemplateFile,
  type SiteRoute,
} from "../core/site-routes"
import { registerComponentDialect } from "./components"

const htmlShell = "<!doctype html><html><head></head><body></body></html>"

interface LiquidPluginOptions {
  data?: string
  root: string
  routes: readonly SiteRoute[]
}

export const liquidPlugin = ({
  root,
  data = "data/site.json",
  routes: buildRoutes,
}: LiquidPluginOptions): Plugin => {
  const siteRoot = path.resolve(root)
  const dataFile = path.resolve(siteRoot, data)
  const contentRoots = [
    path.resolve(siteRoot, "pages"),
    path.resolve(siteRoot, "layouts"),
    path.resolve(siteRoot, "partials"),
    path.resolve(siteRoot, "components"),
  ]
  const liquidOptions = {
    root: path.resolve(siteRoot, "pages"),
    layouts: path.resolve(siteRoot, "layouts"),
    partials: path.resolve(siteRoot, "partials"),
    extname: ".liquid",
    cache: false,
    strictFilters: true,
    strictVariables: true,
  }
  const engine = new Liquid(liquidOptions)
  const componentEngine = new Liquid({
    ...liquidOptions,
    root: path.resolve(siteRoot, "components"),
  })
  registerComponentDialect(engine, componentEngine)
  let reloadTimer: ReturnType<typeof setTimeout> | undefined

  const render = async (
    requestPath: string,
    activeRoutes: readonly SiteRoute[],
  ): Promise<string> => {
    const siteRoute = findSiteRoute(activeRoutes, requestPath)
    if (siteRoute === undefined) {
      throw new Error(`Unknown site route "${requestPath}".`)
    }

    const siteData = JSON.parse(await fs.readFile(dataFile, "utf8")) as {
      pages?: Record<string, unknown>
    }
    const html = await engine.renderFile(siteRoute.template, {
      ...siteData,
      page: siteData.pages?.[siteRoute.route] ?? {},
      route: siteRoute.route,
    })

    if (html === undefined) {
      throw new Error(`Liquid page not found: ${siteRoute.templateName}`)
    }
    return html
  }

  const queueReload = (server: ViteDevServer): void => {
    clearTimeout(reloadTimer)
    reloadTimer = setTimeout(() => {
      server.hot.send({ type: "full-reload", path: "*" })
    }, 25)
  }

  const watchesFile = (file: string): boolean => {
    const absoluteFile = path.resolve(file)
    return (
      absoluteFile === dataFile ||
      contentRoots.some(
        (contentRoot) =>
          absoluteFile.startsWith(`${contentRoot}${path.sep}`) && isTemplateFile(absoluteFile),
      )
    )
  }

  return {
    name: "splatpad:liquid",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const handleRequest = async (): Promise<void> => {
          if (request.url === undefined || !["GET", "HEAD"].includes(request.method ?? "")) {
            next()
            return
          }

          const routes = discoverSiteRoutes(siteRoot)
          const requestUrl = new URL(request.url, "http://localhost")
          const canonicalRoute = findSiteRoute(routes, requestUrl.pathname)

          if (canonicalRoute === undefined) {
            const acceptsHtml =
              request.headers["sec-fetch-dest"] === "document" ||
              request.headers.accept?.includes("text/html") === true

            if (!acceptsHtml) {
              next()
              return
            }

            response.statusCode = 404
            response.setHeader("Content-Type", "text/plain; charset=utf-8")
            response.end("Not Found")
            return
          }

          if (requestUrl.pathname !== canonicalRoute.route) {
            response.writeHead(308, { Location: `${canonicalRoute.route}${requestUrl.search}` })
            response.end()
            return
          }

          const rendered = await render(canonicalRoute.route, routes)
          const html = await server.transformIndexHtml(canonicalRoute.route, rendered, request.url)
          response.statusCode = 200
          response.setHeader("Cache-Control", "no-cache")
          response.setHeader("Content-Type", "text/html; charset=utf-8")
          response.end(request.method === "HEAD" ? "" : html)
        }

        void handleRequest().catch(next)
      })
    },
    hotUpdate({ file, server }) {
      if (watchesFile(file)) {
        queueReload(server)
        return []
      }
    },
    resolveId(id) {
      return buildRoutes.some((route) => route.entry === id) ? id : null
    },
    load(id) {
      return buildRoutes.some((route) => route.entry === id) ? htmlShell : null
    },
    transformIndexHtml: {
      order: "pre",
      async handler(html, context) {
        if (context.server !== undefined) {
          return html
        }
        return render(context.path, buildRoutes)
      },
    },
  }
}
