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

test("shows resolved color swatches only for semantic color values", async ({ page }) => {
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await expect(page.locator(".page-frame")).toHaveCount(7)
  await page.getByRole("button", { name: "Inspect tool (I)" }).click()

  const site = page.frameLocator('iframe[title="/menu/"]')
  await site.locator("body").evaluate((body) => {
    const target = body.ownerDocument.createElement("aside")
    target.id = "color-swatch-target"
    target.className =
      "text-[#fff] bg-[rgb(12_34_56_/_0.5)] fill-[rebeccapurple] border-t-[transparent] border-r-[#abcdef] w-4 opacity-50"
    target.style.color = "white"
    target.style.backgroundColor = "rgb(12 34 56 / 0.5)"
    target.style.setProperty("--un-border-right-opacity", "100%")
    target.style.setProperty("--un-border-top-opacity", "100%")
    target.style.setProperty("--un-fill-opacity", "100%")
    target.style.fill = "rebeccapurple"
    target.style.borderTopColor = "transparent"
    target.style.borderRightColor = "#abcdef"
    target.textContent = "Color swatches"
    body.append(target)
  })

  const target = site.locator("#color-swatch-target")
  await target.dispatchEvent("pointerdown", { button: 0, pointerId: 81, pointerType: "mouse" })
  const inspector = page.getByRole("complementary", { name: "Element inspector" })
  await expect(inspector).toHaveAttribute("aria-busy", "false")

  const valueFor = (card: string, field: string) =>
    inspector
      .locator(".designer-inspector__semantic-card")
      .filter({ hasText: new RegExp(`^${card}`) })
      .locator("dt", { hasText: new RegExp(`^${field}$`) })
      .locator("..")
  const swatchFor = (card: string, field: string) =>
    valueFor(card, field).locator(".designer-inspector__color-swatch")
  await expect(swatchFor("Typography", "Color")).toHaveCSS(
    "background-color",
    /^(?:rgb\(255, 255, 255\)|oklab\(0\.999)/,
  )
  await expect(swatchFor("Fill", "Background")).toHaveCSS(
    "background-color",
    /^(?:rgba\(12, 34, 56, 0\.5\)|oklab\(.+ \/ 0\.5\))$/,
  )
  await expect(swatchFor("Fill", "Fill")).toHaveCSS(
    "background-color",
    /^(?:rgb\(102, 51, 153\)|oklab\()/,
  )
  await expect(swatchFor("Stroke", "Top color")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")
  await expect(swatchFor("Stroke", "Right color")).toHaveCSS(
    "background-color",
    /^(?:rgb\(171, 205, 239\)|oklab\()/,
  )
  await expect(swatchFor("Typography", "Color")).toHaveAttribute("aria-hidden", "true")
  await expect(swatchFor("Typography", "Color")).toHaveCSS("background-image", /linear-gradient/)
  await expect(swatchFor("Dimensions", "Width")).toHaveCount(0)
  await expect(swatchFor("Opacity", "Opacity")).toHaveCount(0)

  await site.locator("body").evaluate((body) => {
    const variableTarget = body.ownerDocument.createElement("aside")
    variableTarget.id = "resolved-variable-color-target"
    variableTarget.className = "text-[#2468ac] bg-[var(--swatch-paint)] fill-current"
    variableTarget.style.setProperty("--swatch-paint", "hsl(120 50% 50% / 0.4)")
    variableTarget.style.color = "#2468ac"
    variableTarget.style.backgroundColor = "var(--swatch-paint)"
    variableTarget.style.fill = "currentColor"
    variableTarget.textContent = "Resolved variable color"
    body.append(variableTarget)
  })
  await page.waitForTimeout(550)
  await site.locator("#resolved-variable-color-target").dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 82,
    pointerType: "mouse",
  })
  await expect(inspector).toHaveAttribute("aria-busy", "false")
  await expect(swatchFor("Fill", "Background")).toHaveCSS(
    "background-color",
    /^(?:rgba\(64, 191, 64, 0\.4\)|oklab\(.+ \/ 0\.4\))$/,
  )
  await expect(swatchFor("Fill", "Fill")).toHaveCSS("background-color", /^(?:rgb|oklab)\(/)

  await site.locator("body").evaluate((body) => {
    const parent = body.ownerDocument.createElement("section")
    parent.style.color = "rgb(190 20 30)"
    parent.style.backgroundColor = "rgb(20 80 190)"
    parent.style.fill = "rgb(25 145 70)"
    parent.style.borderTopColor = "rgb(140 45 175)"

    const inheritedColorElement = body.ownerDocument.createElement("aside")
    inheritedColorElement.id = "inherited-color-target"
    inheritedColorElement.className = "text-inherit bg-inherit fill-inherit border-t-[inherit]"
    inheritedColorElement.style.color = "inherit"
    inheritedColorElement.style.backgroundColor = "inherit"
    inheritedColorElement.style.fill = "inherit"
    inheritedColorElement.style.borderTopColor = "inherit"
    inheritedColorElement.textContent = "Inherited colors"
    parent.append(inheritedColorElement)
    body.append(parent)
  })
  await page.waitForTimeout(550)
  const inheritedTarget = site.locator("#inherited-color-target")
  await inheritedTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 83,
    pointerType: "mouse",
  })
  await expect(inspector).toHaveAttribute("aria-busy", "false")
  const inheritedFields = [
    ["Typography", "Color", "color", "text-inherit"],
    ["Fill", "Background", "background-color", "bg-inherit"],
    ["Fill", "Fill", "fill", "fill-inherit"],
    ["Stroke", "Top color", "border-top-color", "border-t-[inherit]"],
  ] as const
  await Promise.all(
    inheritedFields.map(async ([card, field, property, token]) => {
      const value = valueFor(card, field)
      await expect(value.locator(".designer-inspector__semantic-value")).toHaveText("inherit")
      await expect(value.locator("dd")).toHaveAttribute("data-source-tokens", token)
      await expect(value.locator("dd")).toHaveAttribute("title", `inherit · ${token}`)
      const expectedPaint = await inheritedTarget.evaluate(
        (element, propertyName) =>
          element.ownerDocument.defaultView
            ?.getComputedStyle(element)
            .getPropertyValue(propertyName),
        property,
      )
      await expect(swatchFor(card, field)).toHaveCSS(
        "background-color",
        expectedPaint?.trim() ?? "",
      )
    }),
  )

  await site.locator("body").evaluate((body) => {
    const parent = body.ownerDocument.createElement("section")
    parent.style.backgroundColor = "rgb(215 125 35)"
    const fallbackElement = body.ownerDocument.createElement("aside")
    fallbackElement.id = "fallback-inherited-color-target"
    fallbackElement.className = "bg-[var(--missing-swatch-paint,inherit)]"
    fallbackElement.textContent = "Fallback inherited color"
    parent.append(fallbackElement)
    body.append(parent)
  })
  await page.waitForTimeout(550)
  const fallbackTarget = site.locator("#fallback-inherited-color-target")
  await fallbackTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 84,
    pointerType: "mouse",
  })
  await expect(inspector).toHaveAttribute("aria-busy", "false")
  await expect(
    valueFor("Fill", "Background").locator(".designer-inspector__semantic-value"),
  ).toHaveText("var(--missing-swatch-paint,inherit)")
  await expect(valueFor("Fill", "Background").locator("dd")).toHaveAttribute(
    "title",
    /color-mix\(.+inherit.+\) · bg-\[var\(--missing-swatch-paint,inherit\)\]/,
  )
  await expect(swatchFor("Fill", "Background")).toHaveCount(0)

  await site.locator("body").evaluate((body) => {
    const unresolvedTarget = body.ownerDocument.createElement("aside")
    unresolvedTarget.id = "unresolved-color-target"
    unresolvedTarget.className = "bg-[var(--missing-swatch-paint)]"
    unresolvedTarget.textContent = "Unresolved color"
    body.append(unresolvedTarget)
  })
  await page.waitForTimeout(550)
  await site.locator("#unresolved-color-target").dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 85,
    pointerType: "mouse",
  })
  await expect(inspector).toHaveAttribute("aria-busy", "false")
  await expect(swatchFor("Fill", "Background")).toHaveCount(0)
})

