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
            Math.abs(bounds.top - expected.top) < 0.05
              ? 0
              : Math.round((bounds.top - expected.top) * 10) / 10,
            Math.abs(bounds.right - expected.right) < 0.05
              ? 0
              : Math.round((bounds.right - expected.right) * 10) / 10,
            Math.abs(bounds.bottom - expected.bottom) < 0.05
              ? 0
              : Math.round((bounds.bottom - expected.bottom) * 10) / 10,
            Math.abs(bounds.left - expected.left) < 0.05
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
  await expect(inspector).toHaveText(headingClassName ?? "")
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

  const disconnectedTarget = site.locator("#disconnected-inspection-target")
  await site.locator("body").evaluate((body) => {
    const target = body.ownerDocument.createElement("aside")
    target.id = "disconnected-inspection-target"
    target.className = "disconnected-selection"
    target.textContent = "Temporary target"
    body.append(target)
  })
  await disconnectedTarget.hover({ force: true })
  await disconnectedTarget.click({ force: true })
  await expect(inspector).toHaveText("disconnected-selection")
  await expect(selectedOverlay).toHaveCSS("display", "block")
  await disconnectedTarget.evaluate((element) => element.remove())
  await expect(inspector).toHaveCount(0)
  await expect(selectedOverlay).toHaveCSS("display", "none")
  await heading.hover({ force: true })
  await expect(heading).toHaveAttribute("data-splatpad-inspector-hover", "")
  await expect.poll(() => overlaySnapshot("hover", "h1")).toMatchObject({ display: "block" })
  await heading.click({ force: true })
  await expect(inspector).toHaveText(headingClassName ?? "")

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
  await expect(inspector).toHaveText(headingClassName ?? "")
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
  await expect(inspector).toHaveText(headingClassName ?? "")
  await expect(heading).toHaveAttribute("data-splatpad-inspector-selected", "")

  await page.waitForTimeout(550)
  await heading.click({ force: true })
  await expect(inspector).toHaveText(headingClassName ?? "")
  await expect(heading).toHaveAttribute("data-splatpad-inspector-selected", "")

  await heading.click({ force: true })
  await expect(inspector).toHaveText(parentClassName)

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
