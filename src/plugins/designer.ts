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
.designer { position: relative; }
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
  position: relative;
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
  border: 0;
  background: #fff;
  pointer-events: none;
}
.page-frame__interaction-surface {
  position: absolute;
  z-index: 1;
  top: 44px;
  left: 0;
  width: 1440px;
  background: transparent;
  cursor: crosshair;
  pointer-events: none;
  touch-action: none;
  user-select: none;
}
.page-frame--interactive .page-frame__interaction-surface { pointer-events: auto; }
.designer-toolbar {
  position: absolute;
  z-index: 10;
  bottom: 24px;
  left: 50%;
  display: flex;
  gap: 4px;
  padding: 4px;
  transform: translateX(-50%);
  border: 1px solid #c7c7c7;
  border-radius: 9px;
  background: rgb(255 255 255 / 96%);
  box-shadow: 0 4px 16px rgb(0 0 0 / 16%);
}
.designer-toolbar__button {
  display: grid;
  width: 38px;
  height: 38px;
  padding: 0;
  place-items: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #4b5563;
  cursor: pointer;
}
.designer-toolbar__button:hover { background: #f3f4f6; }
.designer-toolbar__button[aria-pressed="true"] {
  background: #111827;
  color: #fff;
}
.designer-toolbar__button:focus-visible {
  outline: 2px solid #2563eb;
  outline-offset: 2px;
}
.designer-toolbar__button svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-linecap: round;
  stroke-linejoin: round;
  stroke-width: 1.8;
}
.designer-inspector {
  position: absolute;
  z-index: 9;
  top: 16px;
  right: 16px;
  bottom: 16px;
  width: min(320px, calc(100% - 32px));
  padding: 0;
  overflow: auto;
  overflow-wrap: anywhere;
  border: 1px solid #c7c7c7;
  border-radius: 9px;
  background: rgb(255 255 255 / 96%);
  box-shadow: 0 4px 16px rgb(0 0 0 / 16%);
}
.designer-inspector__header {
  position: sticky;
  z-index: 1;
  top: 0;
  padding: 16px;
  border-bottom: 1px solid #e5e7eb;
  background: rgb(255 255 255 / 96%);
}
.designer-inspector__header h2 { margin: 0; color: #111827; font-size: 14px; }
.designer-inspector__message { margin: 0; padding: 20px 16px; color: #6b7280; font-size: 12px; }
.designer-inspector__message--error { color: #b42318; }
.designer-inspector__section { border-bottom: 1px solid #e5e7eb; }
.designer-inspector__section > h3 {
  margin: 0;
  padding: 13px 16px 8px;
  color: #374151;
  font-size: 11px;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.designer-inspector__spacing { display: grid; gap: 8px; padding: 0 10px 10px; }
.designer-inspector__spacing-card {
  padding: 10px;
  border: 1px solid #e5e7eb;
  border-radius: 7px;
  background: #fff;
}
.designer-inspector__spacing-heading h4 { margin: 0; color: #111827; font-size: 12px; }
.designer-viewport-control {
  position: absolute;
  z-index: 10;
  top: 16px;
  left: 16px;
  display: grid;
  gap: 3px;
  padding: 8px 10px;
  border: 1px solid #c7c7c7;
  border-radius: 7px;
  background: rgb(255 255 255 / 96%);
  box-shadow: 0 3px 12px rgb(0 0 0 / 12%);
}
.designer-viewport-control span {
  color: #6b7280;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.designer-viewport-control select {
  width: 218px;
  padding: 4px 22px 4px 6px;
  border: 1px solid #d1d5db;
  border-radius: 5px;
  background: #f9fafb;
  color: #374151;
  font-size: 10px;
}
.designer-inspector__spacing-values {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 6px;
  margin: 10px 0 0;
}
.designer-inspector__spacing-values > div { min-width: 0; padding: 6px 4px; background: #f9fafb; text-align: center; }
.designer-inspector__spacing-values dt { color: #6b7280; font-size: 9px; }
.designer-inspector__spacing-values dd {
  margin: 3px 0 0;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.designer-inspector__semantic-values { display: grid; gap: 1px; margin: 8px 0 0; }
.designer-inspector__semantic-values > div {
  display: grid;
  grid-template-columns: minmax(78px, .8fr) minmax(0, 1.2fr);
  gap: 8px;
  padding: 5px 6px;
}
.designer-inspector__semantic-values > div:nth-child(odd) { background: #f9fafb; }
.designer-inspector__semantic-values dt { color: #6b7280; font-size: 10px; }
.designer-inspector__semantic-values dd {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  margin: 0;
  overflow: hidden;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.designer-inspector__color-swatch {
  display: inline-block;
  flex: 0 0 12px;
  width: 12px;
  height: 12px;
  border: 1px solid rgb(17 24 39 / 20%);
  border-radius: 2px;
  background-image:
    linear-gradient(45deg, rgb(107 114 128 / 28%) 25%, transparent 25%),
    linear-gradient(-45deg, rgb(107 114 128 / 28%) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, rgb(107 114 128 / 28%) 75%),
    linear-gradient(-45deg, transparent 75%, rgb(107 114 128 / 28%) 75%);
  background-position: 0 0, 0 3px, 3px -3px, -3px 0;
  background-size: 6px 6px;
}
.designer-inspector__semantic-value { overflow: hidden; text-overflow: ellipsis; }
.designer-inspector__utilities { padding: 0 10px 10px; }
.designer-inspector__utility { padding: 9px 7px; border-radius: 6px; }
.designer-inspector__utility--unknown { border: 1px dashed #d1d5db; }
.designer-inspector__utility-heading { display: flex; justify-content: space-between; gap: 8px; }
.designer-inspector code {
  color: #1f2937;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
.designer-inspector__token { overflow: hidden; font-size: 12px; font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
.designer-inspector__unknown { color: #9a3412; font-size: 10px; font-weight: 650; }
.designer-inspector__conditions { display: flex; flex-wrap: wrap; gap: 4px; padding-top: 6px; }
.designer-inspector__conditions code { padding: 2px 5px; border-radius: 4px; background: #ede9fe; color: #6d28d9; font-size: 10px; }
.designer-inspector__rule { margin-top: 7px; padding-top: 7px; border-top: 1px solid #f0f1f3; }
.designer-inspector__target { display: flex; min-width: 0; flex-direction: column; gap: 2px; }
.designer-inspector__target span { color: #6b7280; font-size: 9px; text-transform: uppercase; }
.designer-inspector__target code { overflow: hidden; font-size: 10px; text-overflow: ellipsis; white-space: nowrap; }
.designer-inspector__declarations { margin: 7px 0 0; }
.designer-inspector__declarations > div { display: grid; grid-template-columns: minmax(82px, .8fr) minmax(0, 1.2fr); gap: 8px; padding: 3px 0; font-size: 11px; }
.designer-inspector__declarations dt { overflow: hidden; color: #6b7280; text-overflow: ellipsis; white-space: nowrap; }
.designer-inspector__declarations dd { margin: 0; overflow: hidden; text-align: right; text-overflow: ellipsis; white-space: nowrap; }
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
