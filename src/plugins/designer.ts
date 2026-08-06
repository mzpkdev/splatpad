import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as url from "node:url"
import type { Plugin } from "vite"
import { discoverSiteRoutes } from "../core/site-routes"

export const designPath = "/__splatpad/design/"
export const designRoutesPath = `${designPath}routes`
export const designStylesheetPath = `${designPath}styles.css`
const designerModuleId = "virtual:splatpad-designer"
const resolvedDesignerModuleId = `\0${designerModuleId}`

interface DesignerPluginOptions {
  entry?: string
  root: string
  stylesheet?: string
}

const require = createRequire(import.meta.url)

const resolveDesignerEntry = (): string => {
  const sourceEntry = url.fileURLToPath(new URL("../designer/designer.tsx", import.meta.url))
  if (fs.existsSync(sourceEntry)) {
    return sourceEntry
  }

  const builtEntry = url.fileURLToPath(new URL("../designer/designer.mjs", import.meta.url))
  if (fs.existsSync(builtEntry)) {
    return builtEntry
  }

  throw new Error("Splatpad designer client entry could not be found.")
}

const resolveDesignerStylesheet = (): string => require.resolve("@xyflow/react/dist/style.css")

const designStyles = `
:root {
  color: #1f1f1f;
  background: #ececec;
  font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-synthesis: none;
}
* { box-sizing: border-box; }
html, body, #root, .designer {
  width: 100%;
  height: 100%;
  margin: 0;
  overflow: hidden;
}
.designer-state {
  display: grid;
  min-height: 100%;
  margin: 0;
  place-items: center;
  color: #666;
  font-size: 14px;
}
.designer-state--error { color: #b42318; }
.react-flow__node-page {
  border: 0;
  background: transparent;
}
.page-frame {
  width: 1440px;
  overflow: hidden;
  border: 1px solid #c7c7c7;
  border-radius: 3px;
  background: #fff;
  box-shadow: 0 3px 16px rgb(0 0 0 / 12%);
}
.page-frame__header {
  display: flex;
  height: 44px;
  align-items: center;
  padding: 0 16px;
  border-bottom: 1px solid #dedede;
  background: #f8f8f8;
  color: #333;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 14px;
  font-weight: 600;
}
.page-frame__preview {
  display: block;
  width: 1440px;
  border: 0;
  background: #fff;
  pointer-events: none;
}
.react-flow__controls {
  overflow: hidden;
  border: 1px solid #c7c7c7;
  border-radius: 6px;
  box-shadow: 0 2px 8px rgb(0 0 0 / 12%);
}
.react-flow__controls-button {
  border-color: #dedede;
  background: #fff;
}`

const designHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Splatpad Design</title>
    <link rel="stylesheet" href="${designStylesheetPath}">
    <style>${designStyles}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/@id/${designerModuleId}"></script>
  </body>
</html>`

export const designerPlugin = ({
  root,
  entry = resolveDesignerEntry(),
  stylesheet = resolveDesignerStylesheet(),
}: DesignerPluginOptions): Plugin => ({
  name: "splatpad:designer",
  enforce: "pre",
  resolveId(id) {
    return id === designerModuleId ? resolvedDesignerModuleId : null
  },
  load(id) {
    return id === resolvedDesignerModuleId ? `import ${JSON.stringify(entry)}` : null
  },
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const handleRequest = async (): Promise<void> => {
        if (request.url === undefined || !["GET", "HEAD"].includes(request.method ?? "")) {
          next()
          return
        }

        const requestUrl = new URL(request.url, "http://localhost")
        if (requestUrl.pathname === designPath.slice(0, -1)) {
          response.writeHead(308, { Location: designPath })
          response.end()
          return
        }
        if (requestUrl.pathname === designRoutesPath) {
          const routes = discoverSiteRoutes(root).map(({ route }) => ({ route }))
          response.statusCode = 200
          response.setHeader("Cache-Control", "no-cache")
          response.setHeader("Content-Type", "application/json; charset=utf-8")
          response.end(request.method === "HEAD" ? "" : JSON.stringify({ routes }))
          return
        }
        if (requestUrl.pathname === designStylesheetPath) {
          response.statusCode = 200
          response.setHeader("Cache-Control", "no-cache")
          response.setHeader("Content-Type", "text/css; charset=utf-8")
          response.end(request.method === "HEAD" ? "" : fs.readFileSync(stylesheet, "utf8"))
          return
        }
        if (requestUrl.pathname !== designPath) {
          next()
          return
        }

        response.statusCode = 200
        response.setHeader("Cache-Control", "no-cache")
        response.setHeader("Content-Type", "text/html; charset=utf-8")
        response.end(request.method === "HEAD" ? "" : designHtml())
      }

      void handleRequest().catch(next)
    })
  },
})
