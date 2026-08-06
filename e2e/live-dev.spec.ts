import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { expect, test } from "@playwright/test"
import { createServer, type ViteDevServer } from "vite"
import { createSiteConfig } from "../src/core/site-config"

let baseUrl: string
let server: ViteDevServer
let siteRoot: string

test.beforeAll(async () => {
  siteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "splatpad-browser-live-"))
  await fs.cp(path.resolve(process.cwd(), "example"), siteRoot, { recursive: true })
  server = await createServer(
    createSiteConfig(siteRoot, {
      design: true,
      server: { host: "127.0.0.1", port: 0 },
    }),
  )
  await server.listen()

  const address = server.httpServer?.address()
  if (address === null || typeof address === "string" || address === undefined) {
    throw new Error("Expected the dev server to listen on a TCP port")
  }
  baseUrl = `http://127.0.0.1:${address.port}`
})

test.afterAll(async () => {
  await server.close()
  await fs.rm(siteRoot, { recursive: true })
})

test("reloads new utilities, shows template errors, and recovers", async ({ page }) => {
  const template = path.join(siteRoot, "pages", "index.liquid")
  await page.goto(baseUrl)

  await fs.writeFile(
    template,
    `{% layout 'base' %}{% block content %}<main class="bg-fuchsia-700">Utility arrived</main>{% endblock %}`,
  )
  const utility = page.getByText("Utility arrived")
  await expect(utility).toBeVisible()
  await expect(utility).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)")

  await fs.writeFile(template, `{% layout 'base' %}{% block content %}{% if %}{% endblock %}`)
  await expect(page.locator("vite-error-overlay")).toBeVisible()

  await fs.writeFile(
    template,
    `{% layout 'base' %}{% block content %}<main>Recovered automatically</main>{% endblock %}`,
  )
  await expect(page.getByText("Recovered automatically")).toBeVisible()
})

test("renders every route and reloads the board when routes change", async ({ page }) => {
  const browserProblems: string[] = []
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      browserProblems.push(message.text())
    }
  })
  page.on("pageerror", (error) => browserProblems.push(error.message))

  await page.goto(`${baseUrl}/__splatpad/design/`)

  await expect(page.locator(".page-frame")).toHaveCount(7)
  await expect(page.locator('.page-frame[data-route="/journal/"]')).toBeVisible()
  await expect(page.locator('.page-frame[data-route="/journal/seasonal-jam/"]')).toBeVisible()
  await expect(page.locator(".page-frame__preview")).toHaveCount(7)

  const newRoute = path.join(siteRoot, "pages", "journal", "archive", "index.liquid")
  await fs.mkdir(path.dirname(newRoute), { recursive: true })
  await fs.writeFile(newRoute, "<main>Archive</main>")

  await expect(page.locator('.page-frame[data-route="/journal/archive/"]')).toBeVisible()

  await fs.rm(path.dirname(newRoute), { recursive: true })
  await expect(page.locator('.page-frame[data-route="/journal/archive/"]')).toHaveCount(0)
  expect(browserProblems.join("\n")).not.toContain("React Flow")
  expect(browserProblems.join("\n")).not.toContain("ResizeObserver")
})