test("refreshes a pinned inspection when the selected element mutates", async ({ page }) => {
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await expect(page.locator(".page-frame")).toHaveCount(7)
  await page.getByRole("button", { name: "Inspect tool (I)" }).click()

  const site = page.frameLocator('iframe[title="/menu/"]')
  await site.locator("body").evaluate((body) => {
    const target = body.ownerDocument.createElement("aside")
    target.id = "live-inspection-target"
    target.className = "p-3 text-[#112233]"
    target.style.color = "rgb(17 34 51)"
    target.textContent = "Live inspection"
    body.append(target)
  })
  const target = site.locator("#live-inspection-target")
  await target.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 86,
    pointerType: "mouse",
  })

  const inspector = page.getByRole("complementary", { name: "Element inspector" })
  const padding = inspector
    .locator(".designer-inspector__spacing-card")
    .filter({ hasText: "Padding" })
  const colorSwatch = inspector
    .locator(".designer-inspector__semantic-card")
    .filter({ hasText: /^Typography/ })
    .locator(".designer-inspector__color-swatch")
  await expect(padding.locator("div", { hasText: /^Top3$/ })).toBeVisible()
  await expect(colorSwatch).toHaveCSS("background-color", "rgb(17, 34, 51)")
  await expect(target).toHaveAttribute("data-splatpad-inspector-selected", "")

  await target.evaluate((element) => {
    element.setAttribute("class", "p-8 text-[#112233]")
  })
  await expect(padding.locator("div", { hasText: /^Top8$/ })).toBeVisible()
  await expect(padding.locator("div", { hasText: /^Top3$/ })).toHaveCount(0)
  await expect(target).toHaveAttribute("data-splatpad-inspector-selected", "")

  await target.evaluate((element) => {
    const targetElement = element as HTMLElement
    targetElement.style.color = "rgb(170 85 34)"
  })
  await expect(colorSwatch).toHaveCSS("background-color", "rgb(170, 85, 34)")
  await expect(target).toHaveAttribute("data-splatpad-inspector-selected", "")
})

