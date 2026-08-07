import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { expect, test, type Locator, type Page } from "@playwright/test"
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

  await expect(page.locator(".page-frame")).toHaveCount(13)
  await expect(page.locator('.page-frame[data-route="/journal/"]')).toBeVisible()
  await expect(page.locator('.page-frame[data-route="/journal/seasonal-jam/"]')).toBeVisible()
  await expect(page.locator(".page-frame__preview")).toHaveCount(13)

  const newRoute = path.join(siteRoot, "pages", "journal", "archive", "index.liquid")
  await fs.mkdir(path.dirname(newRoute), { recursive: true })
  await fs.writeFile(newRoute, "<main>Archive</main>")

  await expect(page.locator('.page-frame[data-route="/journal/archive/"]')).toBeVisible()

  await fs.rm(path.dirname(newRoute), { recursive: true })
  await expect(page.locator('.page-frame[data-route="/journal/archive/"]')).toHaveCount(0)
  expect(browserProblems.join("\n")).not.toContain("React Flow")
  expect(browserProblems.join("\n")).not.toContain("ResizeObserver")
})

const panTool = (page: Page): Locator => page.getByRole("button", { name: "Pan tool (V)" })
const inspectTool = (page: Page): Locator => page.getByRole("button", { name: "Inspect tool (I)" })
const inspector = (page: Page): Locator =>
  page.getByRole("complementary", { name: "Element inspector" })
const expectInspectorClassName = async (page: Page, className: string): Promise<void> => {
  const tokens = className.trim() === "" ? [] : className.trim().split(/\s+/)
  await expect(inspector(page)).toHaveAttribute("aria-busy", "false")
  await expect
    .poll(async () => {
      const rawTokens = await inspector(page)
        .locator(".designer-inspector__token")
        .allTextContents()
      const sourceTokens = await inspector(page)
        .locator("[data-source-tokens]")
        .evaluateAll((nodes) =>
          nodes.flatMap((node) => (node.getAttribute("data-source-tokens") ?? "").split(/\s+/)),
        )
      const inspected = new Set([...rawTokens, ...sourceTokens].filter(Boolean))
      return { count: inspected.size, hasAll: tokens.every((token) => inspected.has(token)) }
    })
    .toEqual({ count: new Set(tokens).size, hasAll: true })
}
const viewport = (page: Page): Locator => page.locator(".react-flow__viewport")
const preview = (page: Page, route: string): Locator =>
  page.locator(`iframe[aria-label="Preview of ${route}"]`)

const viewportPosition = async (page: Page): Promise<{ x: number; y: number }> =>
  viewport(page).evaluate((element) => {
    const transform = new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform)
    return { x: transform.m41, y: transform.m42 }
  })

const waitForViewportToSettle = async (page: Page): Promise<void> => {
  await viewport(page).evaluate(
    (element) =>
      new Promise<void>((resolve) => {
        let previous = globalThis.getComputedStyle(element).transform
        let stableFrames = 0
        const observe = (): void => {
          const current = globalThis.getComputedStyle(element).transform
          stableFrames = current === previous ? stableFrames + 1 : 0
          previous = current
          if (stableFrames >= 12) {
            resolve()
          } else {
            globalThis.requestAnimationFrame(observe)
          }
        }
        globalThis.requestAnimationFrame(observe)
      }),
  )
}

const waitForCanvasReady = async (page: Page): Promise<void> => {
  await expect
    .poll(() =>
      page.locator(".page-frame__preview").evaluateAll(
        (frames, initialHeight) =>
          frames.every((element) => {
            const frame = element as HTMLIFrameElement
            const document = frame.contentDocument
            if (document === null || document.readyState !== "complete") {
              return false
            }
            const renderedHeight = frame.style.height
            frame.style.height = `${initialHeight}px`
            const body = document.body
            const root = document.documentElement
            const measuredHeight = Math.max(
              body?.scrollHeight ?? 0,
              body?.offsetHeight ?? 0,
              root.scrollHeight,
              root.offsetHeight,
              root.clientHeight,
            )
            frame.style.height = renderedHeight
            return Number.parseFloat(renderedHeight) === measuredHeight
          }),
        900,
      ),
    )
    .toBe(true)
  await waitForViewportToSettle(page)
}

const waitForInspectReady = async (page: Page, route = "/menu/"): Promise<void> => {
  await expect(inspectTool(page)).toHaveAttribute("aria-pressed", "true")
  await expect(
    page.locator(`.page-frame[data-route="${route}"] .page-frame__interaction-surface`),
  ).toHaveCSS("pointer-events", "auto")
  await expect(
    page.locator(`[data-splatpad-inspector-overlay][data-splatpad-inspector-route="${route}"]`),
  ).toHaveCount(2)
}

