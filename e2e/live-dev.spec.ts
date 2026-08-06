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

test("pans by default and inspects iframe elements without activating them", async ({ page }) => {
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await expect(page.locator(".page-frame")).toHaveCount(7)

  const panTool = page.getByRole("button", { name: "Pan tool (V)" })
  const inspectTool = page.getByRole("button", { name: "Inspect tool (I)" })
  const preview = page.locator('.page-frame[data-route="/menu/"] .page-frame__preview')
  const site = page.frameLocator('iframe[title="/menu/"]')
  const heading = site.getByRole("heading", { level: 1 })
  const inspector = page.getByRole("complementary", { name: "Element inspector" })

  await expect(panTool).toHaveAttribute("aria-pressed", "true")
  await expect(preview).toHaveCSS("pointer-events", "none")
  await expect(inspector).toHaveCount(0)

  await page.keyboard.press("i")
  await expect(inspectTool).toHaveAttribute("aria-pressed", "true")
  await expect(preview).toHaveCSS("pointer-events", "auto")
  await expect(inspector).toHaveCount(0)

  await heading.hover({ force: true })
  await expect(heading).toHaveAttribute("data-splatpad-inspector-hover", "")
  const viewport = page.locator(".react-flow__viewport")
  const viewportBeforeWheel = await viewport.evaluate(
    (element) => globalThis.getComputedStyle(element).transform,
  )
  await page.mouse.wheel(0, 120)
  await expect
    .poll(() => viewport.evaluate((element) => globalThis.getComputedStyle(element).transform))
    .not.toBe(viewportBeforeWheel)

  const headingClassName = await heading.getAttribute("class")
  await heading.click({ force: true })
  await expect(inspector).toHaveText(headingClassName ?? "")
  await expect(heading).toHaveAttribute("data-splatpad-inspector-selected", "")

  await page.keyboard.press("Escape")
  await expect(inspector).toHaveCount(0)
  await expect(heading).not.toHaveAttribute("data-splatpad-inspector-selected", "")

  const link = site.getByRole("link", { name: "Story" })
  const linkClassName = await link.getAttribute("class")
  await link.click({ force: true })
  await expect(inspector).toHaveText(linkClassName ?? "")
  await expect.poll(() => link.evaluate(() => globalThis.location.pathname)).toBe("/menu/")

  await inspectTool.focus()
  await page.keyboard.down("Space")
  await expect(preview).toHaveCSS("pointer-events", "none")
  await page.keyboard.up("Space")
  await expect(preview).toHaveCSS("pointer-events", "auto")

  await page.keyboard.press("v")
  await expect(panTool).toHaveAttribute("aria-pressed", "true")
  await expect(preview).toHaveCSS("pointer-events", "none")
  await expect(inspector).toHaveCount(0)
  await expect(link).not.toHaveAttribute("data-splatpad-inspector-selected", "")
})
