import { presetWind4 } from "@unocss/preset-wind4"
import { terminal } from "cmdore"
import UnoCSS from "unocss/vite"
import type { InlineConfig, ServerOptions } from "vite"
import { liquidPlugin } from "../plugins/liquid"

interface SiteConfigOptions {
  outDir?: string
  server?: ServerOptions
}

export const createSiteConfig = (
  root: string,
  { outDir, server }: SiteConfigOptions = {},
): InlineConfig => ({
  root,
  configFile: false,
  logLevel: terminal.quiet || terminal.jsonMode ? "silent" : "info",
  plugins: [
    liquidPlugin({ root }),
    UnoCSS({
      configFile: false,
      inspector: false,
      presets: [presetWind4()],
    }),
  ],
  build: outDir === undefined ? undefined : { outDir, emptyOutDir: true },
  server,
})