const centerOf = async (locator: Locator): Promise<{ x: number; y: number }> => {
  const bounds = await locator.boundingBox()
  if (bounds === null) {
    throw new Error("Expected the target to have visible bounds")
  }
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

const visiblePreviewPoint = async (
  page: Page,
  tool: "inspect" | "pan",
): Promise<{ route: string; x: number; y: number }> =>
  page.locator("body").evaluate((body, activeTool) => {
    const canvas = body.querySelector<HTMLElement>(".react-flow")
    if (canvas === null) {
      throw new Error("Expected a visible canvas")
    }

    const canvasBounds = canvas.getBoundingClientRect()
    const forbidden = [
      ...body.querySelectorAll<HTMLElement>(
        ".designer-toolbar, .designer-inspector, .designer-viewport-control, .react-flow__controls",
      ),
    ].map((element) => element.getBoundingClientRect())
    const pointIsAvailable = (x: number, y: number): boolean =>
      x >= Math.max(0, canvasBounds.left) &&
      x <= Math.min(globalThis.innerWidth, canvasBounds.right) &&
      y >= Math.max(0, canvasBounds.top) &&
      y <= Math.min(globalThis.innerHeight, canvasBounds.bottom) &&
      forbidden.every(
        (bounds) => x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom,
      )
    const gestureIsAvailable = (x: number, y: number): boolean =>
      Array.from({ length: 14 }, (_, step) => step / 13).every((progress) =>
        pointIsAvailable(x + 130 * progress, y + 110 * progress),
      )

    for (const frame of body.querySelectorAll<HTMLIFrameElement>(".page-frame__preview")) {
      const bounds = frame.getBoundingClientRect()
      const left = Math.ceil(Math.max(0, canvasBounds.left, bounds.left)) + 2
      const right = Math.floor(
        Math.min(globalThis.innerWidth, canvasBounds.right - 140, bounds.right),
      )
      const top = Math.ceil(Math.max(0, canvasBounds.top, bounds.top)) + 2
      const bottom = Math.floor(
        Math.min(globalThis.innerHeight, canvasBounds.bottom - 120, bounds.bottom),
      )

      for (let y = top; y <= bottom; y += 8) {
        for (let x = left; x <= right; x += 8) {
          if (!gestureIsAvailable(x, y)) {
            continue
          }
          const hit = body.ownerDocument.elementFromPoint(x, y)
          const hitsExpectedLayer =
            activeTool === "inspect"
              ? hit?.classList.contains("page-frame__interaction-surface") === true &&
                hit.closest(".page-frame")?.getAttribute("data-route") === frame.title
              : hit?.closest(".react-flow") === canvas
          if (hitsExpectedLayer) {
            return { route: frame.title, x, y }
          }
        }
      }
    }

    throw new Error("Expected a visible preview point outside floating controls")
  }, tool)

const clickTarget = async (page: Page, target: Locator): Promise<void> => {
  const center = await centerOf(target)
  await page.mouse.click(center.x, center.y)
}

const hoverTarget = async (page: Page, target: Locator): Promise<void> => {
  const center = await centerOf(target)
  await page.mouse.move(center.x, center.y)
}

const exposedPointOf = async (
  page: Page,
  route: string,
  targetSelector: string,
): Promise<{ x: number; y: number }> =>
  page.locator("body").evaluate(
    (body, options) => {
      const frame = body.ownerDocument.querySelector<HTMLIFrameElement>(
        `iframe[title="${options.route}"]`,
      )
      const target = frame?.contentDocument?.querySelector(options.targetSelector)
      if (frame === null || frame === undefined || target === null || target === undefined) {
        throw new Error("Expected a preview and target")
      }
      const bounds = target.getBoundingClientRect()
      const frameBounds = frame.getBoundingClientRect()
      const scaleX = frame.offsetWidth === 0 ? 1 : frameBounds.width / frame.offsetWidth
      const scaleY = frame.offsetHeight === 0 ? 1 : frameBounds.height / frame.offsetHeight
      for (let y = bounds.top + 1; y < bounds.bottom; y += 4) {
        for (let x = bounds.left + 1; x < bounds.right; x += 4) {
          if (frame.contentDocument?.elementFromPoint(x, y) === target) {
            const designerX = frameBounds.left + (x + frame.clientLeft) * scaleX
            const designerY = frameBounds.top + (y + frame.clientTop) * scaleY
            const designerHit = frame.ownerDocument.elementFromPoint(designerX, designerY)
            if (
              designerHit?.classList.contains("page-frame__interaction-surface") !== true ||
              designerHit.closest(".page-frame")?.getAttribute("data-route") !== options.route
            ) {
              continue
            }
            return {
              x: designerX,
              y: designerY,
            }
          }
        }
      }
      throw new Error(`Expected ${options.targetSelector} to have an exposed point`)
    },
    { route, targetSelector },
  )

const dragFrom = async (
  page: Page,
  start: { x: number; y: number },
  movement: { x: number; y: number },
  button: "left" | "middle" = "left",
): Promise<void> => {
  await page.mouse.move(start.x, start.y)
  await page.mouse.down({ button })
  await page.mouse.move(start.x + movement.x, start.y + movement.y, { steps: 12 })
  await page.mouse.up({ button })
}

const visibleOutlineCount = async (page: Page, borderColor: string): Promise<number> =>
  page.locator("body > div").evaluateAll(
    (elements, expectedColor) =>
      elements.filter((element) => {
        const style = globalThis.getComputedStyle(element)
        return (
          style.position === "fixed" &&
          style.pointerEvents === "none" &&
          style.display !== "none" &&
          style.borderTopColor === expectedColor
        )
      }).length,
    borderColor,
  )

const outlineSnapshot = async (
  page: Page,
  route: string,
  targetSelector: string,
  borderColor: string,
): Promise<{
  alignmentGaps: number[]
  borderStyles: string[]
  borderWidths: string[]
  display: string
  pointerEvents: string
  withinFrame: boolean
  zIndex: number
}> =>
  page.locator("body").evaluate(
    (body, options) => {
      const frame = body.ownerDocument.querySelector<HTMLIFrameElement>(
        `iframe[title="${options.route}"]`,
      )
      const target = frame?.contentDocument?.querySelector(options.targetSelector)
      const overlay = [...body.children].find((element) => {
        const style = globalThis.getComputedStyle(element)
        return (
          style.position === "fixed" &&
          style.pointerEvents === "none" &&
          style.display !== "none" &&
          style.borderTopColor === options.borderColor
        )
      })
      if (frame === undefined || frame === null || target === undefined || target === null) {
        throw new Error("Expected the preview frame and outline target")
      }
      if (overlay === undefined) {
        throw new Error(`Expected a visible ${options.borderColor} outline`)
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
          Math.abs(bounds.top - expected.top) < 3
            ? 0
            : Math.round((bounds.top - expected.top) * 10) / 10,
          Math.abs(bounds.right - expected.right) < 3
            ? 0
            : Math.round((bounds.right - expected.right) * 10) / 10,
          Math.abs(bounds.bottom - expected.bottom) < 3
            ? 0
            : Math.round((bounds.bottom - expected.bottom) * 10) / 10,
          Math.abs(bounds.left - expected.left) < 3
            ? 0
            : Math.round((bounds.left - expected.left) * 10) / 10,
        ],
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
        pointerEvents: style.pointerEvents,
        withinFrame:
          bounds.top >= frameTop - 0.1 &&
          bounds.right <= frameLeft + viewportWidth * scaleX + 0.1 &&
          bounds.bottom <= frameTop + viewportHeight * scaleY + 0.1 &&
          bounds.left >= frameLeft - 0.1,
        zIndex: Number(style.zIndex),
      }
    },
    { borderColor, route, targetSelector },
  )

