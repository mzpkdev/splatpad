import * as fs from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import * as url from "node:url"
import type { Plugin } from "vite"
import { discoverComponentPreviews } from "../core/component-previews"
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
.page-frame__header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.page-frame__header span {
  margin-left: auto;
  color: #71717a;
  font-size: 9px;
  font-weight: 500;
  letter-spacing: .04em;
  text-transform: uppercase;
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

const designThemeStyles = `
:root {
  color: #e4e4e7;
  background: #111113;
}
button, select { font: inherit; }
.designer-routes,
.designer-inspector {
  scrollbar-color: #52525b transparent;
  scrollbar-width: thin;
}
.designer-routes::-webkit-scrollbar,
.designer-inspector::-webkit-scrollbar { width: 6px; height: 6px; }
.designer-routes::-webkit-scrollbar-track,
.designer-inspector::-webkit-scrollbar-track { background: transparent; }
.designer-routes::-webkit-scrollbar-thumb,
.designer-inspector::-webkit-scrollbar-thumb {
  border: 1px solid transparent;
  border-radius: 999px;
  background: #52525b;
  background-clip: padding-box;
}
.designer-routes::-webkit-scrollbar-thumb:hover,
.designer-inspector::-webkit-scrollbar-thumb:hover { background: #7c3aed; }
.designer-routes::-webkit-scrollbar-corner,
.designer-inspector::-webkit-scrollbar-corner { background: transparent; }
.designer {
  display: flex;
  position: relative;
  flex-direction: column;
  background: #111113;
  color: #e4e4e7;
  font-size: 11px;
}
.designer-state { background: #111113; color: #a1a1aa; }
.designer-state--error { color: #fca5a5; }
.designer-header {
  display: flex;
  z-index: 20;
  min-height: 48px;
  flex: 0 0 48px;
  align-items: center;
  border-bottom: 1px solid #3f3f46;
  background: #18181b;
  box-shadow: 0 1px 8px rgb(0 0 0 / 35%);
}
.designer-header__brand {
  display: grid;
  width: 48px;
  height: 48px;
  flex: 0 0 48px;
  place-items: center;
  background: #7c3aed;
  color: #fff;
}
.designer-header__mark { width: 22px; height: 22px; }
.designer-header__location {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
}
.designer-header__location strong {
  overflow: hidden;
  color: #d4d4d8;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.designer-header__location code {
  padding: 2px 7px;
  border-radius: 4px;
  background: rgb(139 92 246 / 15%);
  color: #c4b5fd;
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  font-size: 10px;
}
.designer-workspace {
  display: grid;
  position: relative;
  min-height: 0;
  flex: 1 1 auto;
  grid-template-columns: 232px minmax(0, 1fr) 280px;
}
.designer-routes {
  min-width: 0;
  overflow-x: hidden;
  overflow-y: auto;
  border-right: 1px solid #3f3f46;
  background: #1c1c1f;
}
.designer-routes .designer-routes__views {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  padding: 8px;
  border-bottom: 1px solid #3f3f46;
}
.designer-routes__views button {
  justify-content: center;
  padding: 0 7px;
  border: 1px solid transparent;
  background: #18181b;
}
.designer-routes__views button[aria-pressed="true"] {
  border-color: #7c3aed;
  background: rgb(124 58 237 / 18%);
  color: #ddd6fe;
}
.designer-routes__views button strong {
  min-width: 15px;
  margin-left: auto;
  color: #71717a;
  font-size: 9px;
  text-align: right;
}
.designer-routes__views button[aria-pressed="true"] strong { color: #c4b5fd; }
.designer-routes__section > header {
  display: flex;
  height: 40px;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  border-bottom: 1px solid #3f3f46;
}
.designer-routes h2 { margin: 0; color: #f4f4f5; font-size: 11px; }
.designer-routes__section > header span {
  min-width: 18px;
  padding: 2px 5px;
  border-radius: 9px;
  background: #27272a;
  color: #a1a1aa;
  text-align: center;
}
.designer-routes__section + .designer-routes__section { border-top: 1px solid #3f3f46; }
.designer-routes nav { display: grid; min-width: 0; gap: 2px; padding: 10px 8px; }
.designer-routes button {
  display: flex;
  width: 100%;
  min-width: 0;
  height: 30px;
  align-items: center;
  gap: 7px;
  padding-right: 9px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #d4d4d8;
  cursor: pointer;
  text-align: left;
}
.designer-routes button:hover { background: #27272a; }
.designer-routes button[aria-current="page"] {
  background: rgb(139 92 246 / 15%);
  color: #ddd6fe;
}
.designer-routes button[aria-selected="true"] {
  background: rgb(139 92 246 / 15%);
  color: #ddd6fe;
}
.designer-routes button:focus-visible {
  outline: 2px solid #8b5cf6;
  outline-offset: -2px;
}
.designer-routes button svg { width: 14px; height: 14px; flex: 0 0 14px; color: #71717a; }
.designer-routes button[aria-current="page"] svg { color: #a78bfa; }
.designer-routes button[aria-selected="true"] svg { color: #a78bfa; }
.designer-outline button[data-outline-kind="svg"] svg { color: #38bdf8; }
.designer-outline button[data-outline-kind="text"] svg { color: #a1a1aa; }
.designer-outline button[data-outline-kind="component"] svg { color: #a78bfa; }
.designer-outline [role="tree"] { display: grid; min-width: 0; gap: 2px; }
.designer-routes button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.designer-routes__empty { margin: 2px 4px; color: #71717a; line-height: 1.5; }
.designer-canvas { position: relative; min-width: 0; min-height: 0; overflow: hidden; background: #111113; }
.designer-canvas .react-flow { position: absolute; inset: 0; }
.designer-canvas--components { background: #111113; }
.designer-canvas__background-sampler {
  position: absolute;
  width: 1px;
  height: 1px;
  border: 0;
  opacity: 0;
  pointer-events: none;
}
.react-flow__pane { cursor: grab; }
.react-flow__pane.dragging { cursor: grabbing; }
.react-flow__node-page { border-radius: 3px; }
.page-frame {
  border-color: #52525b;
  background: #fff;
  box-shadow: 0 12px 36px rgb(0 0 0 / 50%);
}
.page-frame--active { outline: 2px solid #7c3aed; outline-offset: 2px; }
.page-frame__header {
  border-color: #3f3f46;
  background: #242428;
  color: #c4b5fd;
  font-size: 12px;
}
.react-flow__node-catalogGroup {
  border: 0;
  background: transparent;
  pointer-events: none;
}
.react-flow__node-catalogSurface {
  border: 0;
  background: transparent;
  pointer-events: none;
}
.component-catalog-surface {
  border: 1px solid rgb(15 23 42 / 10%);
  border-radius: 12px;
  background-color: var(--component-canvas, #fff);
  background-image: radial-gradient(rgb(100 116 139 / 20%) 1px, transparent 1px);
  background-position: 0 0;
  background-size: 24px 24px;
  box-shadow: 0 20px 60px rgb(0 0 0 / 28%);
}
.component-group {
  display: flex;
  height: 32px;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  color: #334155;
}
.component-group > div { display: flex; align-items: baseline; gap: 8px; }
.component-group strong { font-size: 13px; }
.component-group span, .component-group code { color: #64748b; font-size: 10px; }
.page-frame--component {
  overflow: hidden;
  border: 1px dashed rgb(100 116 139 / 48%);
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.page-frame--component.page-frame--active {
  outline: 1px dashed #8b5cf6;
  outline-offset: 3px;
}
.page-frame--component .page-frame__header {
  border-bottom: 0;
  background: transparent;
  color: #334155;
}
.page-frame--component .page-frame__header span { color: #64748b; }
.page-frame--component .page-frame__preview { background: transparent; }
.designer-canvas--dark .component-group { color: #f4f4f5; }
.designer-canvas--dark .component-catalog-surface {
  border-color: rgb(244 244 245 / 12%);
  background-image: radial-gradient(rgb(161 161 170 / 28%) 1px, transparent 1px);
}
.designer-canvas--dark .component-group span,
.designer-canvas--dark .component-group code { color: #a1a1aa; }
.designer-canvas--dark .page-frame--component { border-color: rgb(212 212 216 / 40%); }
.designer-canvas--dark .page-frame--component .page-frame__header {
  color: #f4f4f5;
}
.designer-canvas--dark .page-frame--component .page-frame__header span { color: #a1a1aa; }
.designer-toolbar {
  bottom: 16px;
  gap: 2px;
  padding: 3px;
  border-color: #52525b;
  border-radius: 9px;
  background: rgb(36 36 40 / 96%);
  box-shadow: 0 8px 24px rgb(0 0 0 / 45%);
}
.designer-toolbar__button {
  display: flex;
  width: auto;
  height: 34px;
  gap: 6px;
  padding: 0 12px;
  border-radius: 6px;
  color: #d4d4d8;
  font-size: 10px;
  font-weight: 600;
}
.designer-toolbar__button:hover { background: #3f3f46; }
.designer-toolbar__button[aria-pressed="true"] { background: #7c3aed; color: #fff; }
.designer-toolbar__button:focus-visible { outline-color: #ddd6fe; outline-offset: -2px; }
.designer-toolbar__button svg { width: 15px; height: 15px; }
.designer-properties {
  position: relative;
  min-width: 0;
  overflow: hidden;
  border-left: 1px solid #3f3f46;
  background: #1c1c1f;
}
.designer-properties__empty {
  margin: 16px;
  padding: 14px;
  border: 1px dashed #52525b;
  border-radius: 8px;
  background: rgb(24 24 27 / 55%);
}
.designer-properties__empty h2 { margin: 0; color: #f4f4f5; font-size: 12px; }
.designer-properties__empty p { margin: 8px 0 0; color: #71717a; font-size: 10px; line-height: 1.5; }
.designer-inspector {
  top: 0;
  right: 0;
  bottom: 0;
  width: 100%;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
  color: #d4d4d8;
}
.designer-inspector__header {
  padding: 12px;
  border-color: #3f3f46;
  background: rgb(28 28 31 / 96%);
  backdrop-filter: blur(8px);
}
.designer-inspector__title-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.designer-inspector__header h2 { color: #f4f4f5; font-size: 12px; }
.designer-inspector__title-row code {
  overflow: hidden;
  color: #8b5cf6;
  font-size: 9px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.designer-inspector__element { display: grid; gap: 2px; margin-top: 9px; }
.designer-inspector__element strong { color: #e4e4e7; font-size: 11px; }
.designer-inspector__element span { color: #71717a; font-size: 9px; }
.designer-inspector__component {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-bottom: 1px solid #3f3f46;
  background: rgb(139 92 246 / 8%);
}
.designer-inspector__component > div { display: grid; min-width: 0; gap: 2px; }
.designer-inspector__component > div span {
  color: #a1a1aa;
  font-size: 9px;
  text-transform: uppercase;
}
.designer-inspector__component strong {
  overflow: hidden;
  color: #ddd6fe;
  font: 10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.designer-inspector__component button {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border: 1px solid #7c3aed;
  border-radius: 5px;
  background: rgb(124 58 237 / 16%);
  color: #ddd6fe;
  cursor: pointer;
  font-size: 9px;
}
.designer-inspector__component button:hover { background: rgb(124 58 237 / 28%); }
.designer-inspector__component button:focus-visible { outline: 2px solid #a78bfa; }
.designer-inspector__component button svg { width: 12px; height: 12px; }
.designer-inspector__message { color: #a1a1aa; }
.designer-inspector__message--error { color: #fca5a5; }
.designer-inspector__message--error p { margin: 0; }
.designer-inspector__message--error button {
  margin-top: 10px;
  padding: 5px 9px;
  border: 1px solid #7c3aed;
  border-radius: 5px;
  background: rgb(124 58 237 / 18%);
  color: #ddd6fe;
  cursor: pointer;
}
.designer-inspector__message--error button:hover { background: rgb(124 58 237 / 30%); }
.designer-inspector__message--error button:focus-visible { outline: 2px solid #a78bfa; }
.designer-inspector__section { border-color: #3f3f46; }
.designer-inspector__section > h3 {
  padding: 13px 12px 8px;
  color: #a1a1aa;
  font-size: 10px;
}
.designer-inspector__spacing { gap: 0; padding: 0 12px 12px; }
.designer-inspector__section > .designer-inspector__spacing:first-child,
.designer-inspector__section > .designer-inspector__utilities:first-child { padding-top: 12px; }
.designer-inspector__spacing-card {
  padding: 0;
  border: 0;
  border-radius: 0;
  background: transparent;
}
.designer-inspector__spacing-card + .designer-inspector__spacing-card {
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid #3f3f46;
}
.designer-inspector__spacing-heading h4 { margin-bottom: 7px; color: #d4d4d8; font-size: 10px; }
.designer-inspector__spacing-values { gap: 0; margin-top: 0; }
.designer-inspector__spacing-values > div {
  padding: 6px 3px;
  border-left: 1px solid #3f3f46;
  background: transparent;
}
.designer-inspector__spacing-values > div:first-child { border-left: 0; }
.designer-inspector__semantic-values { gap: 0; margin-top: 0; }
.designer-inspector__semantic-values > div,
.designer-inspector__semantic-values > div:nth-child(odd) {
  padding: 7px 0;
  border-top: 1px solid #2f2f33;
  background: transparent;
}
.designer-inspector__semantic-values > div:first-child { border-top: 0; }
.designer-inspector__spacing-values dt,
.designer-inspector__semantic-values dt,
.designer-inspector__target span,
.designer-inspector__declarations dt { color: #71717a; }
.designer-inspector__spacing-values dd,
.designer-inspector__semantic-values dd,
.designer-inspector code { color: #e4e4e7; }
.designer-inspector__utilities { padding: 0 12px 12px; }
.designer-inspector__utility {
  margin: 0;
  padding: 8px 0;
  border-top: 1px solid #2f2f33;
  border-radius: 0;
  background: transparent;
}
.designer-inspector__utility:first-child { border-top: 0; }
.designer-inspector__utility--unknown {
  padding-right: 7px;
  padding-left: 7px;
  border: 1px dashed #92400e;
  border-radius: 5px;
  background: rgb(120 53 15 / 8%);
}
.designer-inspector__unknown { color: #fbbf24; }
.designer-inspector__conditions code { background: rgb(124 58 237 / 20%); color: #ddd6fe; }
.designer-inspector__rule { border-color: #3f3f46; }
.designer-inspector__color-swatch { border-color: rgb(255 255 255 / 28%); }
.designer-viewport-control {
  position: static;
  display: flex;
  margin-left: auto;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  border: 0;
  border-radius: 0;
  background: transparent;
  box-shadow: none;
}
.designer-viewport-control span { color: #71717a; }
.designer-viewport-control select {
  width: 178px;
  height: 28px;
  padding: 0 28px 0 9px;
  border-color: #52525b;
  background: #27272a;
  color: #e4e4e7;
}
.designer-viewport-control select:focus-visible { outline: 2px solid #8b5cf6; outline-offset: 1px; }
.react-flow__controls {
  margin: 0 12px 12px 0;
  border-color: #52525b;
  background: #242428;
  box-shadow: 0 4px 14px rgb(0 0 0 / 32%);
}
.react-flow__controls-button {
  border-color: #3f3f46;
  background: #242428;
  color: #d4d4d8;
}
.react-flow__controls-button:hover { background: #3f3f46; }
.react-flow__controls-button svg { fill: currentColor; }
.react-flow__attribution { display: none; }
.designer-footer {
  display: flex;
  min-height: 24px;
  flex: 0 0 24px;
  align-items: center;
  gap: 12px;
  padding: 0 12px;
  border-top: 1px solid #3f3f46;
  background: #18181b;
  color: #71717a;
  font-size: 9px;
}
.designer-footer__status { display: flex; align-items: center; gap: 6px; color: #a1a1aa; }
.designer-footer__status i { width: 6px; height: 6px; border-radius: 50%; background: #22c55e; }
.designer-footer code { color: #a1a1aa; font-size: 9px; }
.designer-footer__viewport { margin-left: auto; }
@media (max-width: 1180px) {
  .designer-workspace { grid-template-columns: 190px minmax(0, 1fr) 240px; }
}
@media (max-width: 820px) {
  .designer-workspace { grid-template-columns: min(42vw, 180px) minmax(0, 1fr); }
  .designer-canvas { width: auto; height: 100%; }
  .designer-properties {
    position: absolute;
    z-index: 9;
    top: 0;
    right: 0;
    bottom: 0;
    width: min(280px, calc(100% - 32px));
    border-left: 0;
    background: transparent;
    pointer-events: none;
  }
  .designer-properties > * { pointer-events: auto; }
  .designer-properties__empty { display: none; }
  .designer-inspector { border-left: 1px solid #3f3f46; background: #1c1c1f; }
  .designer-header__location strong { max-width: 120px; }
  .designer-viewport-control span { display: none; }
  .designer-viewport-control select { width: 140px; }
}
@media (max-width: 520px) {
  .designer-header__location strong { display: none; }
  .designer-header__location { padding-right: 0; }
  .designer-footer > span:not(.designer-footer__status):not(.designer-footer__viewport) { display: none; }
}`

const designHtml = (): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Splatpad Design</title>
    <link rel="stylesheet" href="${designStylesheetPath}">
    <style>${designStyles}${designThemeStyles}</style>
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
          const components = discoverComponentPreviews(root).map(({ name, preview, route }) => ({
            name,
            preview: preview === undefined ? "automatic" : "authored",
            route,
          }))
          response.statusCode = 200
          response.setHeader("Cache-Control", "no-cache")
          response.setHeader("Content-Type", "application/json; charset=utf-8")
          response.end(
            request.method === "HEAD"
              ? ""
              : JSON.stringify({ components, routes, siteName: path.basename(root) }),
          )
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
