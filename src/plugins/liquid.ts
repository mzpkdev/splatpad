import * as fs from "node:fs/promises"
import * as path from "node:path"
import { Liquid, UndefinedVariableError } from "liquidjs"
import type { Plugin, ViteDevServer } from "vite"
import {
  componentPreviewRootPath,
  discoverComponentPreviews,
  findComponentPreview,
  type ComponentPreview,
} from "../core/component-previews"
import {
  discoverSiteRoutes,
  findSiteRoute,
  isTemplateFile,
  type SiteRoute,
} from "../core/site-routes"
import { registerComponentDialect } from "./components"

const htmlShell = "<!doctype html><html><head></head><body></body></html>"

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

const componentPreviewDocument = (
  preview: ComponentPreview,
  body: string,
): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${escapeHtml(preview.name)} component</title>
    <link rel="stylesheet" href="/__uno.css">
    <style>
      html { min-height: 100%; background: #fff; }
      body { min-height: 100%; margin: 0; padding: 32px; box-sizing: border-box; }
      .splatpad-component-preview-error {
        max-width: 640px; margin: 0; padding: 20px; border: 1px dashed #d97706;
        border-radius: 8px; background: #fffbeb; color: #78350f;
        font: 14px/1.5 ui-sans-serif, system-ui, sans-serif;
      }
      .splatpad-component-preview-error h1 { margin: 0 0 8px; font-size: 16px; }
      .splatpad-component-preview-error p { margin: 8px 0 0; }
      .splatpad-component-preview-error code { font-family: ui-monospace, monospace; }
    </style>
  </head>
  <body data-splatpad-component="${escapeHtml(preview.name)}">${body}</body>
</html>`

const missingComponentPreview = (preview: ComponentPreview, reason: unknown): string => {
  const designFile = `${preview.name}.design.liquid`
  const message = reason instanceof Error ? reason.message : String(reason)
  return `<main class="splatpad-component-preview-error">
    <h1>${escapeHtml(preview.name)} needs preview data</h1>
    <p>Add <code>components/${escapeHtml(designFile)}</code> with the props and slots this component needs.</p>
    <p><code>${escapeHtml(message)}</code></p>
  </main>`
}

interface LiquidPluginOptions {
  data?: string
  design?: boolean
  root: string
  routes: readonly SiteRoute[]
}

export const liquidPlugin = ({
  root,
  data = "data/site.json",
  design = false,
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

  const readSiteData = async (): Promise<{
    pages?: Record<string, unknown>
    [key: string]: unknown
  }> => JSON.parse(await fs.readFile(dataFile, "utf8")) as { pages?: Record<string, unknown> }

  const render = async (
    requestPath: string,
    activeRoutes: readonly SiteRoute[],
  ): Promise<string> => {
    const siteRoute = findSiteRoute(activeRoutes, requestPath)
    if (siteRoute === undefined) {
      throw new Error(`Unknown site route "${requestPath}".`)
    }

    const siteData = await readSiteData()
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

  const renderComponentPreview = async (preview: ComponentPreview): Promise<string> => {
    const siteData = await readSiteData()
    const source =
      preview.preview === undefined
        ? `{% component ${JSON.stringify(preview.name)} %}{% endcomponent %}`
        : await fs.readFile(preview.preview, "utf8")

    try {
      const body = await engine.parseAndRender(source, {
        ...siteData,
        component: { name: preview.name },
        route: preview.route,
      })
      return componentPreviewDocument(preview, body)
    } catch (error) {
      if (preview.preview !== undefined || !(error instanceof UndefinedVariableError)) {
        throw error
      }
      return componentPreviewDocument(preview, missingComponentPreview(preview, error))
    }
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
          const componentPreview =
            design && requestUrl.pathname.startsWith(componentPreviewRootPath)
              ? findComponentPreview(discoverComponentPreviews(siteRoot), requestUrl.pathname)
              : undefined
          if (componentPreview !== undefined) {
            if (requestUrl.pathname !== componentPreview.route) {
              response.writeHead(308, {
                Location: `${componentPreview.route}${requestUrl.search}`,
              })
              response.end()
              return
            }

            const rendered = await renderComponentPreview(componentPreview)
            const html = await server.transformIndexHtml(
              componentPreview.route,
              rendered,
              request.url,
            )
            response.statusCode = 200
            response.setHeader("Cache-Control", "no-cache")
            response.setHeader("Content-Type", "text/html; charset=utf-8")
            response.end(request.method === "HEAD" ? "" : html)
            return
          }
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