test("refreshes pinned semantic values after a stylesheet-only update", async ({ page }) => {
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await expect(page.locator(".page-frame")).toHaveCount(13)
  await waitForCanvasReady(page)
  await inspectTool(page).click()
  await waitForInspectReady(page)

  const frame = preview(page, "/menu/")
  await frame.evaluate((iframe) => {
    const document = (iframe as HTMLIFrameElement).contentDocument!
    const target = document.createElement("div")
    target.id = "stylesheet-refresh-target"
    target.className = "ps-4 text-[#112233]"
    target.style.position = "fixed"
    target.style.inset = "20px auto auto 20px"
    target.textContent = "Stylesheet refresh target"
    document.body.prepend(target)
  })
  const targetPoint = await exposedPointOf(page, "/menu/", "#stylesheet-refresh-target")
  await page.mouse.click(targetPoint.x, targetPoint.y)

  const sidebar = inspector(page)
  await expect(sidebar).toHaveAttribute("aria-busy", "false")
  const padding = sidebar
    .locator(".designer-inspector__spacing-card")
    .filter({ hasText: "Padding" })
  const swatch = sidebar
    .locator(".designer-inspector__semantic-card")
    .filter({ hasText: /^Typography/ })
    .locator(".designer-inspector__color-swatch")
  await expect(padding.locator("div", { hasText: /^Left4$/ })).toBeVisible()
  await expect(swatch).toBeVisible()
  const initialPaint = await swatch.evaluate(
    (element) => globalThis.getComputedStyle(element).backgroundColor,
  )

  await frame.evaluate((iframe) => {
    const document = (iframe as HTMLIFrameElement).contentDocument!
    const style = document.createElement("style")
    style.id = "stylesheet-refresh"
    style.textContent =
      "#stylesheet-refresh-target { direction: rtl; color: rgb(170 85 34) !important; }"
    document.head.append(style)
  })

  await expect(padding.locator("div", { hasText: /^Right4$/ })).toBeVisible()
  await expect(padding.locator("div", { hasText: /^Left4$/ })).toHaveCount(0)
  await expect(swatch).toHaveCSS("background-color", "rgb(170, 85, 34)")
  await expect(swatch).not.toHaveCSS("background-color", initialPaint)
  await expect(
    page.frameLocator('iframe[title="/menu/"]').locator("#stylesheet-refresh-target"),
  ).toHaveCSS("color", "rgb(170, 85, 34)")
})

test("shows generated at-rule conditions separately from raw utility targets", async ({ page }) => {
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await expect(page.locator(".page-frame")).toHaveCount(13)
  await waitForCanvasReady(page)
  await inspectTool(page).click()
  await waitForInspectReady(page)

  const frame = preview(page, "/menu/")
  await frame.evaluate((iframe) => {
    const document = (iframe as HTMLIFrameElement).contentDocument!
    const target = document.createElement("div")
    target.id = "generated-conditions-target"
    target.className = "container bg-red-500/50"
    target.style.cssText = "position:fixed;inset:20px auto auto 20px;padding:12px"
    target.textContent = "Generated conditions target"
    document.body.prepend(target)
  })
  const targetPoint = await exposedPointOf(page, "/menu/", "#generated-conditions-target")
  await page.mouse.click(targetPoint.x, targetPoint.y)

  const sidebar = inspector(page)
  await expect(sidebar).toHaveAttribute("aria-busy", "false")
  const container = sidebar.locator('[data-utility-token="container"]')
  const color = sidebar.locator('[data-utility-token="bg-red-500/50"]')
  await expect(container.getByLabel("Generated conditions").locator("code")).toHaveText([
    "@media (min-width: 40rem)",
    "@media (min-width: 48rem)",
    "@media (min-width: 64rem)",
    "@media (min-width: 80rem)",
    "@media (min-width: 96rem)",
  ])
  await expect(color.getByLabel("Generated conditions").locator("code")).toHaveText([
    "@supports (color: color-mix(in lab, red, red))",
  ])
  expect(await sidebar.locator(".designer-inspector__target code").allTextContents()).not.toEqual(
    expect.arrayContaining([expect.stringMatching(/^@/)]),
  )
})

test("shrinks responsive frames and downstream layout after changing viewport", async ({
  page,
}) => {
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await expect(page.locator(".page-frame")).toHaveCount(13)
  await waitForCanvasReady(page)

  const menuFrame = preview(page, "/menu/")
  await menuFrame.evaluate((iframe) => {
    const document = (iframe as HTMLIFrameElement).contentDocument!
    document.body.innerHTML = '<main id="responsive-height-regression"></main>'
    const style = document.createElement("style")
    style.textContent = `
      #responsive-height-regression { height: 1600px; }
      @media (min-width: 768px) {
        #responsive-height-regression { height: 100px; }
      }
    `
    document.head.append(style)
  })

  const menuFrameNode = page
    .locator('.page-frame[data-route="/menu/"]')
    .locator("xpath=ancestor::*[contains(@class, 'react-flow__node')][1]")
  const storyFrameNode = page
    .locator('.page-frame[data-route="/story/"]')
    .locator("xpath=ancestor::*[contains(@class, 'react-flow__node')][1]")
  const frameGap = async () => {
    const [menuTransform, storyTransform] = await Promise.all(
      [menuFrameNode, storyFrameNode].map((node) =>
        node.evaluate(
          (element) => new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform).m42,
        ),
      ),
    )
    return storyTransform - menuTransform
  }

  const viewportControl = page.getByRole("combobox", { name: "Viewport breakpoint" })
  await viewportControl.selectOption("sm")
  await expect(menuFrame).toHaveCSS("height", "1600px")
  await expect
    .poll(() => menuFrameNode.evaluate((node) => (node as HTMLElement).offsetHeight))
    .toBe(1_644)
  const initialFrameGap = await frameGap()

  await viewportControl.selectOption("md")

  await expect(menuFrame).toHaveCSS("height", "900px")
  await expect(
    page.locator('.page-frame[data-route="/menu/"] .page-frame__interaction-surface'),
  ).toHaveCSS("height", "900px")
  await expect
    .poll(() => menuFrameNode.evaluate((node) => (node as HTMLElement).offsetHeight))
    .toBe(944)
  await expect.poll(frameGap).toBeLessThanOrEqual(initialFrameGap - 700)
  await waitForViewportToSettle(page)
})