test("pans by default and inspects iframe elements without activating them", async ({ page }) => {
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await expect(page.locator(".page-frame")).toHaveCount(7)

  const viewportBreakpoint = page.getByRole("combobox", { name: "Viewport breakpoint" })
  const frameCount = await page.locator("iframe[title]").count()
  await expect(viewportBreakpoint).toHaveValue("Default")
  await expect
    .poll(() =>
      page
        .locator("iframe[title]")
        .evaluateAll((frames) => frames.map((frame) => (frame as HTMLIFrameElement).clientWidth)),
    )
    .toEqual(Array.from({ length: frameCount }, () => 639))

  const panTool = page.getByRole("button", { name: "Pan tool (V)" })
  const inspectTool = page.getByRole("button", { name: "Inspect tool (I)" })
  const preview = page.locator('.page-frame[data-route="/menu/"] .page-frame__preview')
  const site = page.frameLocator('iframe[title="/menu/"]')
  const heading = site.getByRole("heading", { level: 1 })
  const inspector = page.getByRole("complementary", { name: "Element inspector" })
  const expectInspectorClassName = async (className: string): Promise<void> => {
    const tokens = className.trim() === "" ? [] : className.trim().split(/\s+/)
    await expect(inspector).toHaveAttribute("aria-busy", "false")
    await expect
      .poll(async () => {
        const rawTokens = await inspector.locator(".designer-inspector__token").allTextContents()
        const sourceTokens = await inspector
          .locator("[data-source-tokens]")
          .evaluateAll((nodes) =>
            nodes.flatMap((node) => (node.getAttribute("data-source-tokens") ?? "").split(/\s+/)),
          )
        const inspectedTokens = [...new Set([...rawTokens, ...sourceTokens].filter(Boolean))]
        return {
          count: inspectedTokens.length,
          hasAll: tokens.every((token) => inspectedTokens.includes(token)),
        }
      })
      .toEqual({ count: new Set(tokens).size, hasAll: true })
  }
  const overlaySnapshot = async (kind: "hover" | "selected", targetSelector: string) =>
    page
      .locator(
        `[data-splatpad-inspector-overlay="${kind}"][data-splatpad-inspector-route="/menu/"]`,
      )
      .evaluate((overlay, selector) => {
        const frame =
          overlay.ownerDocument.querySelector<HTMLIFrameElement>('iframe[title="/menu/"]')
        const target = frame?.contentDocument?.querySelector(selector)
        if (frame === null || frame === undefined || target === null || target === undefined) {
          throw new Error("Expected the preview frame and inspected target")
        }

        const frameBounds = frame.getBoundingClientRect()
        const scaleX = frame.offsetWidth === 0 ? 1 : frameBounds.width / frame.offsetWidth
        const scaleY = frame.offsetHeight === 0 ? 1 : frameBounds.height / frame.offsetHeight
        const frameLeft = frameBounds.left + frame.clientLeft * scaleX
        const frameTop = frameBounds.top + frame.clientTop * scaleY
        const targetBounds = target.getBoundingClientRect()
        const viewportWidth = frame.contentDocument?.documentElement.clientWidth ?? 0
        const viewportHeight = frame.contentDocument?.documentElement.clientHeight ?? 0
        const expected = {
          bottom: frameTop + Math.max(0, Math.min(viewportHeight, targetBounds.bottom)) * scaleY,
          left: frameLeft + Math.max(0, Math.min(viewportWidth, targetBounds.left)) * scaleX,
          right: frameLeft + Math.max(0, Math.min(viewportWidth, targetBounds.right)) * scaleX,
          top: frameTop + Math.max(0, Math.min(viewportHeight, targetBounds.top)) * scaleY,
        }
        const bounds = overlay.getBoundingClientRect()
        const style = globalThis.getComputedStyle(overlay)
        return {
          alignmentGaps: [
            Math.abs(bounds.top - expected.top) < 2
              ? 0
              : Math.round((bounds.top - expected.top) * 10) / 10,
            Math.abs(bounds.right - expected.right) < 2
              ? 0
              : Math.round((bounds.right - expected.right) * 10) / 10,
            Math.abs(bounds.bottom - expected.bottom) < 2
              ? 0
              : Math.round((bounds.bottom - expected.bottom) * 10) / 10,
            Math.abs(bounds.left - expected.left) < 2
              ? 0
              : Math.round((bounds.left - expected.left) * 10) / 10,
          ],
          borderColor: style.borderTopColor,
          borderStyles: [
            style.borderTopStyle,
            style.borderRightStyle,
            style.borderBottomStyle,
            style.borderLeftStyle,
          ],
          borderWidths: [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ],
          display: style.display,
          margin: style.margin,
          ownerIsDesigner: overlay.ownerDocument === frame.ownerDocument,
          pointerEvents: style.pointerEvents,
          transform: style.transform,
          withinFrame:
            bounds.top >= frameTop - 0.1 &&
            bounds.right <= frameLeft + viewportWidth * scaleX + 0.1 &&
            bounds.bottom <= frameTop + viewportHeight * scaleY + 0.1 &&
            bounds.left >= frameLeft - 0.1,
          zIndex: style.zIndex,
        }
      }, targetSelector)

  await expect(panTool).toHaveAttribute("aria-pressed", "true")
  await expect(panTool.locator("svg.lucide-hand")).toHaveCount(1)
  await expect(inspectTool.locator("svg.lucide-mouse-pointer-2")).toHaveCount(1)
  await expect(preview).toHaveCSS("pointer-events", "none")
  await expect(inspector).toHaveCount(0)

  await page.keyboard.press("i")
  await expect(inspectTool).toHaveAttribute("aria-pressed", "true")
  await expect(preview).toHaveCSS("pointer-events", "auto")
  await expect(site.locator("#splatpad-inspector-styles")).toHaveCount(1)
  await expect(inspector).toHaveCount(0)

  await site.locator("head").evaluate((head) => {
    const style = head.ownerDocument.createElement("style")
    style.textContent = `
      html {
        filter: opacity(.999);
        transform: translate(23px, 29px) scale(.97);
        transform-origin: 0 0;
      }
      [aria-hidden="true"] { display: none !important; }
      div {
        border: 11px dashed red !important;
        box-sizing: content-box !important;
        height: 13px !important;
        margin: 17px !important;
        padding: 19px !important;
        transform: translate(23px, 29px) !important;
        width: 31px !important;
      }
    `
    head.append(style)
  })

  await expect
    .poll(async () => {
      await heading.hover({ force: true })
      return heading.getAttribute("data-splatpad-inspector-hover")
    })
    .toBe("")
  await expect(site.locator('[data-splatpad-inspector-overlay="hover"]')).toHaveCount(0)
  await expect
    .poll(() => overlaySnapshot("hover", "h1"))
    .toEqual({
      alignmentGaps: [0, 0, 0, 0],
      borderColor: "rgb(37, 99, 235)",
      borderStyles: ["solid", "solid", "solid", "solid"],
      borderWidths: ["2px", "2px", "2px", "2px"],
      display: "block",
      margin: "0px",
      ownerIsDesigner: true,
      pointerEvents: "none",
      transform: "none",
      withinFrame: true,
      zIndex: "2147483646",
    })
  const viewport = page.locator(".react-flow__viewport")
  const viewportBeforeWheel = await viewport.evaluate(
    (element) => globalThis.getComputedStyle(element).transform,
  )
  await page.mouse.wheel(0, 120)
  await expect
    .poll(() => viewport.evaluate((element) => globalThis.getComputedStyle(element).transform))
    .not.toBe(viewportBeforeWheel)

  const headingClassName = await heading.getAttribute("class")
  const parentClassName = await heading.evaluate(
    (element) => element.parentElement?.getAttribute("class") ?? "",
  )
  await heading.click({ force: true })
  await expectInspectorClassName(headingClassName ?? "")
  const marginSummary = inspector
    .locator('.designer-inspector__spacing-card[data-source-tokens~="mt-3"]')
    .filter({ hasText: "Margin" })
  await expect(marginSummary.locator("div", { hasText: /^Top3$/ })).toBeVisible()

  await viewportBreakpoint.selectOption("Default")
  await expect(viewportBreakpoint).toHaveValue("Default")
  await expect
    .poll(() =>
      page
        .locator("iframe[title]")
        .evaluateAll((frames) => frames.map((frame) => (frame as HTMLIFrameElement).clientWidth)),
    )
    .toEqual(Array.from({ length: await page.locator("iframe[title]").count() }, () => 639))

  await site.locator("body").evaluate((body) => {
    const target = body.ownerDocument.createElement("aside")
    target.id = "responsive-spacing-target"
    target.className = "p-3 sm:px-4"
    target.textContent = "Responsive spacing"
    body.append(target)
  })
  const responsiveSpacingTarget = site.locator("#responsive-spacing-target")
  await responsiveSpacingTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 71,
    pointerType: "mouse",
  })
  await responsiveSpacingTarget.dispatchEvent("pointerup", {
    button: 0,
    pointerId: 71,
    pointerType: "mouse",
  })
  const paddingSummary = inspector
    .locator(".designer-inspector__spacing-card")
    .filter({ hasText: "Padding" })
  await expect(paddingSummary.locator("div", { hasText: /^Top3$/ })).toBeVisible()
  await expect(paddingSummary.locator("div", { hasText: /^Left3$/ })).toBeVisible()

  await viewportBreakpoint.selectOption("sm")
  await expect(viewportBreakpoint).toHaveValue("sm")
  await expect
    .poll(() =>
      page
        .locator("iframe[title]")
        .evaluateAll((frames) => frames.map((frame) => (frame as HTMLIFrameElement).clientWidth)),
    )
    .toEqual(Array.from({ length: await page.locator("iframe[title]").count() }, () => 640))
  await expect(paddingSummary.locator("div", { hasText: /^Top3$/ })).toBeVisible()
  await expect(paddingSummary.locator("div", { hasText: /^Left4$/ })).toBeVisible()

  await site.locator("body").evaluate((body) => {
    const target = body.ownerDocument.createElement("aside")
    target.id = "semantic-properties-target"
    target.className =
      "flex flex-row items-center gap-4 size-[13px] text-[17px] leading-[1.5] bg-[#123456] border-2 border-solid rounded-lg opacity-50 isolate shadow-lg hover:w-4"
    target.textContent = "Semantic properties"
    body.append(target)
  })
  const semanticTarget = site.locator("#semantic-properties-target")
  await semanticTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 75,
    pointerType: "mouse",
  })
  await expectInspectorClassName((await semanticTarget.getAttribute("class")) ?? "")
  await Promise.all(
    [
      "Typography",
      "Dimensions",
      "Auto Layout",
      "Fill",
      "Stroke",
      "Corners",
      "Opacity",
      "Effects",
    ].map((card) =>
      expect(inspector.getByRole("heading", { level: 4, name: card, exact: true })).toBeVisible(),
    ),
  )
  await expect(inspector.getByText("13px", { exact: true }).first()).toBeVisible()
  await expect(inspector.getByText("17px", { exact: true })).toBeVisible()
  await expect(inspector.locator('[data-utility-token="shadow-lg"]')).toBeVisible()
  await expect(inspector.locator('[data-utility-token="hover:w-4"]')).toBeVisible()
  await semanticTarget.evaluate((element) => element.remove())

  await viewportBreakpoint.selectOption("Default")
  await site.locator("body").evaluate((body) => {
    const target = body.ownerDocument.createElement("aside")
    target.id = "responsive-auto-layout-target"
    target.className = "md:flex gap-4"
    target.textContent = "Responsive auto layout"
    body.append(target)
  })
  const responsiveAutoLayoutTarget = site.locator("#responsive-auto-layout-target")
  await responsiveAutoLayoutTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 79,
    pointerType: "mouse",
  })
  await expect(inspector.getByRole("heading", { level: 4, name: "Auto Layout" })).toHaveCount(0)
  await expect(inspector.locator('[data-utility-token="md:flex"]')).toBeVisible()
  await expect(inspector.locator('[data-utility-token="gap-4"]')).toBeVisible()

  await viewportBreakpoint.selectOption("md")
  const responsiveAutoLayout = inspector
    .locator(".designer-inspector__semantic-card")
    .filter({ hasText: "Auto Layout" })
  await expect(responsiveAutoLayout.locator("div", { hasText: /^Modeflex$/ })).toBeVisible()
  await expect(responsiveAutoLayout.locator("div", { hasText: /^Row gap4$/ })).toBeVisible()
  await expect(responsiveAutoLayout.locator("div", { hasText: /^Column gap4$/ })).toBeVisible()
  await responsiveAutoLayoutTarget.evaluate((element) => element.remove())
  await viewportBreakpoint.selectOption("sm")

  await site.locator("body").evaluate((body) => {
    const target = body.ownerDocument.createElement("aside")
    target.id = "conditional-generator-target"
    target.className = "container bg-red-500/50"
    target.textContent = "Conditional generator rules"
    body.append(target)
  })
  const conditionalGeneratorTarget = site.locator("#conditional-generator-target")
  await conditionalGeneratorTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 76,
    pointerType: "mouse",
  })
  await expect(inspector.locator('[data-utility-token="container"]')).toBeVisible()
  await expect(inspector.locator('[data-utility-token="bg-red-500/50"]')).toBeVisible()
  await expect(inspector.getByRole("heading", { level: 4, name: "Dimensions" })).toHaveCount(0)
  await expect(inspector.getByRole("heading", { level: 4, name: "Fill" })).toHaveCount(0)
  await conditionalGeneratorTarget.evaluate((element) => element.remove())

  await responsiveSpacingTarget.evaluate((element) => element.remove())
  await page.waitForTimeout(550)
  await viewportBreakpoint.selectOption("Default")
  await heading.click({ force: true })
  await expectInspectorClassName(headingClassName ?? "")
  const headingTypography = inspector
    .locator(".designer-inspector__semantic-card")
    .filter({ hasText: "Typography" })
  await expect(headingTypography.locator("div", { hasText: /^Size5xl$/ })).toBeVisible()
  await expect(headingTypography.locator("div", { hasText: /^Weightbold$/ })).toBeVisible()
  await expect(
    headingTypography.locator("div", { hasText: /^Letter spacing-0\.04em$/ }),
  ).toBeVisible()
  await expect(headingTypography.locator("div", { hasText: /^Line height5xl$/ })).toHaveCount(0)
  await expect(heading).toHaveAttribute("data-splatpad-inspector-selected", "")
  await expect(inspector).toHaveCSS("top", "16px")
  await expect(inspector).toHaveCSS("bottom", "16px")
  await expect
    .poll(() => overlaySnapshot("selected", "h1"))
    .toEqual({
      alignmentGaps: [0, 0, 0, 0],
      borderColor: "rgb(124, 58, 237)",
      borderStyles: ["solid", "solid", "solid", "solid"],
      borderWidths: ["2px", "2px", "2px", "2px"],
      display: "block",
      margin: "0px",
      ownerIsDesigner: true,
      pointerEvents: "none",
      transform: "none",
      withinFrame: true,
      zIndex: "2147483647",
    })

  const selectedOverlay = page.locator(
    '[data-splatpad-inspector-overlay="selected"][data-splatpad-inspector-route="/menu/"]',
  )
  const selectedBoundsBeforeMovement = await selectedOverlay.boundingBox()
  await heading.evaluate((element) => {
    const target = element as HTMLElement
    target.style.setProperty("left", "61px", "important")
    target.style.setProperty("position", "relative", "important")
    target.style.setProperty("top", "37px", "important")
  })
  await expect
    .poll(() => overlaySnapshot("selected", "h1"))
    .toMatchObject({
      alignmentGaps: [0, 0, 0, 0],
    })
  await expect
    .poll(async () => {
      const movedBounds = await selectedOverlay.boundingBox()
      return (
        (movedBounds?.x ?? 0) > (selectedBoundsBeforeMovement?.x ?? 0) + 1 &&
        (movedBounds?.y ?? 0) > (selectedBoundsBeforeMovement?.y ?? 0) + 1
      )
    })
    .toBe(true)
  await heading.evaluate((element) => {
    const target = element as HTMLElement
    target.style.removeProperty("left")
    target.style.removeProperty("position")
    target.style.removeProperty("top")
  })
  await expect
    .poll(() => overlaySnapshot("selected", "h1"))
    .toMatchObject({
      alignmentGaps: [0, 0, 0, 0],
    })

  await site.locator("body").evaluate((body) => {
    for (const direction of ["ltr", "rtl"] as const) {
      const target = body.ownerDocument.createElement("aside")
      target.id = `${direction}-logical-spacing-target`
      target.className = "ps-2 pe-3"
      target.dir = direction
      target.textContent = `${direction.toUpperCase()} logical spacing`
      body.append(target)
    }
  })
  const ltrSpacingTarget = site.locator("#ltr-logical-spacing-target")
  const rtlSpacingTarget = site.locator("#rtl-logical-spacing-target")
  const logicalSpacing = inspector
    .locator('.designer-inspector__spacing-card[data-source-tokens~="ps-2"]')
    .filter({ hasText: "Padding" })

  await ltrSpacingTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 72,
    pointerType: "mouse",
  })
  await expect(logicalSpacing.locator("div", { hasText: /^Left2$/ })).toBeVisible()
  await expect(logicalSpacing.locator("div", { hasText: /^Right3$/ })).toBeVisible()
  await rtlSpacingTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 73,
    pointerType: "mouse",
  })
  await expect(logicalSpacing.locator("div", { hasText: /^Left3$/ })).toBeVisible()
  await expect(logicalSpacing.locator("div", { hasText: /^Right2$/ })).toBeVisible()
  await ltrSpacingTarget.evaluate((element) => element.remove())
  await rtlSpacingTarget.evaluate((element) => element.remove())

  await site.locator("body").evaluate((body) => {
    const style = body.ownerDocument.createElement("style")
    style.dataset.testLogicalAxes = ""
    style.textContent = `
      .write-vertical-right { writing-mode: vertical-rl; }
      @media (min-width: 48rem) { #responsive-direction-target { direction: rtl; } }
    `
    body.ownerDocument.head.append(style)

    const vertical = body.ownerDocument.createElement("aside")
    vertical.id = "vertical-logical-target"
    vertical.className = "write-vertical-right ps-4 border-s-2 rounded-ss-lg"
    vertical.textContent = "Vertical logical properties"
    body.append(vertical)
  })
  const verticalLogicalTarget = site.locator("#vertical-logical-target")
  await verticalLogicalTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 77,
    pointerType: "mouse",
  })
  await expect(
    inspector
      .locator('.designer-inspector__spacing-card[data-source-tokens~="ps-4"]')
      .locator("div", { hasText: /^Top4$/ }),
  ).toBeVisible()
  await expect(inspector.locator('dd[data-source-tokens="border-s-2"]')).toHaveText("2")
  await expect(inspector.locator("dt", { hasText: /^Top right$/ })).toHaveText("Top right")
  await verticalLogicalTarget.evaluate((element) => element.remove())

  await viewportBreakpoint.selectOption("Default")
  await site.locator("body").evaluate((body) => {
    const target = body.ownerDocument.createElement("aside")
    target.id = "responsive-direction-target"
    target.className = "ps-4 md:[direction:rtl]"
    target.textContent = "Responsive direction"
    body.append(target)
  })
  const responsiveDirectionTarget = site.locator("#responsive-direction-target")
  await responsiveDirectionTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 78,
    pointerType: "mouse",
  })
  const responsiveDirectionSpacing = inspector.locator(
    '.designer-inspector__spacing-card[data-source-tokens~="ps-4"]',
  )
  await expect(responsiveDirectionSpacing.locator("div", { hasText: /^Left4$/ })).toBeVisible()
  await viewportBreakpoint.selectOption("md")
  await expect(responsiveDirectionSpacing.locator("div", { hasText: /^Right4$/ })).toBeVisible()
  await responsiveDirectionTarget.evaluate((element) => element.remove())
  await site.locator("style[data-test-logical-axes]").evaluate((element) => element.remove())
  await viewportBreakpoint.selectOption("Default")
  await heading.click({ force: true })
  await expectInspectorClassName(headingClassName ?? "")

  const disconnectedTarget = site.locator("#disconnected-inspection-target")
  await site.locator("body").evaluate((body) => {
    const target = body.ownerDocument.createElement("aside")
    target.id = "disconnected-inspection-target"
    target.className = "disconnected-selection"
    target.textContent = "Temporary target"
    body.append(target)
  })
  await disconnectedTarget.hover({ force: true })
  await disconnectedTarget.dispatchEvent("pointerdown", {
    button: 0,
    pointerId: 74,
    pointerType: "mouse",
  })
  await expectInspectorClassName("disconnected-selection")
  await expect(inspector.getByText("Unknown", { exact: true })).toBeVisible()
  await expect(selectedOverlay).toHaveCSS("display", "block")
  await disconnectedTarget.evaluate((element) => element.remove())
  await expect(inspector).toHaveCount(0)
  await expect(selectedOverlay).toHaveCSS("display", "none")
  await heading.hover({ force: true })
  await expect(heading).toHaveAttribute("data-splatpad-inspector-hover", "")
  await expect.poll(() => overlaySnapshot("hover", "h1")).toMatchObject({ display: "block" })
  await heading.click({ force: true })
  await expectInspectorClassName(headingClassName ?? "")

  const viewportBeforeFailedCapture = await viewport.evaluate(
    (element) => globalThis.getComputedStyle(element).transform,
  )
  await heading.evaluate((element) => {
    const document = element.ownerDocument
    const view = document.defaultView
    if (view === null) {
      throw new Error("Expected the heading document to have a window")
    }

    const capture = element as Element & {
      setPointerCapture: (pointerId: number) => void
    }
    const setPointerCapture = capture.setPointerCapture
    capture.setPointerCapture = () => {
      throw new DOMException("Synthetic pointer capture failure", "InvalidStateError")
    }
    const bounds = element.getBoundingClientRect()
    const clientX = bounds.left + bounds.width / 2
    const clientY = bounds.top + bounds.height / 2

    try {
      element.dispatchEvent(
        new view.PointerEvent("pointerdown", {
          bubbles: true,
          button: 1,
          buttons: 4,
          cancelable: true,
          clientX,
          clientY,
          pointerId: 4141,
        }),
      )
      element.dispatchEvent(
        new view.PointerEvent("pointermove", {
          bubbles: true,
          button: -1,
          buttons: 4,
          cancelable: true,
          clientX: clientX + 50,
          clientY: clientY + 50,
          pointerId: 4141,
        }),
      )
      element.dispatchEvent(
        new view.PointerEvent("pointerup", {
          bubbles: true,
          button: 1,
          cancelable: true,
          clientX: clientX + 50,
          clientY: clientY + 50,
          pointerId: 4141,
        }),
      )
    } finally {
      capture.setPointerCapture = setPointerCapture
    }
  })
  await expect
    .poll(() => viewport.evaluate((element) => globalThis.getComputedStyle(element).transform))
    .toBe(viewportBeforeFailedCapture)

  const viewportBeforeControlledPan = await viewport.evaluate((element) => {
    const transform = new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform)
    return { x: transform.m41, y: transform.m42 }
  })
  await heading.evaluate((element) => {
    const document = element.ownerDocument
    const view = document.defaultView
    const frameElement = view?.frameElement
    if (frameElement?.tagName !== "IFRAME" || view === null) {
      throw new Error("Expected the heading to be inside an iframe")
    }
    const frame = frameElement as HTMLIFrameElement

    const frameBounds = frame.getBoundingClientRect()
    const scaleX = frame.offsetWidth === 0 ? 1 : frameBounds.width / frame.offsetWidth
    const scaleY = frame.offsetHeight === 0 ? 1 : frameBounds.height / frame.offsetHeight
    const bounds = element.getBoundingClientRect()
    const clientX = bounds.left + bounds.width / 2
    const clientY = bounds.top + bounds.height / 2
    const capture = element as Element & {
      hasPointerCapture: (pointerId: number) => boolean
      releasePointerCapture: (pointerId: number) => void
      setPointerCapture: (pointerId: number) => void
    }
    const methods = {
      hasPointerCapture: capture.hasPointerCapture,
      releasePointerCapture: capture.releasePointerCapture,
      setPointerCapture: capture.setPointerCapture,
    }
    capture.setPointerCapture = () => undefined
    capture.hasPointerCapture = () => false
    capture.releasePointerCapture = () => undefined

    try {
      element.dispatchEvent(
        new view.PointerEvent("pointerdown", {
          bubbles: true,
          button: 1,
          buttons: 4,
          cancelable: true,
          clientX,
          clientY,
          pointerId: 4242,
          screenX: 500_000,
          screenY: -500_000,
        }),
      )
      element.dispatchEvent(
        new view.PointerEvent("pointermove", {
          bubbles: true,
          button: -1,
          buttons: 4,
          cancelable: true,
          clientX: clientX + 18 / scaleX,
          clientY: clientY + 12 / scaleY,
          pointerId: 4242,
          screenX: -500_000,
          screenY: 500_000,
        }),
      )
      element.dispatchEvent(
        new view.PointerEvent("pointerup", {
          bubbles: true,
          button: 1,
          cancelable: true,
          clientX: clientX + 18 / scaleX,
          clientY: clientY + 12 / scaleY,
          pointerId: 4242,
          screenX: 250_000,
          screenY: 250_000,
        }),
      )
    } finally {
      capture.setPointerCapture = methods.setPointerCapture
      capture.hasPointerCapture = methods.hasPointerCapture
      capture.releasePointerCapture = methods.releasePointerCapture
    }
  })
  await expect
    .poll(async () => {
      const transform = await viewport.evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform)
        return { x: matrix.m41, y: matrix.m42 }
      })
      return {
        x: Math.round(transform.x - viewportBeforeControlledPan.x),
        y: Math.round(transform.y - viewportBeforeControlledPan.y),
      }
    })
    .toEqual({ x: 18, y: 12 })
  await expectInspectorClassName(headingClassName ?? "")
  await expect(heading).toHaveAttribute("data-splatpad-inspector-selected", "")

  const viewportBeforeCaptureLoss = await viewport.evaluate((element) => {
    const transform = new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform)
    return { x: transform.m41, y: transform.m42 }
  })
  await site.locator("body").evaluate((body) => {
    const document = body.ownerDocument
    const view = document.defaultView
    const frameElement = view?.frameElement
    if (frameElement?.tagName !== "IFRAME" || view === null) {
      throw new Error("Expected the temporary target to be inside an iframe")
    }
    const frame = frameElement as HTMLIFrameElement
    const target = document.createElement("button")
    target.textContent = "Capture target"
    body.append(target)

    const frameBounds = frame.getBoundingClientRect()
    const scaleX = frame.offsetWidth === 0 ? 1 : frameBounds.width / frame.offsetWidth
    const scaleY = frame.offsetHeight === 0 ? 1 : frameBounds.height / frame.offsetHeight
    const capture = target as Element & {
      hasPointerCapture: (pointerId: number) => boolean
      releasePointerCapture: (pointerId: number) => void
      setPointerCapture: (pointerId: number) => void
    }
    capture.setPointerCapture = () => undefined
    capture.hasPointerCapture = () => false
    capture.releasePointerCapture = () => undefined
    const pointerId = 4343

    target.dispatchEvent(
      new view.PointerEvent("pointerdown", {
        bubbles: true,
        button: 1,
        buttons: 4,
        cancelable: true,
        clientX: 20,
        clientY: 20,
        pointerId,
      }),
    )
    document.dispatchEvent(
      new view.PointerEvent("pointermove", {
        bubbles: true,
        button: -1,
        buttons: 4,
        cancelable: true,
        clientX: 20 + 13 / scaleX,
        clientY: 20 + 9 / scaleY,
        pointerId,
      }),
    )
    target.remove()
    target.dispatchEvent(
      new view.PointerEvent("lostpointercapture", {
        bubbles: true,
        pointerId,
      }),
    )
    document.dispatchEvent(
      new view.PointerEvent("pointermove", {
        bubbles: true,
        button: -1,
        buttons: 4,
        cancelable: true,
        clientX: 20 + 71 / scaleX,
        clientY: 20 + 63 / scaleY,
        pointerId,
      }),
    )
    document.dispatchEvent(
      new view.PointerEvent("pointerup", {
        bubbles: true,
        button: 1,
        cancelable: true,
        clientX: 20 + 71 / scaleX,
        clientY: 20 + 63 / scaleY,
        pointerId,
      }),
    )
  })
  await expect
    .poll(async () => {
      const transform = await viewport.evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform)
        return { x: matrix.m41, y: matrix.m42 }
      })
      return {
        x: Math.round(transform.x - viewportBeforeCaptureLoss.x),
        y: Math.round(transform.y - viewportBeforeCaptureLoss.y),
      }
    })
    .toEqual({ x: 13, y: 9 })

  const viewportBeforeMiddlePan = await viewport.evaluate((element) => {
    const transform = new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform)
    return { x: transform.m41, y: transform.m42 }
  })
  expect(Math.abs(viewportBeforeMiddlePan.x) + Math.abs(viewportBeforeMiddlePan.y)).toBeGreaterThan(
    0,
  )
  const headingBounds = await heading.boundingBox()
  expect(headingBounds).not.toBeNull()
  await page.mouse.move(
    (headingBounds?.x ?? 0) + (headingBounds?.width ?? 0) / 2,
    (headingBounds?.y ?? 0) + (headingBounds?.height ?? 0) / 2,
  )
  await page.mouse.down({ button: "middle" })
  await page.mouse.move(
    (headingBounds?.x ?? 0) + (headingBounds?.width ?? 0) / 2 + 96,
    (headingBounds?.y ?? 0) + (headingBounds?.height ?? 0) / 2 + 72,
    { steps: 80 },
  )
  await page.mouse.up({ button: "middle" })
  await expect
    .poll(async () => {
      const transform = await viewport.evaluate((element) => {
        const matrix = new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform)
        return { x: matrix.m41, y: matrix.m42 }
      })
      return {
        x: Math.round(transform.x - viewportBeforeMiddlePan.x),
        y: Math.round(transform.y - viewportBeforeMiddlePan.y),
      }
    })
    .toEqual({ x: 96, y: 72 })
  await expectInspectorClassName(headingClassName ?? "")
  await expect(heading).toHaveAttribute("data-splatpad-inspector-selected", "")

  await page.waitForTimeout(550)
  await heading.click({ force: true })
  await expectInspectorClassName(headingClassName ?? "")
  await expect(heading).toHaveAttribute("data-splatpad-inspector-selected", "")

  await heading.click({ force: true })
  await expectInspectorClassName(parentClassName)

  const body = site.locator("body")
  await body.dispatchEvent("pointerdown", { button: 0, pointerId: 1 })
  await expect(body).toHaveAttribute("data-splatpad-inspector-selected", "")
  await expect
    .poll(() => overlaySnapshot("selected", "body"))
    .toEqual({
      alignmentGaps: [0, 0, 0, 0],
      borderColor: "rgb(124, 58, 237)",
      borderStyles: ["solid", "solid", "solid", "solid"],
      borderWidths: ["2px", "2px", "2px", "2px"],
      display: "block",
      margin: "0px",
      ownerIsDesigner: true,
      pointerEvents: "none",
      transform: "none",
      withinFrame: true,
      zIndex: "2147483647",
    })

  await page.keyboard.press("Escape")
  await expect(inspector).toHaveCount(0)
  await expect(heading).not.toHaveAttribute("data-splatpad-inspector-selected", "")

  const link = site.getByRole("link", { name: "Story" })
  const linkClassName = await link.getAttribute("class")
  await link.click({ force: true })
  await expectInspectorClassName(linkClassName ?? "")
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
