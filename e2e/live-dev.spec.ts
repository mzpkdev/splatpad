import * as fs from "node:fs/promises"
import * as http from "node:http"
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

test("switches to the discovered component catalog", async ({ page }) => {
  const browserProblems: string[] = []
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type())) {
      browserProblems.push(message.text())
    }
  })
  page.on("pageerror", (error) => browserProblems.push(error.message))
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await page.evaluate(() => {
    const testWindow = globalThis as unknown as {
      splatpadMeasurementProbeSandboxes: string[]
      splatpadProbeScriptRan: boolean
      splatpadRootBackgroundScriptRuns: number
    }
    testWindow.splatpadMeasurementProbeSandboxes = []
    testWindow.splatpadProbeScriptRan = false
    testWindow.splatpadRootBackgroundScriptRuns = 0
    new MutationObserver((records) => {
      for (const record of records) {
        for (const addedNode of record.addedNodes) {
          if (!(addedNode instanceof HTMLElement)) {
            continue
          }
          const probes = addedNode.matches("iframe[data-splatpad-measurement-probe]")
            ? [addedNode]
            : [...addedNode.querySelectorAll("iframe[data-splatpad-measurement-probe]")]
          for (const probe of probes) {
            testWindow.splatpadMeasurementProbeSandboxes.push(
              (probe as HTMLIFrameElement).getAttribute("sandbox") ?? "",
            )
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true })
  })
  await preview(page, "/").evaluate((iframe) => {
    const document = (iframe as HTMLIFrameElement).contentDocument
    if (document?.body === null || document?.body === undefined) {
      throw new Error("Expected the rendered root document")
    }
    const style = document.createElement("style")
    style.textContent = `
      body.runtime-root-theme { background-color: rgb(250, 250, 248) !important; }
      @media (min-width: 768px) {
        body.runtime-root-theme { background-color: rgb(8, 12, 20) !important; }
      }
    `
    const script = document.createElement("script")
    script.textContent = `
      parent.splatpadRootBackgroundScriptRuns += 1
      document.body.classList.add("runtime-root-theme")
    `
    document.head.append(style, script)
  })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as { splatpadRootBackgroundScriptRuns: number })
            .splatpadRootBackgroundScriptRuns,
      ),
    )
    .toBe(1)
  await page.getByRole("button", { name: "Components", exact: true }).click()

  await expect(page.locator(".page-frame")).toHaveCount(13)
  await expect(page.locator(".page-frame--component")).toHaveCount(13)
  await expect(page.locator(".page-frame--component iframe")).toHaveCount(13)
  await expect(page.locator('[data-component-group=""]')).toContainText("Root components")
  await expect(page.getByRole("button", { name: "button", exact: true })).toBeVisible()
  await expect(
    page.locator('.page-frame[data-route="/__splatpad/design/components/button/"]'),
  ).toBeVisible()
  await expect(
    page
      .frameLocator('iframe[title="/__splatpad/design/components/button/"]')
      .getByRole("button", { name: "Order now" }),
  ).toBeVisible()
  await expect(page.locator(".designer-footer")).toContainText("13 components")
  await expect(page.locator(".page-frame--component").first()).toHaveCSS(
    "border-top-style",
    "dashed",
  )
  await expect(page.locator(".page-frame--component").first()).toHaveCSS("box-shadow", "none")
  await expect
    .poll(() =>
      page.locator(".page-frame--component").evaluateAll((frames) =>
        frames.every((frame) => {
          const width = (frame as HTMLElement).offsetWidth
          return width >= 239 && width <= 721
        }),
      ),
    )
    .toBe(true)
  const viewportControl = page.getByRole("combobox", { name: "Viewport breakpoint" })
  await viewportControl.selectOption("md")
  await expect
    .poll(() =>
      page
        .locator(".page-frame--component iframe")
        .evaluateAll((frames) =>
          frames.every((frame) => (frame as HTMLElement).offsetWidth === 768),
        ),
    )
    .toBe(true)
  await viewportControl.selectOption("Default")

  const alertFrame = page.locator('.page-frame[data-route="/__splatpad/design/components/alert/"]')
  const initialAlertHeight = await alertFrame.evaluate(
    (frame) => (frame as HTMLElement).offsetHeight,
  )
  const initialAlertWidth = await alertFrame.evaluate((frame) => (frame as HTMLElement).offsetWidth)
  await page
    .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
    .locator("body")
    .evaluate((body) => {
      body.setAttribute("onload", "parent.splatpadProbeScriptRan = true")
      const root = body.querySelector<HTMLElement>('[data-frame="Alert variants"]')
      if (root === null) {
        throw new Error("Expected the alert component root")
      }
      root.style.position = "relative"
      const flyout = body.ownerDocument.createElement("div")
      flyout.dataset.measurementFlyout = ""
      flyout.style.height = "24px"
      flyout.style.left = "300px"
      flyout.style.position = "absolute"
      flyout.style.top = "400px"
      flyout.style.width = "80px"
      root.append(flyout)
    })
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetHeight))
    .toBeGreaterThan(initialAlertHeight + 180)
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetWidth))
    .toBeGreaterThan(400)
  await expect
    .poll(() =>
      page
        .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
        .locator("body")
        .evaluate((body) => {
          const flyout = body.querySelector<HTMLElement>("[data-measurement-flyout]")
          return (
            flyout?.parentElement?.matches('[data-frame="Alert variants"]') === true &&
            flyout.getBoundingClientRect().right <= body.clientWidth
          )
        }),
    )
    .toBe(true)
  const offsetAlertHeight = await alertFrame.evaluate(
    (frame) => (frame as HTMLElement).offsetHeight,
  )
  const offsetAlertWidth = await alertFrame.evaluate((frame) => (frame as HTMLElement).offsetWidth)
  const probesBeforeMutationBurst = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          splatpadMeasurementProbeSandboxes: string[]
        }
      ).splatpadMeasurementProbeSandboxes.length,
  )
  await page
    .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
    .locator("[data-measurement-flyout]")
    .evaluate((flyout) => {
      const element = flyout as HTMLElement
      element.style.left = "530px"
      element.style.top = "590px"
      const testWindow = globalThis as unknown as {
        splatpadContinuousMutationCount: number
        splatpadContinuousMutationTimer: ReturnType<typeof setInterval>
      }
      testWindow.splatpadContinuousMutationCount = 0
      testWindow.splatpadContinuousMutationTimer = globalThis.setInterval(() => {
        testWindow.splatpadContinuousMutationCount += 1
        element.dataset.continuousMutation = `${testWindow.splatpadContinuousMutationCount}`
      }, 50)
    })
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetHeight))
    .toBeGreaterThan(offsetAlertHeight + 120)
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetWidth))
    .toBeGreaterThan(offsetAlertWidth + 120)
  const continuousMutationsBeforeWait = await page
    .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
    .locator("body")
    .evaluate(
      () =>
        (globalThis as unknown as { splatpadContinuousMutationCount: number })
          .splatpadContinuousMutationCount,
    )
  await page.waitForTimeout(150)
  await expect
    .poll(() =>
      page
        .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
        .locator("body")
        .evaluate(
          () =>
            (globalThis as unknown as { splatpadContinuousMutationCount: number })
              .splatpadContinuousMutationCount,
        ),
    )
    .toBeGreaterThan(continuousMutationsBeforeWait)
  await page
    .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
    .locator("body")
    .evaluate(() => {
      const testWindow = globalThis as unknown as {
        splatpadContinuousMutationTimer: ReturnType<typeof setInterval>
      }
      globalThis.clearInterval(testWindow.splatpadContinuousMutationTimer)
    })
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as unknown as {
              splatpadMeasurementProbeSandboxes: string[]
            }
          ).splatpadMeasurementProbeSandboxes.length,
      ),
    )
    .toBeLessThanOrEqual(probesBeforeMutationBurst + 2)
  await page
    .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
    .locator("[data-measurement-flyout]")
    .evaluate((flyout) => flyout.remove())
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetHeight))
    .toBeLessThan(initialAlertHeight + 10)
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetWidth))
    .toBeLessThan(initialAlertWidth + 10)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as unknown as {
              splatpadMeasurementProbeSandboxes: string[]
            }
          ).splatpadMeasurementProbeSandboxes,
      ),
    )
    .toContain("allow-same-origin")
  expect(
    await page.evaluate(
      () => (globalThis as unknown as { splatpadProbeScriptRan: boolean }).splatpadProbeScriptRan,
    ),
  ).toBe(false)

  await page
    .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
    .locator("body")
    .evaluate((body) => {
      const root = body.querySelector<HTMLElement>('[data-frame="Alert variants"]')
      if (root === null) {
        throw new Error("Expected the alert component root")
      }
      const style = body.ownerDocument.createElement("style")
      style.dataset.measurementPseudo = ""
      style.textContent = `
        [data-frame="Alert variants"].measurement-pseudo::after {
          content: "";
          height: 24px;
          left: 360px;
          position: absolute;
          top: 360px;
          transform: translate(100px, 80px) rotate(90deg);
          transform-origin: 0 0;
          width: 96px;
        }
        [data-frame="Alert variants"].measurement-pseudo.measurement-pseudo--expanded::after {
          transform: translate(300px, 260px) rotate(45deg);
          transform-origin: 48px 12px;
        }
      `
      body.ownerDocument.head.append(style)
      root.classList.add("measurement-pseudo")
    })
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetHeight))
    .toBeGreaterThan(initialAlertHeight + 220)
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetWidth))
    .toBeGreaterThan(470)
  const transformedPseudoHeight = await alertFrame.evaluate(
    (frame) => (frame as HTMLElement).offsetHeight,
  )
  const transformedPseudoWidth = await alertFrame.evaluate(
    (frame) => (frame as HTMLElement).offsetWidth,
  )
  await page
    .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
    .locator('[data-frame="Alert variants"]')
    .evaluate((root) => root.classList.add("measurement-pseudo--expanded"))
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetHeight))
    .toBeGreaterThan(transformedPseudoHeight + 100)
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetWidth))
    .toBeGreaterThan(transformedPseudoWidth + 100)
  await page
    .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
    .locator('[data-frame="Alert variants"]')
    .evaluate((root) => root.classList.remove("measurement-pseudo--expanded"))
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetHeight))
    .toBeLessThan(transformedPseudoHeight + 10)
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetWidth))
    .toBeLessThan(transformedPseudoWidth + 10)
  await page
    .frameLocator('iframe[title="/__splatpad/design/components/alert/"]')
    .locator('[data-frame="Alert variants"]')
    .evaluate((root) => root.classList.remove("measurement-pseudo"))
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetHeight))
    .toBeLessThan(initialAlertHeight + 10)
  await expect
    .poll(() => alertFrame.evaluate((frame) => (frame as HTMLElement).offsetWidth))
    .toBeLessThan(initialAlertWidth + 10)
  await expect
    .poll(() =>
      page.locator(".designer-canvas").evaluate((canvas) => {
        const sampler = canvas.querySelector<HTMLIFrameElement>(
          ".designer-canvas__background-sampler",
        )
        const surface = canvas.querySelector<HTMLElement>(".component-catalog-surface")
        const body = sampler?.contentDocument?.body
        if (body === null || body === undefined || surface === null) {
          return false
        }
        return (
          getComputedStyle(surface).backgroundColor ===
          sampler?.contentWindow?.getComputedStyle(body).backgroundColor
        )
      }),
    )
    .toBe(true)
  await expect(page.locator(".designer-canvas")).not.toHaveClass(/designer-canvas--dark/)
  await expect(page.locator(".designer-canvas")).toHaveAttribute(
    "data-canvas-background",
    "rgb(250, 250, 248)",
  )
  expect(
    await page.evaluate(
      () =>
        (globalThis as unknown as { splatpadRootBackgroundScriptRuns: number })
          .splatpadRootBackgroundScriptRuns,
    ),
  ).toBe(1)
  await expect(page.locator(".designer-canvas__background-sampler")).toHaveAttribute(
    "sandbox",
    "allow-same-origin",
  )
  await page.locator(".designer-canvas__background-sampler").evaluate((element) => {
    const sampler = element as HTMLIFrameElement
    const document = sampler.contentDocument
    if (document?.body === null || document?.body === undefined) {
      throw new Error("Expected the background sampler document")
    }
    const style = document.createElement("style")
    style.textContent = `
      body { background-color: rgb(250, 250, 248) !important; }
      @media (min-width: 768px) {
        body { background-color: rgb(8, 12, 20) !important; }
      }
    `
    document.head.append(style)
    ;(globalThis as unknown as { splatpadSamplerScriptRan: boolean }).splatpadSamplerScriptRan =
      false
    document.body.setAttribute("onclick", "top.splatpadSamplerScriptRan = true")
    document.body.dispatchEvent(new MouseEvent("click", { bubbles: true }))
    const nestedFrame = document.createElement("iframe")
    nestedFrame.dataset.sandboxCheck = ""
    nestedFrame.srcdoc = '<body onload="top.splatpadSamplerScriptRan = true"></body>'
    document.body.append(nestedFrame)
  })
  await expect
    .poll(() =>
      page.locator(".designer-canvas__background-sampler").evaluate((element) => {
        const sampler = element as HTMLIFrameElement
        const nestedFrame = sampler.contentDocument?.querySelector<HTMLIFrameElement>(
          "iframe[data-sandbox-check]",
        )
        return nestedFrame?.contentDocument?.readyState
      }),
    )
    .toBe("complete")
  expect(
    await page.evaluate(
      () =>
        (globalThis as unknown as { splatpadSamplerScriptRan?: boolean }).splatpadSamplerScriptRan,
    ),
  ).toBe(false)
  await expect(page.locator(".designer-canvas__background-sampler")).toHaveCSS("width", "639px")
  await expect(page.locator(".designer-canvas")).toHaveAttribute(
    "data-canvas-background",
    "rgb(250, 250, 248)",
  )
  await expect(page.locator(".component-catalog-surface")).toHaveCSS(
    "background-color",
    "rgb(250, 250, 248)",
  )
  await viewportControl.selectOption("md")
  await expect(page.locator(".designer-canvas__background-sampler")).toHaveCSS("width", "768px")
  await expect(page.locator(".designer-canvas")).toHaveAttribute(
    "data-canvas-background",
    "rgb(8, 12, 20)",
  )
  await expect(page.locator(".designer-canvas")).toHaveClass(/designer-canvas--dark/)
  await expect(page.locator(".component-catalog-surface")).toHaveCSS(
    "background-color",
    "rgb(8, 12, 20)",
  )
  await expect(page.locator(".designer-canvas")).toHaveCSS("background-color", "rgb(17, 17, 19)")
  await viewportControl.selectOption("Default")
  await expect(page.locator(".designer-canvas")).toHaveAttribute(
    "data-canvas-background",
    "rgb(250, 250, 248)",
  )
  await expect(page.locator(".designer-canvas")).not.toHaveClass(/designer-canvas--dark/)
  await page.locator(".designer-canvas__background-sampler").evaluate((element) => {
    const sampler = element as HTMLIFrameElement
    const samplerWindow = sampler.contentWindow
    if (samplerWindow === null) {
      throw new Error("Expected the background sampler window")
    }
    const testWindow = globalThis as unknown as {
      splatpadSamplerDisconnects: number
      splatpadSamplerListenerRemovals: number
    }
    testWindow.splatpadSamplerDisconnects = 0
    testWindow.splatpadSamplerListenerRemovals = 0
    const samplerGlobal = samplerWindow as unknown as typeof globalThis
    const originalDisconnect = samplerGlobal.MutationObserver.prototype.disconnect
    samplerGlobal.MutationObserver.prototype.disconnect = function () {
      testWindow.splatpadSamplerDisconnects += 1
      originalDisconnect.call(this)
    }
    const originalRemoveEventListener = samplerWindow.removeEventListener.bind(samplerWindow)
    samplerWindow.removeEventListener = ((
      ...parameters: Parameters<typeof removeEventListener>
    ) => {
      if (parameters[0] === "resize") {
        testWindow.splatpadSamplerListenerRemovals += 1
      }
      originalRemoveEventListener(...parameters)
    }) as typeof samplerWindow.removeEventListener
  })
  await page.getByRole("button", { name: "Pages", exact: true }).click()
  await expect(page.locator(".designer-canvas__background-sampler")).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as { splatpadSamplerDisconnects: number })
            .splatpadSamplerDisconnects,
      ),
    )
    .toBeGreaterThan(0)
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (globalThis as unknown as { splatpadSamplerListenerRemovals: number })
            .splatpadSamplerListenerRemovals,
      ),
    )
    .toBeGreaterThan(0)
  await page.getByRole("button", { name: "Components", exact: true }).click()
  await expect(
    page.frameLocator('iframe[title="/__splatpad/design/components/button/"]').locator("html"),
  ).toHaveCSS("background-color", "rgba(0, 0, 0, 0)")

  await page.getByRole("button", { name: "button", exact: true }).click()
  await page.reload()
  await expect(page.getByRole("button", { name: "Components", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  await expect(page.locator(".designer-header__location code")).toHaveText("button")
  await expect(
    page
      .frameLocator('iframe[title="/__splatpad/design/components/button/"]')
      .getByRole("button", { name: "Order now" }),
  ).toBeVisible()

  const previewFile = path.join(siteRoot, "components", "button.design.liquid")
  const originalPreview = await fs.readFile(previewFile, "utf8")
  await fs.writeFile(previewFile, `${originalPreview}\n<p>Reload marker</p>\n`)
  try {
    await expect(
      page
        .frameLocator('iframe[title="/__splatpad/design/components/button/"]')
        .getByText("Reload marker"),
    ).toBeVisible()
    await expect(page.getByRole("button", { name: "Components", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(page.locator(".designer-header__location code")).toHaveText("button")
  } finally {
    await fs.writeFile(previewFile, originalPreview)
  }

  const groupedComponent = path.join(siteRoot, "components", "forms", "compact-input.liquid")
  await fs.mkdir(path.dirname(groupedComponent), { recursive: true })
  await fs.writeFile(groupedComponent, '<input aria-label="Compact input">')
  try {
    await expect(page.locator('[data-component-group="forms"]')).toContainText("forms")
    await expect(
      page.locator('.page-frame[data-route="/__splatpad/design/components/forms/compact-input/"]'),
    ).toHaveCount(1)
  } finally {
    await fs.rm(path.dirname(groupedComponent), { recursive: true })
  }
  expect(browserProblems.join("\n")).not.toContain("ResizeObserver")
})

test("loads the root sampler when Components opens before the root preview", async ({ page }) => {
  let releaseRoot: (() => void) | undefined
  let reportBlockedRoot: (() => void) | undefined
  const rootRelease = new Promise<void>((resolve) => {
    releaseRoot = resolve
  })
  const rootBlocked = new Promise<void>((resolve) => {
    reportBlockedRoot = resolve
  })
  let rootRequests = 0
  await page.route(`${baseUrl}/`, async (route) => {
    rootRequests += 1
    if (rootRequests === 1) {
      reportBlockedRoot?.()
      await rootRelease
    }
    await route.continue().catch(() => undefined)
  })

  try {
    await page.goto(`${baseUrl}/__splatpad/design/`, { waitUntil: "domcontentloaded" })
    await expect(page.getByRole("button", { name: "Components", exact: true })).toBeVisible()
    await rootBlocked
    await page.getByRole("button", { name: "Components", exact: true }).click()

    const sampler = page.locator(".designer-canvas__background-sampler")
    await expect(sampler).toHaveAttribute("src", "/")
    await expect(sampler).not.toHaveAttribute("srcdoc", /.+/)
    await expect
      .poll(() =>
        sampler.evaluate((element) => {
          const frame = element as HTMLIFrameElement
          return {
            page: frame.contentDocument?.body?.dataset.page,
            pathname: frame.contentWindow?.location.pathname,
            readyState: frame.contentDocument?.readyState,
          }
        }),
      )
      .toEqual({ page: "/", pathname: "/", readyState: "complete" })
    await expect
      .poll(() =>
        page.locator(".designer-canvas").evaluate((canvas) => {
          const samplerFrame = canvas.querySelector<HTMLIFrameElement>(
            ".designer-canvas__background-sampler",
          )
          const body = samplerFrame?.contentDocument?.body
          return body === null || body === undefined
            ? false
            : canvas.getAttribute("data-canvas-background") ===
                samplerFrame?.contentWindow?.getComputedStyle(body).backgroundColor
        }),
      )
      .toBe(true)
  } finally {
    releaseRoot?.()
    await page.unroute(`${baseUrl}/`)
  }
})

test("opens a component-only site after discovery completes", async ({ page }) => {
  const componentOnlyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "splatpad-components-only-"))
  const componentFile = path.join(componentOnlyRoot, "components", "status-badge.liquid")
  await fs.mkdir(path.dirname(componentFile), { recursive: true })
  await fs.mkdir(path.join(componentOnlyRoot, "pages"))
  await fs.mkdir(path.join(componentOnlyRoot, "data"))
  await fs.writeFile(path.join(componentOnlyRoot, "data", "site.json"), "{}")
  await fs.writeFile(componentFile, '<strong class="status-badge">Component-only badge</strong>')
  const componentServer = await createServer(
    createSiteConfig(componentOnlyRoot, {
      design: true,
      server: { host: "127.0.0.1", port: 0 },
    }),
  )
  await componentServer.listen()

  try {
    const address = componentServer.httpServer?.address()
    if (address === null || typeof address === "string" || address === undefined) {
      throw new Error("Expected the component-only server to listen on a TCP port")
    }
    await page.goto(`http://127.0.0.1:${address.port}/__splatpad/design/`)

    await expect(page.locator(".designer")).toBeVisible()
    await expect(page.getByText("Loading site routes...")).toHaveCount(0)
    await expect(page.getByRole("button", { name: "Pages", exact: true })).toContainText("0")
    await expect(page.getByRole("button", { name: "Components", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await expect(
      page.locator('.page-frame[data-route="/__splatpad/design/components/status-badge/"]'),
    ).toBeVisible()
    await expect(
      page
        .frameLocator('iframe[title="/__splatpad/design/components/status-badge/"]')
        .getByText("Component-only badge"),
    ).toBeVisible()
  } finally {
    await componentServer.close()
    await fs.rm(componentOnlyRoot, { recursive: true })
  }
})

test("settles component measurement across a breakpoint boundary", async ({ page }) => {
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await page.getByRole("button", { name: "Components", exact: true }).click()
  const route = "/__splatpad/design/components/alert/"
  const frame = preview(page, route)
  await expect(frame).toBeVisible()

  await frame.evaluate((iframe) => {
    const document = (iframe as HTMLIFrameElement).contentDocument
    if (document?.body === null || document?.body === undefined) {
      throw new Error("Expected the component preview document")
    }
    document.body.innerHTML = '<div class="probe"></div>'
    const style = document.createElement("style")
    style.textContent = `
      html, body { margin: 0; padding: 0; }
      .probe { width: 500px; height: 20px; }
      @media (min-width: 500px) {
        .probe { width: 100px; height: 40px; }
      }
    `
    document.head.append(style)
  })

  await expect(frame).toHaveCSS("width", "500px")
  await expect(frame).toHaveCSS("height", "40px")
  const samples = await frame.evaluate(
    (iframe) =>
      new Promise<string[]>((resolve) => {
        const values: string[] = []
        const sample = (): void => {
          const currentFrame = iframe as HTMLIFrameElement
          values.push(`${currentFrame.offsetWidth}x${currentFrame.offsetHeight}`)
          if (values.length === 30) {
            resolve(values)
          } else {
            globalThis.requestAnimationFrame(sample)
          }
        }
        globalThis.requestAnimationFrame(sample)
      }),
  )
  expect(new Set(samples)).toEqual(new Set(["500x40"]))
})

test("measures dynamic preview resources without requesting them from detached probes", async ({
  page,
}) => {
  const assetName = "measurement-request-count.svg"
  const assetPath = path.join(siteRoot, assetName)
  await fs.writeFile(
    assetPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="73" height="31"><rect width="73" height="31"/></svg>',
  )
  let requests = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/${assetName}`) {
      requests += 1
    }
  })

  try {
    await page.goto(`${baseUrl}/__splatpad/design/`)
    await page.getByRole("button", { name: "Components", exact: true }).click()
    const frame = preview(page, "/__splatpad/design/components/alert/")
    await expect(frame).toBeVisible()
    await frame.evaluate(
      (iframe, source) =>
        new Promise<void>((resolve, reject) => {
          const document = (iframe as HTMLIFrameElement).contentDocument
          if (document?.body === null || document?.body === undefined) {
            reject(new Error("Expected the component preview document"))
            return
          }
          const image = document.createElement("img")
          image.alt = "Measurement request count"
          image.addEventListener("load", () => resolve(), { once: true })
          image.addEventListener("error", () => reject(new Error("Expected the image to load")), {
            once: true,
          })
          image.src = source
          document.body.append(image)
        }),
      `/${assetName}`,
    )
    await expect.poll(() => page.locator("iframe[data-splatpad-measurement-probe]").count()).toBe(0)
    await page.waitForTimeout(250)
    expect(requests).toBe(1)
  } finally {
    await fs.rm(assetPath)
  }
})

test("keeps cross-origin responsive sizing fixed without refetching stylesheets", async ({
  page,
}) => {
  let stylesheetRequests = 0
  const stylesheetServer = http.createServer((_request, response) => {
    stylesheetRequests += 1
    response.setHeader("Content-Type", "text/css")
    response.end(`
      html, body { margin: 0; padding: 0; }
      .cross-origin-target { height: 20px; position: relative; width: 100px; }
      .cross-origin-target::after {
        content: "";
        height: 10px;
        left: 420px;
        position: absolute;
        top: 0;
        width: 110px;
      }
      @media (min-width: 400px) {
        .cross-origin-target { height: 80px; width: 620px; }
        .cross-origin-target::after { left: 680px; width: 140px; }
      }
    `)
  })
  await new Promise<void>((resolve, reject) => {
    stylesheetServer.once("error", reject)
    stylesheetServer.listen(0, "127.0.0.1", resolve)
  })

  try {
    const address = stylesheetServer.address()
    if (address === null || typeof address === "string") {
      throw new Error("Expected the stylesheet server to listen on a TCP port")
    }
    await page.goto(`${baseUrl}/__splatpad/design/`)
    await page.getByRole("button", { name: "Components", exact: true }).click()
    const frame = preview(page, "/__splatpad/design/components/alert/")
    await expect(frame).toBeVisible()
    await frame.evaluate(
      (iframe, stylesheetUrl) =>
        new Promise<void>((resolve, reject) => {
          const document = (iframe as HTMLIFrameElement).contentDocument
          if (document?.body === null || document?.body === undefined) {
            reject(new Error("Expected the component preview document"))
            return
          }
          document.body.innerHTML = '<div class="cross-origin-target"></div>'
          const link = document.createElement("link")
          link.rel = "stylesheet"
          link.href = stylesheetUrl
          link.addEventListener("load", () => resolve(), { once: true })
          link.addEventListener(
            "error",
            () => reject(new Error("Expected the cross-origin stylesheet to load")),
            { once: true },
          )
          document.head.append(link)
        }),
      `http://127.0.0.1:${address.port}/geometry.css`,
    )

    await expect(frame).toHaveCSS("width", "240px")
    await expect(frame).toHaveCSS("height", "20px")
    await frame.evaluate(
      (iframe) =>
        new Promise<void>((resolve) => {
          const target = (iframe as HTMLIFrameElement).contentDocument?.querySelector<HTMLElement>(
            ".cross-origin-target",
          )
          if (target === null || target === undefined) {
            throw new Error("Expected the cross-origin measurement target")
          }
          let mutation = 0
          const timer = setInterval(() => {
            target.dataset.responsiveMutation = `${mutation}`
            mutation += 1
            if (mutation === 20) {
              clearInterval(timer)
              resolve()
            }
          }, 10)
        }),
    )
    const samples = await frame.evaluate(
      (iframe) =>
        new Promise<string[]>((resolve) => {
          const values: string[] = []
          const sample = (): void => {
            const currentFrame = iframe as HTMLIFrameElement
            values.push(`${currentFrame.offsetWidth}x${currentFrame.offsetHeight}`)
            if (values.length === 30) {
              resolve(values)
            } else {
              globalThis.requestAnimationFrame(sample)
            }
          }
          globalThis.requestAnimationFrame(sample)
        }),
    )
    expect(new Set(samples)).toEqual(new Set(["240x20"]))
    await page.waitForTimeout(250)
    expect(stylesheetRequests).toBe(1)
  } finally {
    await new Promise<void>((resolve, reject) => {
      stylesheetServer.close((error) => (error === undefined ? resolve() : reject(error)))
    })
  }
})

test("does not activate noscript resources in script-disabled helper documents", async ({
  page,
}) => {
  const assetName = "noscript-request-count.svg"
  const assetPath = path.join(siteRoot, assetName)
  await fs.writeFile(
    assetPath,
    '<svg xmlns="http://www.w3.org/2000/svg" width="19" height="11"><rect width="19" height="11"/></svg>',
  )
  let requests = 0
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/${assetName}`) {
      requests += 1
    }
  })

  try {
    await page.goto(`${baseUrl}/__splatpad/design/`)
    const rootFrame = preview(page, "/")
    await expect(rootFrame).toBeVisible()
    await rootFrame.evaluate((iframe, source) => {
      const document = (iframe as HTMLIFrameElement).contentDocument
      if (document?.body === null || document?.body === undefined) {
        throw new Error("Expected the root preview document")
      }
      const noscript = document.createElement("noscript")
      noscript.textContent = `<img src="${source}?helper=root">`
      document.body.append(noscript)
    }, `/${assetName}`)

    await page.getByRole("button", { name: "Components", exact: true }).click()
    const componentFrame = preview(page, "/__splatpad/design/components/alert/")
    await expect(componentFrame).toBeVisible()
    await componentFrame.evaluate((iframe, source) => {
      const document = (iframe as HTMLIFrameElement).contentDocument
      if (document?.body === null || document?.body === undefined) {
        throw new Error("Expected the component preview document")
      }
      const noscript = document.createElement("noscript")
      noscript.textContent = `<picture><source srcset="${source}?helper=measurement"><img src="${source}?helper=measurement"></picture>`
      document.body.append(noscript)
    }, `/${assetName}`)

    await expect(page.locator(".designer-canvas__background-sampler")).toBeAttached()
    await expect.poll(() => page.locator("iframe[data-splatpad-measurement-probe]").count()).toBe(0)
    await page.waitForTimeout(250)
    expect(requests).toBe(0)
  } finally {
    await fs.rm(assetPath)
  }
})

test("survives repeated initial navigation and full preview reloads", async ({ page }) => {
  const browserProblems: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") {
      browserProblems.push(message.text())
    }
  })
  page.on("pageerror", (error) => browserProblems.push(error.message))

  const runReloadCycle = async (): Promise<void> => {
    await page.goto("about:blank")
    await page.goto(`${baseUrl}/__splatpad/design/`)
    await page.getByRole("button", { name: "Pages", exact: true }).click()
    await expect(page.locator(".page-frame")).toHaveCount(7)
    await page.reload()
    await expect(page.locator(".page-frame")).toHaveCount(7)
    await page.getByRole("button", { name: "Components", exact: true }).click()
    await expect(page.locator(".page-frame--component")).toHaveCount(13)
  }
  await runReloadCycle()
  await runReloadCycle()
  await runReloadCycle()
  await runReloadCycle()

  expect(
    browserProblems.join("\n"),
    "reloads must not create ResizeObserver loop errors",
  ).not.toContain("ResizeObserver")
})

test("focuses a real page from the site outline without changing the canvas shell", async ({
  page,
}) => {
  await page.goto(`${baseUrl}/__splatpad/design/`)
  await expect(page.getByRole("complementary", { name: "Site outline" })).toBeVisible()
  await expect(page.getByRole("option", { name: "SM screens and up (≥640px)" })).toHaveCount(1)
  await expect(page.locator(".designer-routes")).toHaveCSS("scrollbar-width", "thin")
  await expect
    .poll(() =>
      page
        .locator(".designer-routes")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true)
  await expect(
    page.getByText("Choose Inspect, then select an element on the canvas."),
  ).toBeVisible()
  await waitForCanvasReady(page)

  const scale = async (): Promise<number> =>
    page.locator(".react-flow__viewport").evaluate((element) => {
      return new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform).a
    })
  const overviewScale = await scale()

  await page.getByRole("button", { name: "/menu/", exact: true }).click()

  await expect(page.locator(".designer-header__location code")).toHaveText("/menu/")
  await expect(page.locator('.page-frame[data-route="/menu/"]')).toHaveClass(/page-frame--active/)
  await expect.poll(scale).toBeGreaterThan(overviewScale)

  await page.setViewportSize({ width: 1024, height: 720 })
  await expect(page.getByRole("complementary", { name: "Site outline" })).toBeVisible()
  await expect
    .poll(() =>
      page
        .locator(".designer-routes")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true)

  await page.setViewportSize({ width: 800, height: 720 })
  await expect(page.getByRole("complementary", { name: "Site outline" })).toBeVisible()
  await expect
    .poll(() =>
      page
        .locator(".designer-routes")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    )
    .toBe(true)
  await expect
    .poll(() =>
      page.locator(".designer-workspace").evaluate((workspace) => {
        const sidebar = workspace.querySelector<HTMLElement>(".designer-routes")
        const canvas = workspace.querySelector<HTMLElement>(".designer-canvas")
        if (sidebar === null || canvas === null) {
          return false
        }
        const workspaceBounds = workspace.getBoundingClientRect()
        const sidebarBounds = sidebar.getBoundingClientRect()
        const canvasBounds = canvas.getBoundingClientRect()
        return (
          canvasBounds.width > 0 &&
          Math.abs(canvasBounds.left - sidebarBounds.right) < 1 &&
          Math.abs(canvasBounds.right - workspaceBounds.right) < 1
        )
      }),
    )
    .toBe(true)
})

test("lists and selects the active page's frames, SVGs, and direct text parents", async ({
  page,
}) => {
  const outlineRoute = path.join(siteRoot, "pages", "outline", "index.liquid")
  const outlineComponent = path.join(siteRoot, "components", "outline-widget.liquid")
  await fs.mkdir(path.dirname(outlineRoute), { recursive: true })
  await fs.writeFile(
    outlineComponent,
    '<button class="outline-component" data-frame="Component root">{% yield %}</button>',
  )
  await fs.writeFile(
    outlineRoute,
    `<main data-frame="Hero frame" class="frame-target">
      <h1 class="text-target">Scoped outline text</h1>
      <svg aria-label="Bakery mark" class="svg-target" viewBox="0 0 10 10"><title>Vector title</title><circle cx="5" cy="5" r="4" /></svg>
      {% component "outline-widget" %}Outline action{% endcomponent %}
    </main>`,
  )

  await page.goto(`${baseUrl}/__splatpad/design/`)
  const canvasScale = async (): Promise<number> =>
    page.locator(".react-flow__viewport").evaluate((element) => {
      return new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform).a
    })
  const stableCanvasScale = async (): Promise<number> => {
    const samples: number[] = []
    await expect
      .poll(
        async () => {
          samples.push(await canvasScale())
          if (samples.length > 3) {
            samples.shift()
          }
          return samples.length === 3 && Math.max(...samples) - Math.min(...samples) < 0.000_001
        },
        { intervals: [100, 100, 100, 100] },
      )
      .toBe(true)
    return samples.at(-1) ?? 0
  }
  const overviewScale = await canvasScale()
  await expect(page.locator('.page-frame[data-route="/outline/"]')).not.toHaveClass(
    /page-frame--active/,
  )
  await inspectTool(page).click()
  await waitForInspectReady(page, "/outline/")
  await page.locator("body").evaluate((body) => {
    const frame = body.ownerDocument.querySelector<HTMLIFrameElement>('iframe[title="/outline/"]')
    const target = frame?.contentDocument?.querySelector(".outline-component")
    const surface = frame
      ?.closest(".page-frame")
      ?.querySelector<HTMLElement>(".page-frame__interaction-surface")
    if (frame === null || frame === undefined || target === null || target === undefined) {
      throw new Error("Expected the non-active component instance")
    }
    if (surface === null || surface === undefined) {
      throw new Error("Expected the non-active frame inspection surface")
    }
    const frameBounds = frame.getBoundingClientRect()
    const targetBounds = target.getBoundingClientRect()
    const scaleX = frame.offsetWidth === 0 ? 1 : frameBounds.width / frame.offsetWidth
    const scaleY = frame.offsetHeight === 0 ? 1 : frameBounds.height / frame.offsetHeight
    const clientX = frameBounds.left + (targetBounds.left + targetBounds.width / 2) * scaleX
    const clientY = frameBounds.top + (targetBounds.top + targetBounds.height / 2) * scaleY
    for (const type of ["pointerdown", "pointerup"]) {
      surface.dispatchEvent(
        new PointerEvent(type, {
          bubbles: true,
          button: 0,
          buttons: type === "pointerdown" ? 1 : 0,
          clientX,
          clientY,
          isPrimary: true,
          pointerId: 1,
          pointerType: "mouse",
        }),
      )
    }
  })
  await expect(page.getByRole("region", { name: "Component instance" })).toContainText(
    "outline-widget",
  )

  await expect(page.getByRole("button", { name: "/outline/", exact: true })).toBeVisible()
  await page.getByRole("button", { name: "/outline/", exact: true }).click()
  await expect.poll(canvasScale).toBeGreaterThan(overviewScale)
  const routeScale = await stableCanvasScale()

  const outline = page.getByRole("navigation", { name: "Page outline" })
  await expect(
    outline.locator('[data-outline-kind="frame"]', { hasText: "Hero frame" }),
  ).toBeVisible()
  await expect(
    outline.locator('[data-outline-kind="svg"]', { hasText: "Bakery mark" }),
  ).toBeVisible()
  await expect(
    outline.locator('[data-outline-kind="text"]', { hasText: "Scoped outline text" }),
  ).toBeVisible()
  await expect(
    outline.locator('[data-outline-kind="text"]', { hasText: "Vector title" }),
  ).toHaveCount(0)
  const componentOutlineItem = outline.locator('[data-outline-kind="component"]', {
    hasText: "outline-widget",
  })
  await expect(componentOutlineItem).toBeVisible()
  const componentRootOutlineItem = outline.locator('[data-outline-kind="frame"]', {
    hasText: "Component root",
  })
  await expect(componentRootOutlineItem).toBeVisible()

  await preview(page, "/outline/").evaluate((element) => {
    const frame = element as HTMLIFrameElement
    const mutation = frame.contentDocument?.createElement("p")
    if (mutation === undefined) {
      throw new Error("Expected the outline preview document")
    }
    mutation.className = "mutation-target"
    mutation.textContent = "Live outline mutation"
    frame.contentDocument?.body.append(mutation)
  })
  await expect(
    outline.locator('[data-outline-kind="text"]', { hasText: "Live outline mutation" }),
  ).toBeVisible()

  await outline.locator('[data-outline-kind="frame"]', { hasText: "Hero frame" }).click()
  await expect(inspectTool(page)).toHaveAttribute("aria-pressed", "true")
  await expectInspectorClassName(page, "frame-target")

  const svgOutlineItem = outline.locator('[data-outline-kind="svg"]', { hasText: "Bakery mark" })
  await svgOutlineItem.click()
  await expectInspectorClassName(page, "svg-target")
  expect(await stableCanvasScale()).toBe(routeScale)
  await svgOutlineItem.dblclick()
  await expect.poll(canvasScale).toBeGreaterThan(routeScale)

  await page.getByRole("button", { name: "/outline/", exact: true }).click()
  const keyboardScale = await stableCanvasScale()
  await svgOutlineItem.focus()
  await page.keyboard.press("Shift+Enter")
  await expect.poll(canvasScale).toBeGreaterThan(keyboardScale)

  await outline.locator('[data-outline-kind="text"]', { hasText: "Scoped outline text" }).click()
  await expectInspectorClassName(page, "text-target")

  await componentOutlineItem.click()
  await expect(componentOutlineItem).toHaveAttribute("aria-selected", "true")
  await expect(componentRootOutlineItem).toHaveAttribute("aria-selected", "false")
  await expect(page.getByRole("region", { name: "Component instance" })).toContainText(
    "outline-widget",
  )
  await preview(page, "/outline/").evaluate((element) => {
    const document = (element as HTMLIFrameElement).contentDocument
    const target = document?.querySelector(".outline-component")
    const endMarker = [...(target?.parentElement?.childNodes ?? [])].find(
      (node) => node.nodeType === 8 && node.nodeValue === "splatpad-component:end:outline-widget",
    )
    if (
      target === null ||
      target === undefined ||
      endMarker?.parentNode === null ||
      endMarker === undefined
    ) {
      throw new Error("Expected the selected component and its end marker")
    }
    endMarker.parentNode.insertBefore(target, endMarker.nextSibling)
  })
  await expect(page.getByRole("region", { name: "Component instance" })).toHaveCount(0)
  await expect(componentOutlineItem).toHaveAttribute("aria-selected", "true")
  await expectInspectorClassName(page, "outline-component")
  await preview(page, "/outline/").evaluate((element) => {
    const document = (element as HTMLIFrameElement).contentDocument
    const target = document?.querySelector(".outline-component")
    const endMarker = [...(target?.parentElement?.childNodes ?? [])].find(
      (node) => node.nodeType === 8 && node.nodeValue === "splatpad-component:end:outline-widget",
    )
    if (
      target === null ||
      target === undefined ||
      endMarker?.parentNode === null ||
      endMarker === undefined
    ) {
      throw new Error("Expected the selected component and its end marker")
    }
    endMarker.parentNode.insertBefore(target, endMarker)
  })
  await expect(page.getByRole("region", { name: "Component instance" })).toContainText(
    "outline-widget",
  )
  await componentRootOutlineItem.click()
  await expect(componentOutlineItem).toHaveAttribute("aria-selected", "false")
  await expect(componentRootOutlineItem).toHaveAttribute("aria-selected", "true")
  await componentOutlineItem.click()
  await page.getByRole("button", { name: "Open outline-widget component" }).click()
  await expect(page.getByRole("button", { name: "Components", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  )
  const componentFrame = page.locator(
    '.page-frame[data-route="/__splatpad/design/components/outline-widget/"]',
  )
  await expect(componentFrame).toHaveClass(/page-frame--active/)
  await expect
    .poll(() =>
      page.locator(".designer-canvas").evaluate((canvas, route) => {
        const frame = canvas.querySelector<HTMLElement>(`.page-frame[data-route="${route}"]`)
        if (frame === null) {
          return false
        }
        const canvasBounds = canvas.getBoundingClientRect()
        const frameBounds = frame.getBoundingClientRect()
        return (
          Math.abs(
            canvasBounds.left + canvasBounds.width / 2 - (frameBounds.left + frameBounds.width / 2),
          ) < 4 &&
          Math.abs(
            canvasBounds.top + canvasBounds.height / 2 - (frameBounds.top + frameBounds.height / 2),
          ) < 4
        )
      }, "/__splatpad/design/components/outline-widget/"),
    )
    .toBe(true)

  await page.getByRole("button", { name: "Pages", exact: true }).click()
  await page.getByRole("button", { name: "/outline/", exact: true }).click()

  await page.getByRole("button", { name: "/menu/", exact: true }).click()
  await expect(outline.getByText("Scoped outline text", { exact: true })).toHaveCount(0)

  await page.getByRole("button", { name: "/outline/", exact: true }).click()
  await fs.writeFile(
    outlineRoute,
    '<main data-frame="Replacement frame" class="replacement-target">Reloaded outline</main>',
  )
  await expect(outline.getByText("Hero frame", { exact: true })).toHaveCount(0)
  await outline.getByRole("treeitem", { name: "Replacement frame", exact: true }).click()
  await expectInspectorClassName(page, "replacement-target")

  await fs.rm(path.dirname(outlineRoute), { recursive: true })
  await fs.rm(outlineComponent)
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

const clickTargetRapidly = async (page: Page, target: Locator, count: number): Promise<void> => {
  const center = await centerOf(target)
  await page.locator("body").evaluate(
    (body, options) => {
      const surface = body.ownerDocument.elementFromPoint(options.x, options.y)
      if (
        !(surface instanceof HTMLElement) ||
        !surface.classList.contains("page-frame__interaction-surface")
      ) {
        throw new Error("Expected the target to be covered by an inspection surface")
      }
      for (let index = 0; index < options.count; index += 1) {
        const pointerId = index + 1
        surface.dispatchEvent(
          new PointerEvent("pointerdown", {
            bubbles: true,
            button: 0,
            buttons: 1,
            clientX: options.x,
            clientY: options.y,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          }),
        )
        surface.dispatchEvent(
          new PointerEvent("pointerup", {
            bubbles: true,
            button: 0,
            buttons: 0,
            clientX: options.x,
            clientY: options.y,
            isPrimary: true,
            pointerId,
            pointerType: "mouse",
          }),
        )
      }
    },
    { ...center, count },
  )
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
  await expect(page.locator(".page-frame")).toHaveCount(7)
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
  await expect(page.locator(".page-frame")).toHaveCount(7)
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
  await expect(page.locator(".page-frame")).toHaveCount(7)
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

  const viewportControl = page.getByRole("combobox", { name: "Viewport breakpoint" })
  await viewportControl.selectOption("sm")
  await expect(menuFrame).toHaveCSS("height", "1600px")

  await viewportControl.selectOption("md")
  const menuFrameNode = page
    .locator('.page-frame[data-route="/menu/"]')
    .locator("xpath=ancestor::*[contains(@class, 'react-flow__node')][1]")
  const storyFrameNode = page
    .locator('.page-frame[data-route="/story/"]')
    .locator("xpath=ancestor::*[contains(@class, 'react-flow__node')][1]")

  await expect(menuFrame).toHaveCSS("height", "900px")
  await expect(
    page.locator('.page-frame[data-route="/menu/"] .page-frame__interaction-surface'),
  ).toHaveCSS("height", "900px")
  await expect
    .poll(() => menuFrameNode.evaluate((node) => (node as HTMLElement).offsetHeight))
    .toBe(944)
  await expect
    .poll(async () => {
      const [menuTransform, storyTransform] = await Promise.all(
        [menuFrameNode, storyFrameNode].map((node) =>
          node.evaluate(
            (element) => new DOMMatrixReadOnly(globalThis.getComputedStyle(element).transform).m42,
          ),
        ),
      )
      return storyTransform - menuTransform
    })
    .toBe(1_144)
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
  await expect(page.locator(".page-frame")).toHaveCount(7)
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
    await expect(page.locator(".page-frame")).toHaveCount(7)
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
    await expectInspectorClassName(page, classes[0])

    await page.waitForTimeout(550)
    await clickTargetRapidly(page, heading, 2)
    await expectInspectorClassName(page, classes[1])

    await page.waitForTimeout(550)
    await clickTargetRapidly(page, heading, 3)
    await expectInspectorClassName(page, classes[2])

    await page.waitForTimeout(550)
    await clickTargetRapidly(page, heading, 2)
    await clickTarget(page, paragraph)
    await expectInspectorClassName(page, paragraphClass ?? "")
    await clickTarget(page, heading)
    await expectInspectorClassName(page, classes[0])
  })

  test("Given a full-width selection, its four-edge outline stays below full-height controls", async ({
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

    await expect(inspector(page)).toHaveCSS("top", "0px")
    await expect(inspector(page)).toHaveCSS("bottom", "0px")
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