test("ignores a stale font measurement after the preview document is replaced", async ({
  page,
}) => {
  const browserProblems: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserProblems.push(message.text())
    }
  })
  page.on("pageerror", (error) => browserProblems.push(error.message))
  let resolveStaleFontReady: (() => void) | undefined
  const staleFontReady = new Promise<void>((resolve) => {
    resolveStaleFontReady = resolve
  })
  await page.exposeFunction("waitForStaleFontReady", () => staleFontReady)
  await page.exposeFunction("releaseStaleFontReady", () => {
    if (resolveStaleFontReady === undefined) {
      throw new Error("Expected the stale font promise resolver")
    }
    resolveStaleFontReady()
  })
  await page.addInitScript(() => {
    const frameWindow = globalThis as unknown as {
      waitForStaleFontReady?: () => Promise<void>
    }
    if (globalThis.location.pathname !== "/menu/") {
      return
    }

    const fontReady = frameWindow.waitForStaleFontReady?.().then(() => document.fonts)
    if (fontReady === undefined) {
      throw new Error("Expected the stale font promise binding")
    }
    Object.defineProperty(document.fonts, "ready", { configurable: true, value: fontReady })
  })

  await page.goto(`${baseUrl}/__splatpad/design/`)
  await expect(page.locator(".page-frame")).toHaveCount(13)
  await waitForCanvasReady(page)

  const menuFrame = preview(page, "/menu/")
  await menuFrame.evaluate(
    (iframe) =>
      new Promise<void>((resolve) => {
        iframe.addEventListener("load", () => resolve(), { once: true })
        ;(iframe as HTMLIFrameElement).srcdoc = `
          <style>html, body { margin: 0; } main { height: 2200px; }</style>
          <main id="replacement-document"></main>
        `
      }),
  )
  await expect(menuFrame).toHaveCSS("height", "2200px")
  await menuFrame.evaluate((iframe) => {
    const target = (iframe as HTMLIFrameElement).contentDocument?.querySelector<HTMLElement>(
      "#replacement-document",
    )
    if (target === null || target === undefined) {
      throw new Error("Expected the replacement document target")
    }
    target.style.height = "2500px"
  })

  await page.evaluate(async () => {
    const designerWindow = globalThis as unknown as {
      releaseStaleFontReady?: () => Promise<void>
    }
    const releaseFontBinding = designerWindow.releaseStaleFontReady
    if (releaseFontBinding === undefined) {
      throw new Error("Expected the stale font promise controller")
    }

    const requestFrame = globalThis.requestAnimationFrame.bind(globalThis)
    const cancelFrame = globalThis.cancelAnimationFrame.bind(globalThis)
    const queuedFrames = new Map<number, FrameRequestCallback>()
    let nextFrame = 1_000_000
    globalThis.requestAnimationFrame = (callback): number => {
      const frame = nextFrame++
      queuedFrames.set(frame, callback)
      return frame
    }
    globalThis.cancelAnimationFrame = (frame): void => {
      queuedFrames.delete(frame)
    }

    const viewportControl = document.querySelector<HTMLSelectElement>(
      '[aria-label="Viewport breakpoint"]',
    )
    if (viewportControl === null) {
      throw new Error("Expected the viewport control")
    }
    viewportControl.value = "md"
    viewportControl.dispatchEvent(new Event("change", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 50))
    await releaseFontBinding()
    await new Promise((resolve) => setTimeout(resolve, 0))

    globalThis.requestAnimationFrame = requestFrame
    globalThis.cancelAnimationFrame = cancelFrame
    for (const callback of queuedFrames.values()) {
      requestFrame(callback)
    }
  })

  await expect(menuFrame).toHaveCSS("height", "2500px")
  expect(browserProblems, "stale measurements must not emit browser errors").toEqual([])
})

