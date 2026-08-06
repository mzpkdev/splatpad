import { presetWind4 } from "@unocss/preset-wind4"
import { terminal } from "cmdore"
import UnoCSS from "unocss/vite"
import type { InlineConfig, ServerOptions } from "vite"
import { liquidPlugin } from "../plugins/liquid"
import { discoverSiteRoutes } from "./site-routes"

interface SiteConfigOptions {
  outDir?: string
  server?: ServerOptions
}

export const createSiteConfig = (
  root: string,
  { outDir, server }: SiteConfigOptions = {},
): InlineConfig => {
  const routes = discoverSiteRoutes(root)
  const input = Object.fromEntries(routes.map((route) => [route.inputName, route.entry]))

  return {
    root,
    appType: "mpa",
    configFile: false,
    logLevel: terminal.quiet || terminal.jsonMode ? "silent" : "info",
    plugins: [
      liquidPlugin({ root, routes }),
      UnoCSS({
        configFile: false,
        inspector: false,
        presets: [presetWind4()],
      }),
    ],
    build:
      outDir === undefined ? undefined : { outDir, emptyOutDir: true, rollupOptions: { input } },
    server,
  }
}