test.describe("canvas tools", () => {
  let browserProblems: string[]

  test.beforeEach(async ({ page }) => {
    browserProblems = []
    page.on("console", (message) => {
      if (message.type() === "error") {
        browserProblems.push(message.text())
      }
    })
    page.on("pageerror", (error) => browserProblems.push(error.message))
    await page.goto(`${baseUrl}/__splatpad/design/`)
    await expect(page.locator(".page-frame")).toHaveCount(13)
    await waitForCanvasReady(page)
  })

  test.afterEach(() => {
    expect(browserProblems, "canvas scenarios must not emit browser errors").toEqual([])
  })

  test("Given Pan is the default, primary-dragging over a preview moves the canvas", async ({
    page,
  }) => {
    await expect(panTool(page)).toHaveAttribute("aria-pressed", "true")
    await expect(inspectTool(page)).toHaveAttribute("aria-pressed", "false")

    const before = await viewportPosition(page)
    await dragFrom(page, await visiblePreviewPoint(page, "pan"), { x: 84, y: 56 })

    await expect.poll(() => viewportPosition(page)).toEqual({ x: before.x + 84, y: before.y + 56 })
  })

  test("Given the toolbar, clicking tools and pressing V or I keeps one tool active", async ({
    page,
  }) => {
    await inspectTool(page).click()
    await expect(inspectTool(page)).toHaveAttribute("aria-pressed", "true")
    await expect(panTool(page)).toHaveAttribute("aria-pressed", "false")

    await page.keyboard.press("v")
    await expect(panTool(page)).toHaveAttribute("aria-pressed", "true")
    await expect(inspectTool(page)).toHaveAttribute("aria-pressed", "false")

    await page.keyboard.press("I")
    await expect(inspectTool(page)).toHaveAttribute("aria-pressed", "true")
    await expect(panTool(page)).toHaveAttribute("aria-pressed", "false")

    await panTool(page).click()
    await expect(panTool(page)).toHaveAttribute("aria-pressed", "true")
    await expect(inspectTool(page)).toHaveAttribute("aria-pressed", "false")
  })

  test("Given Inspect is active, selecting an element opens the sidebar with its exact className", async ({
    page,
  }) => {
    const inspectedRoot = page.frameLocator('iframe[title="/menu/"]').locator("html")
    const heading = page.frameLocator('iframe[title="/menu/"]').getByRole("heading", { level: 1 })
    const exactClassName = await heading.getAttribute("class")
    const inspectedDomBefore = await inspectedRoot.evaluate((element) => element.outerHTML)

    await inspectTool(page).click()
    await expect(inspector(page)).toHaveCount(0)
    await clickTarget(page, heading)

    await expectInspectorClassName(page, exactClassName ?? "")
    await expect.poll(() => visibleOutlineCount(page, "rgb(124, 58, 237)")).toBe(1)
    expect(await inspectedRoot.evaluate((element) => element.outerHTML)).toBe(inspectedDomBefore)
  })

  test("Given two previews, selecting in the second replaces the global selection from the first", async ({
    page,
  }) => {
    const menuHeading = page
      .frameLocator('iframe[title="/menu/"]')
      .getByRole("heading", { level: 1 })
    const storyHeading = page
      .frameLocator('iframe[title="/story/"]')
      .getByRole("heading", { level: 1 })
    const storyClassName = await storyHeading.getAttribute("class")

    await page.keyboard.press("i")
    await clickTarget(page, menuHeading)
    await page
      .locator('.page-frame[data-route="/story/"] .page-frame__interaction-surface')
      .evaluate((surface) => {
        const counts: number[] = []
        Object.assign(globalThis, { transitionVisibleSelectionCounts: counts })
        surface.addEventListener("pointerup", () => {
          counts.push(
            [
              ...surface.ownerDocument.querySelectorAll(
                '[data-splatpad-inspector-overlay="selected"]',
              ),
            ].filter((overlay) => globalThis.getComputedStyle(overlay).display !== "none").length,
          )
        })
      })
    const storyPoint = await centerOf(storyHeading)
    await page
      .locator('.page-frame[data-route="/story/"] .page-frame__interaction-surface')
      .evaluate((surface, point) => {
        const view = surface.ownerDocument.defaultView!
        for (const type of ["pointerdown", "pointerup"] as const) {
          surface.dispatchEvent(
            new view.PointerEvent(type, {
              bubbles: true,
              button: 0,
              buttons: type === "pointerdown" ? 1 : 0,
              cancelable: true,
              clientX: point.x,
              clientY: point.y,
              pointerId: 9191,
            }),
          )
        }
      }, storyPoint)

    await expectInspectorClassName(page, storyClassName ?? "")
    expect(
      await page.evaluate(
        () =>
          (globalThis as typeof globalThis & { transitionVisibleSelectionCounts: number[] })
            .transitionVisibleSelectionCounts,
      ),
    ).toEqual([1])
    await expect.poll(() => visibleOutlineCount(page, "rgb(124, 58, 237)")).toBe(1)
  })

  test("Given a selection, Escape, empty canvas, Pan, and target removal each clear it", async ({
    page,
  }) => {
    const site = page.frameLocator('iframe[title="/menu/"]')
    const heading = site.getByRole("heading", { level: 1 })
    await page.keyboard.press("i")

    await clickTarget(page, heading)
    await page.keyboard.press("Escape")
    await expect(inspector(page)).toHaveCount(0)

    await clickTarget(page, heading)
    await page.locator(".react-flow__pane").click({ position: { x: 8, y: 8 } })
    await expect(inspector(page)).toHaveCount(0)

    await clickTarget(page, heading)
    await panTool(page).click()
    await expect(inspector(page)).toHaveCount(0)

    await inspectTool(page).click()
    await site.locator("body").evaluate((body) => {
      const target = body.ownerDocument.createElement("aside")
      target.id = "temporary-selection"
      target.className = "temporary target"
      target.textContent = "Temporary selection"
      target.style.cssText =
        "position:fixed;inset:8px auto auto 8px;z-index:9999;padding:12px;background:white"
      body.append(target)
    })
    const temporary = site.getByText("Temporary selection")
    const temporaryPoint = await exposedPointOf(page, "/menu/", "#temporary-selection")
    await page.mouse.click(temporaryPoint.x, temporaryPoint.y)
    await expectInspectorClassName(page, "temporary target")
    await temporary.evaluate((element) => element.remove())
    await expect(inspector(page)).toHaveCount(0)
  })

  test("Given page actions and pre-existing capture handlers, inspection selects without activating them", async ({
    page,
  }) => {
    const site = page.frameLocator('iframe[title="/menu/"]')
    await site.locator("body").evaluate((body) => {
      const document = body.ownerDocument
      const view = document.defaultView
      if (view === null) {
        throw new Error("Expected an iframe window")
      }
      const counts = { document: 0, form: 0, state: 0, window: 0 }
      Object.assign(view, { actionCounts: counts })
      view.addEventListener("pointerdown", () => counts.window++, true)
      document.addEventListener("pointerdown", () => counts.document++, true)

      const controls = document.createElement("section")
      controls.style.cssText =
        "position:fixed;inset:8px auto auto 8px;z-index:9999;display:grid;gap:8px;padding:8px;background:white"
      const link = document.createElement("a")
      link.id = "action-link"
      link.className = "action-link"
      link.href = "/story/"
      link.textContent = "Action link"

      const button = document.createElement("button")
      button.id = "state-button"
      button.className = "state-button"
      button.textContent = "State unchanged"
      button.addEventListener("click", () => {
        counts.state++
        button.textContent = "State changed"
      })

      const form = document.createElement("form")
      form.id = "state-form"
      form.className = "state-form"
      form.action = "/story/"
      form.addEventListener("submit", () => counts.form++)
      const submit = document.createElement("button")
      submit.id = "submit-action"
      submit.type = "submit"
      submit.textContent = "Submit action"
      form.append(submit)
      controls.append(link, button, form)
      body.append(controls)
    })

    await page.keyboard.press("i")
    const linkPoint = await exposedPointOf(page, "/menu/", "#action-link")
    await dragFrom(page, linkPoint, { x: 18, y: 0 })
    await expect(inspector(page)).toHaveCount(0)
    await page
      .locator('.page-frame[data-route="/menu/"] .page-frame__interaction-surface')
      .evaluate((surface, point) => {
        const view = surface.ownerDocument.defaultView
        if (view === null) {
          throw new Error("Expected a designer window")
        }
        const pointerId = 6161
        for (const type of ["pointerdown", "pointercancel", "pointerup"] as const) {
          surface.dispatchEvent(
            new view.PointerEvent(type, {
              bubbles: true,
              button: 0,
              buttons: type === "pointerdown" ? 1 : 0,
              cancelable: true,
              clientX: point.x,
              clientY: point.y,
              pointerId,
            }),
          )
        }
      }, linkPoint)
    await expect(inspector(page)).toHaveCount(0)
    await page.mouse.click(linkPoint.x, linkPoint.y)
    await expectInspectorClassName(page, "action-link")
    const buttonPoint = await exposedPointOf(page, "/menu/", "#state-button")
    await page.mouse.click(buttonPoint.x, buttonPoint.y)
    await expectInspectorClassName(page, "state-button")
    const submitPoint = await exposedPointOf(page, "/menu/", "#submit-action")
    await page.mouse.click(submitPoint.x, submitPoint.y)

    await expect(site.getByRole("button", { name: "State unchanged" })).toBeVisible()
    await expect
      .poll(() => site.locator("body").evaluate(() => globalThis.location.pathname))
      .toBe("/menu/")
    await expect
      .poll(() =>
        site.locator("body").evaluate(() => {
          const counts = (
            globalThis as typeof globalThis & {
              actionCounts: { document: number; form: number; state: number; window: number }
            }
          ).actionCounts
          return counts
        }),
      )
      .toEqual({ document: 0, form: 0, state: 0, window: 0 })
  })

  test("regression: pointer-up beyond the click threshold does not select without pointer movement", async ({
    page,
  }) => {
    const site = page.frameLocator('iframe[title="/menu/"]')
    await site.locator("body").evaluate((body) => {
      const target = body.ownerDocument.createElement("div")
      target.id = "large-inspection-target"
      target.className = "large-inspection-target"
      target.style.cssText = "position:fixed;inset:0;z-index:9999;background:white"
      body.append(target)
    })

    await page.keyboard.press("i")
    await page
      .locator('.page-frame[data-route="/menu/"] .page-frame__interaction-surface')
      .evaluate((surface) => {
        const view = surface.ownerDocument.defaultView
        if (view === null) {
          throw new Error("Expected a designer window")
        }
        const bounds = surface.getBoundingClientRect()
        const pointerId = 7171
        surface.dispatchEvent(
          new view.PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            buttons: 1,
            cancelable: true,
            clientX: bounds.left + 40,
            clientY: bounds.top + 40,
            pointerId,
          }),
        )
        surface.dispatchEvent(
          new view.PointerEvent("pointerup", {
            bubbles: true,
            button: 0,
            buttons: 0,
            cancelable: true,
            clientX: bounds.left + 52,
            clientY: bounds.top + 40,
            pointerId,
          }),
        )
      })

    await expect(inspector(page)).toHaveCount(0)
    await expect.poll(() => visibleOutlineCount(page, "rgb(124, 58, 237)")).toBe(0)
  })

  test("Given Inspect is active, wheel gestures navigate the canvas in their requested direction", async ({
    page,
  }) => {
    await page.keyboard.press("i")
    const before = await viewportPosition(page)
    const center = await visiblePreviewPoint(page, "pan")
    await page.mouse.move(center.x, center.y)
    await page.mouse.wheel(70, 110)

    await expect
      .poll(async () => {
        const after = await viewportPosition(page)
        return { left: after.x < before.x, up: after.y < before.y }
      })
      .toEqual({ left: true, up: true })
  })

  test("Given Inspect is active, Space temporarily pans and blur restores inspection", async ({
    page,
  }) => {
    await page.keyboard.press("i")
    const before = await viewportPosition(page)
    const interactionSurface = page.locator(
      '.page-frame[data-route="/menu/"] .page-frame__interaction-surface',
    )

    await page.keyboard.down("Space")
    await expect(interactionSurface).toHaveCSS("pointer-events", "none")
    const panPoint = await visiblePreviewPoint(page, "pan")
    await dragFrom(page, panPoint, { x: 72, y: 48 })
    await page.keyboard.up("Space")

    await expect.poll(() => viewportPosition(page)).toEqual({ x: before.x + 72, y: before.y + 48 })
    await expect(inspectTool(page)).toHaveAttribute("aria-pressed", "true")

    await page.keyboard.down("Space")
    await expect(interactionSurface).toHaveCSS("pointer-events", "none")
    await page.evaluate(() => globalThis.dispatchEvent(new Event("blur")))
    await expect(interactionSurface).toHaveCSS("pointer-events", "auto")
    const headingPoint = await exposedPointOf(page, "/menu/", "h1")
    await page.mouse.click(headingPoint.x, headingPoint.y)
    await expect(inspector(page)).toBeVisible()
    await expect(inspectTool(page)).toHaveAttribute("aria-pressed", "true")
    await page.keyboard.up("Space")
  })

  test("Given either tool, middle-drag pans and movement after release does not", async ({
    page,
  }) => {
    const expectMiddlePan = async (tool: "inspect" | "pan"): Promise<void> => {
      await (tool === "inspect" ? inspectTool(page) : panTool(page)).click()
      if (tool === "inspect") {
        await waitForInspectReady(page)
      } else {
        await expect(panTool(page)).toHaveAttribute("aria-pressed", "true")
      }
      const start = await visiblePreviewPoint(page, tool)
      const before = await viewportPosition(page)
      await dragFrom(page, start, { x: 64, y: 44 }, "middle")
      await expect
        .poll(() => viewportPosition(page))
        .toEqual({ x: before.x + 64, y: before.y + 44 })

      const released = await viewportPosition(page)
      await page.mouse.move(start.x + 130, start.y + 110, { steps: 8 })
      await expect.poll(() => viewportPosition(page)).toEqual(released)
    }

    await expectMiddlePan("pan")
    await expectMiddlePan("inspect")
  })

  test("Given repeated hits, rapid clicks climb ancestors while timeout and a different target reset", async ({
    page,
  }) => {
    const site = page.frameLocator('iframe[title="/menu/"]')
    const heading = site.getByRole("heading", { level: 1 })
    const paragraph = site.getByText("Made in small batches")
    const classes = await heading.evaluate((element) => [
      element.getAttribute("class") ?? "",
      element.parentElement?.getAttribute("class") ?? "",
      element.parentElement?.parentElement?.getAttribute("class") ?? "",
    ])
    const paragraphClass = await paragraph.getAttribute("class")

    await page.keyboard.press("i")
    await waitForInspectReady(page)
    await clickTarget(page, heading)
    await expectInspectorClassName(page, classes[0])

    await page.waitForTimeout(550)
    await clickTarget(page, heading)
    await clickTarget(page, heading)
    await expectInspectorClassName(page, classes[1])

    await page.waitForTimeout(550)
    await clickTarget(page, heading)
    await clickTarget(page, heading)
    await clickTarget(page, heading)
    await expectInspectorClassName(page, classes[2])

    await page.waitForTimeout(550)
    await clickTarget(page, heading)
    await expectInspectorClassName(page, classes[0])

    await page.waitForTimeout(550)
    await clickTarget(page, heading)
    await clickTarget(page, heading)
    await expectInspectorClassName(page, classes[1])
    await clickTarget(page, paragraph)
    await expectInspectorClassName(page, paragraphClass ?? "")
    await clickTarget(page, heading)
    await expectInspectorClassName(page, classes[0])
  })

  test("Given a full-width selection, its four-edge outline stays below floating full-height controls", async ({
    page,
  }) => {
    const canvasBefore = await page.locator(".react-flow").boundingBox()
    await preview(page, "/menu/").evaluate((iframe) => {
      const document = (iframe as HTMLIFrameElement).contentDocument!
      const target = document.createElement("div")
      target.id = "full-width-target"
      target.style.cssText =
        "position:fixed;z-index:9999;inset:180px 0 auto;height:24px;background:white"
      document.body.append(target)
    })
    await page.keyboard.press("i")
    const headerPoint = await exposedPointOf(page, "/menu/", "#full-width-target")
    await page.mouse.click(headerPoint.x, headerPoint.y)
    await expect(inspector(page)).toBeVisible()

    await expect
      .poll(() => outlineSnapshot(page, "/menu/", "#full-width-target", "rgb(124, 58, 237)"))
      .toMatchObject({ alignmentGaps: [0, 0, 0, 0] })
    const snapshot = await outlineSnapshot(
      page,
      "/menu/",
      "#full-width-target",
      "rgb(124, 58, 237)",
    )
    expect(snapshot.alignmentGaps).toEqual([0, 0, 0, 0])
    expect(snapshot.borderStyles).toEqual(["solid", "solid", "solid", "solid"])
    expect(snapshot.borderWidths).toEqual(["2px", "2px", "2px", "2px"])
    expect(snapshot.display).toBe("block")
    expect(snapshot.pointerEvents).toBe("none")
    expect(snapshot.withinFrame).toBe(true)
    const controlLayers = await Promise.all(
      [page.getByRole("navigation", { name: "Canvas tools" }), inspector(page)].map((element) =>
        element.evaluate((target) => Number(globalThis.getComputedStyle(target).zIndex)),
      ),
    )
    expect(controlLayers.every((zIndex) => zIndex > snapshot.zIndex)).toBe(true)

    await expect(inspector(page)).toHaveCSS("top", "16px")
    await expect(inspector(page)).toHaveCSS("bottom", "16px")
    expect(await page.locator(".react-flow").boundingBox()).toEqual(canvasBefore)
  })

  test("regression: iframe panning ignores bogus screen coordinates", async ({ page }) => {
    await page.keyboard.press("i")
    const surface = page.locator(
      '.page-frame[data-route="/menu/"] .page-frame__interaction-surface',
    )
    const before = await viewportPosition(page)
    await surface.evaluate((element) => {
      const view = element.ownerDocument.defaultView
      if (view === null) {
        throw new Error("Expected a designer window")
      }
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
            clientX: clientX + 18,
            clientY: clientY + 12,
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
            clientX: clientX + 18,
            clientY: clientY + 12,
            pointerId: 4242,
          }),
        )
      } finally {
        capture.setPointerCapture = methods.setPointerCapture
        capture.hasPointerCapture = methods.hasPointerCapture
        capture.releasePointerCapture = methods.releasePointerCapture
      }
    })
    await expect.poll(() => viewportPosition(page)).toEqual({ x: before.x + 18, y: before.y + 12 })
  })

  test("regression: every interrupted middle-pan path ends iframe panning safely", async ({
    page,
  }) => {
    await page.keyboard.press("i")
    const surface = page.locator(
      '.page-frame[data-route="/menu/"] .page-frame__interaction-surface',
    )
    const beforeFailure = await viewportPosition(page)
    await surface.evaluate((element) => {
      const view = element.ownerDocument.defaultView
      if (view === null) {
        throw new Error("Expected a designer window")
      }
      const capture = element as Element & { setPointerCapture: (pointerId: number) => void }
      const original = capture.setPointerCapture
      capture.setPointerCapture = () => {
        throw new DOMException("Synthetic pointer capture failure", "InvalidStateError")
      }
      try {
        for (const [type, clientX, clientY] of [
          ["pointerdown", 20, 20],
          ["pointermove", 70, 70],
          ["pointerup", 70, 70],
        ] as const) {
          element.dispatchEvent(
            new view.PointerEvent(type, {
              bubbles: true,
              button: type === "pointerdown" || type === "pointerup" ? 1 : -1,
              buttons: type === "pointerup" ? 0 : 4,
              cancelable: true,
              clientX,
              clientY,
              pointerId: 4141,
            }),
          )
        }
      } finally {
        capture.setPointerCapture = original
      }
    })
    await expect.poll(() => viewportPosition(page)).toEqual(beforeFailure)

    const beforeLoss = await viewportPosition(page)
    await surface.evaluate((element) => {
      const view = element.ownerDocument.defaultView
      if (view === null) {
        throw new Error("Expected a designer window")
      }
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
      const pointerId = 4343
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
            pointerId,
          }),
        )
        element.dispatchEvent(
          new view.PointerEvent("pointermove", {
            bubbles: true,
            button: -1,
            buttons: 4,
            cancelable: true,
            clientX: clientX + 13,
            clientY: clientY + 9,
            pointerId,
          }),
        )
        element.dispatchEvent(
          new view.PointerEvent("lostpointercapture", { bubbles: true, pointerId }),
        )
        element.dispatchEvent(
          new view.PointerEvent("pointermove", {
            bubbles: true,
            button: -1,
            buttons: 4,
            clientX: clientX + 71,
            clientY: clientY + 63,
            pointerId,
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
        const after = await viewportPosition(page)
        return { x: Math.round(after.x - beforeLoss.x), y: Math.round(after.y - beforeLoss.y) }
      })
      .toEqual({ x: 13, y: 9 })

    const expectInterruptedPan = async (interruption: "blur" | "pointercancel"): Promise<void> => {
      const before = await viewportPosition(page)
      await surface.evaluate((element, interruptionType) => {
        const view = element.ownerDocument.defaultView
        if (view === null) {
          throw new Error("Expected a designer window")
        }
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
        const pointerId = interruptionType === "blur" ? 4545 : 4444
        const bounds = element.getBoundingClientRect()
        const clientX = bounds.left + bounds.width / 2
        const clientY = bounds.top + bounds.height / 2
        const pointer = (type: string, x: number, y: number, buttons: number): void => {
          element.dispatchEvent(
            new view.PointerEvent(type, {
              bubbles: true,
              button: type === "pointerdown" ? 1 : -1,
              buttons,
              cancelable: true,
              clientX: x,
              clientY: y,
              pointerId,
            }),
          )
        }
        try {
          pointer("pointerdown", clientX, clientY, 4)
          pointer("pointermove", clientX + 11, clientY + 7, 4)
          if (interruptionType === "pointercancel") {
            pointer("pointercancel", clientX + 11, clientY + 7, 0)
          } else {
            view.dispatchEvent(new Event("blur"))
          }
          pointer("pointermove", clientX + 81, clientY + 67, 4)
        } finally {
          capture.setPointerCapture = methods.setPointerCapture
          capture.hasPointerCapture = methods.hasPointerCapture
          capture.releasePointerCapture = methods.releasePointerCapture
        }
      }, interruption)
      await expect
        .poll(async () => {
          const after = await viewportPosition(page)
          return { x: Math.round(after.x - before.x), y: Math.round(after.y - before.y) }
        })
        .toEqual({ x: 11, y: 7 })
    }

    await expectInterruptedPan("pointercancel")
    await expectInterruptedPan("blur")
  })

  test("regression: transformed page CSS cannot displace or restyle an outline", async ({
    page,
  }) => {
    const site = page.frameLocator('iframe[title="/menu/"]')
    const heading = site.getByRole("heading", { level: 1 })
    await page.keyboard.press("i")
    await site.locator("head").evaluate((head) => {
      const style = head.ownerDocument.createElement("style")
      style.textContent = `
        html { filter: opacity(.999); transform: translate(23px, 29px) scale(.97); transform-origin: 0 0; }
        [aria-hidden="true"] { display: none !important; }
        div { border: 11px dashed red !important; box-sizing: content-box !important; margin: 17px !important; transform: translate(23px, 29px) !important; }
      `
      head.append(style)
    })
    await hoverTarget(page, heading)

    await expect
      .poll(() => outlineSnapshot(page, "/menu/", "h1", "rgb(37, 99, 235)"))
      .toMatchObject({
        alignmentGaps: [0, 0, 0, 0],
        borderStyles: ["solid", "solid", "solid", "solid"],
        borderWidths: ["2px", "2px", "2px", "2px"],
        display: "block",
        pointerEvents: "none",
        withinFrame: true,
      })
  })

  test("regression: a selected outline continuously follows a moving target", async ({ page }) => {
    const heading = page.frameLocator('iframe[title="/menu/"]').getByRole("heading", { level: 1 })
    await page.keyboard.press("i")
    await clickTarget(page, heading)
    const before = await outlineSnapshot(page, "/menu/", "h1", "rgb(124, 58, 237)")

    await heading.evaluate((element) => {
      const target = element as HTMLElement
      target.style.setProperty("left", "61px", "important")
      target.style.setProperty("position", "relative", "important")
      target.style.setProperty("top", "37px", "important")
    })

    await expect
      .poll(() => outlineSnapshot(page, "/menu/", "h1", "rgb(124, 58, 237)"))
      .toMatchObject({ alignmentGaps: [0, 0, 0, 0] })
    expect(before.alignmentGaps).toEqual([0, 0, 0, 0])
  })
})
