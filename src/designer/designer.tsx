import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react"
import type { Node, NodeProps, NodeTypes, ReactFlowInstance } from "@xyflow/react"
import {
  ArrowRight,
  Box,
  ChevronRight,
  Component as ComponentIcon,
  File,
  Hand,
  Image,
  MousePointer2,
  Type,
} from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { CSSProperties } from "react"
import { createRoot } from "react-dom/client"
import {
  frameHeaderHeight,
  frameWidth,
  initialFrameHeight,
  layoutDesignComponents,
  layoutDesignRoutes,
} from "./layout"
import {
  getWind4ViewportOptions,
  inspectWind4ClassName,
  resolveViewportSemanticCards,
  resolveViewportSpacing,
  spacingSides,
} from "./wind4-inspector"
import type {
  SemanticCardSummary,
  SpacingSummary,
  UtilitySection,
  ViewportCondition,
  ViewportOption,
} from "./wind4-inspector"

interface RouteRecord {
  route: string
}

interface ComponentRecord {
  name: string
  preview: "authored" | "automatic"
  route: string
}

interface RouteResponse {
  components: ComponentRecord[]
  routes: RouteRecord[]
  siteName: string
}

type DesignerTool = "inspect" | "pan"
type DesignerView = "components" | "pages"

interface DesignItem {
  depth: number
  label: string
  preview?: ComponentRecord["preview"]
  route: string
}

interface DesignerSession {
  activeRoute?: string
  view?: DesignerView
}

const designerSessionKey = "splatpad:designer-session"

const readDesignerSession = (): DesignerSession => {
  try {
    const value = JSON.parse(sessionStorage.getItem(designerSessionKey) ?? "{}") as DesignerSession
    return {
      activeRoute: typeof value.activeRoute === "string" ? value.activeRoute : undefined,
      view: value.view === "components" ? "components" : "pages",
    }
  } catch {
    return { view: "pages" }
  }
}

interface InspectedElement {
  className: string
  componentName?: string
  direction: "ltr" | "rtl"
  element: Element
  route: string
  writingMode: string
}

type OutlineKind = "component" | "frame" | "svg" | "text"

interface OutlineItem {
  componentName?: string
  depth: number
  element: Element
  id: string
  kind: OutlineKind
  label: string
}

interface SelectedOutlineItem {
  id: string
  kind: OutlineKind
  route: string
}

interface PageNodeData extends Record<string, unknown> {
  contentHeight: number
  inspecting: boolean
  interactive: boolean
  kind: "component" | "page"
  label: string
  measurementWidth: number
  preview?: ComponentRecord["preview"]
  onHeight: (route: string, height: number) => void
  onSize: (route: string, size: { height: number; width: number }) => void
  onInspect: (
    inspection: InspectedElement,
    select?: () => void,
    outlineItem?: SelectedOutlineItem,
  ) => void
  onInvalidate: (route: string) => void
  onOutline: (route: string, items: OutlineItem[]) => void
  onPanEnd: () => void
  onPanMove: (position: { x: number; y: number }) => void
  onPanStart: (position: { x: number; y: number }) => void
  onRegisterSelectionClear: (route: string, clear: (() => void) | undefined) => void
  onRegisterOutlineSelect: (
    route: string,
    select: ((item: OutlineItem) => void) | undefined,
  ) => void
  route: string
  selectedRoute: string | undefined
  selectionGeneration: number
  viewportWidth: number
}

type PageNode = Node<PageNodeData, "page">

interface CatalogGroupNodeData extends Record<string, unknown> {
  componentCount: number
  label: string
  path: string
}

type CatalogGroupNode = Node<CatalogGroupNodeData, "catalogGroup">

interface CatalogSurfaceNodeData extends Record<string, unknown> {
  height: number
  width: number
}

type CatalogSurfaceNode = Node<CatalogSurfaceNodeData, "catalogSurface">
type DesignNode = PageNode | CatalogGroupNode | CatalogSurfaceNode

const overlayAttribute = "data-splatpad-inspector-overlay"
const inspectionClickStreakMs = 500
const inspectionClickMovement = 4
const componentMarkerPattern = /^splatpad-component:(start|end):(.+)$/

const readComponentMarker = (
  node: ChildNode,
): { name: string; phase: "end" | "start" } | undefined => {
  if (node.nodeType !== 8) {
    return undefined
  }
  const match = componentMarkerPattern.exec(node.nodeValue ?? "")
  if (match === null) {
    return undefined
  }
  try {
    return {
      name: decodeURIComponent(match[2] ?? ""),
      phase: match[1] === "start" ? "start" : "end",
    }
  } catch {
    return undefined
  }
}

const documentHeight = (document: Document): number => {
  const body = document.body
  const root = document.documentElement
  return Math.max(
    body?.scrollHeight ?? 0,
    body?.offsetHeight ?? 0,
    root.scrollHeight,
    root.offsetHeight,
    root.clientHeight,
  )
}

const pixelValue = (value: string): number | undefined => {
  if (value === "auto" || value === "none" || value === "normal") {
    return undefined
  }
  const number = Number.parseFloat(value)
  return Number.isFinite(number) ? number : undefined
}

const lengthPercentageValue = (value: string, basis: number): number => {
  if (value.endsWith("%")) {
    return ((Number.parseFloat(value) || 0) / 100) * basis
  }
  return pixelValue(value) ?? 0
}

const transformedBoxExtent = (
  x: number,
  y: number,
  width: number,
  height: number,
  style: CSSStyleDeclaration,
): { bottom: number; right: number } => {
  if (style.transform === "none") {
    return { bottom: y + height, right: x + width }
  }
  const [originXValue = "0", originYValue = "0"] = style.transformOrigin.split(" ")
  const originX = lengthPercentageValue(originXValue, width)
  const originY = lengthPercentageValue(originYValue, height)
  const transform = new DOMMatrixReadOnly(style.transform)
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([cornerX = 0, cornerY = 0]) => {
    const point = new DOMPoint(cornerX - originX, cornerY - originY).matrixTransform(transform)
    const perspective = point.w === 0 ? 1 : point.w
    return {
      x: x + originX + point.x / perspective,
      y: y + originY + point.y / perspective,
    }
  })
  return {
    bottom: Math.max(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)),
  }
}

const generatedBoxBounds = (
  element: Element,
  pseudo: "::after" | "::before",
): { bottom: number; right: number } | undefined => {
  const frameWindow = element.ownerDocument.defaultView
  if (frameWindow === null) {
    return undefined
  }
  const style = frameWindow.getComputedStyle(element, pseudo)
  if (style.content === "none" || style.content === "normal" || style.display === "none") {
    return undefined
  }

  const contentWidth = pixelValue(style.width)
  const contentHeight = pixelValue(style.height)
  if (contentWidth === undefined || contentHeight === undefined) {
    return undefined
  }
  const horizontalExtras =
    (pixelValue(style.paddingLeft) ?? 0) +
    (pixelValue(style.paddingRight) ?? 0) +
    (pixelValue(style.borderLeftWidth) ?? 0) +
    (pixelValue(style.borderRightWidth) ?? 0)
  const verticalExtras =
    (pixelValue(style.paddingTop) ?? 0) +
    (pixelValue(style.paddingBottom) ?? 0) +
    (pixelValue(style.borderTopWidth) ?? 0) +
    (pixelValue(style.borderBottomWidth) ?? 0)
  const width = contentWidth + (style.boxSizing === "border-box" ? 0 : horizontalExtras)
  const height = contentHeight + (style.boxSizing === "border-box" ? 0 : verticalExtras)
  const marginLeft = pixelValue(style.marginLeft) ?? 0
  const marginTop = pixelValue(style.marginTop) ?? 0

  let containingBounds: DOMRect
  let containingWidth: number
  let containingHeight: number
  if (style.position === "fixed") {
    containingBounds = new DOMRect(0, 0, frameWindow.innerWidth, frameWindow.innerHeight)
    containingWidth = frameWindow.innerWidth
    containingHeight = frameWindow.innerHeight
  } else if (style.position === "absolute") {
    let containingElement: Element | null = element
    while (
      containingElement !== null &&
      frameWindow.getComputedStyle(containingElement).position === "static"
    ) {
      containingElement = containingElement.parentElement
    }
    containingElement ??= element.ownerDocument.documentElement
    const bounds = containingElement.getBoundingClientRect()
    containingBounds = new DOMRect(
      bounds.left + (containingElement as HTMLElement).clientLeft,
      bounds.top + (containingElement as HTMLElement).clientTop,
      (containingElement as HTMLElement).clientWidth,
      (containingElement as HTMLElement).clientHeight,
    )
    containingWidth = containingBounds.width
    containingHeight = containingBounds.height
  } else {
    return undefined
  }

  const left = pixelValue(style.left)
  const right = pixelValue(style.right)
  const top = pixelValue(style.top)
  const bottom = pixelValue(style.bottom)
  const x =
    containingBounds.left +
    (left ?? (right === undefined ? 0 : containingWidth - right - width)) +
    marginLeft
  const y =
    containingBounds.top +
    (top ?? (bottom === undefined ? 0 : containingHeight - bottom - height)) +
    marginTop
  return transformedBoxExtent(x, y, width, height, style)
}

const componentContentBounds = (document: Document): { bottom: number; right: number } => {
  const body = document.body
  if (body === null) {
    return { bottom: 0, right: 0 }
  }
  const bodyBounds = body.getBoundingClientRect()
  let bottom = bodyBounds.top
  let right = bodyBounds.left
  for (const element of [body, ...body.querySelectorAll("*")]) {
    if (element.hasAttribute(overlayAttribute) || element.closest(`[${overlayAttribute}]`)) {
      continue
    }
    const bounds = element.getBoundingClientRect()
    bottom = Math.max(bottom, bounds.bottom)
    right = Math.max(right, bounds.right)
    for (const pseudo of ["::before", "::after"] as const) {
      const generated = generatedBoxBounds(element, pseudo)
      if (generated !== undefined) {
        bottom = Math.max(bottom, generated.bottom)
        right = Math.max(right, generated.right)
      }
    }
  }
  return { bottom, right }
}

const componentDocumentSize = (document: Document): { height: number; width: number } => {
  const body = document.body
  const root = document.documentElement
  if (body === null || root === null) {
    return { height: 1, width: 240 }
  }
  const style = document.defaultView?.getComputedStyle(body)
  const paddingBottom = Number.parseFloat(style?.paddingBottom ?? "0")
  const paddingRight = Number.parseFloat(style?.paddingRight ?? "0")
  const bodyBounds = body.getBoundingClientRect()
  const { bottom, right } = componentContentBounds(document)

  const contentHeight = bottom - bodyBounds.top + paddingBottom
  const contentWidth = right - bodyBounds.left + paddingRight
  return {
    height: Math.max(
      1,
      Math.ceil(body.offsetHeight),
      Math.ceil(body.scrollHeight),
      Math.ceil(root.scrollHeight),
      Math.ceil(contentHeight),
    ),
    width: Math.max(
      1,
      Math.ceil(body.scrollWidth),
      Math.ceil(root.scrollWidth),
      Math.ceil(contentWidth),
    ),
  }
}

const componentRenderedHeight = (document: Document): number => {
  const body = document.body
  if (body === null) {
    return 1
  }
  const style = document.defaultView?.getComputedStyle(body)
  const paddingBottom = Number.parseFloat(style?.paddingBottom ?? "0")
  const bodyBounds = body.getBoundingClientRect()
  const { bottom } = componentContentBounds(document)
  return Math.max(
    1,
    Math.ceil(body.offsetHeight),
    Math.ceil(bottom - bodyBounds.top + paddingBottom),
  )
}

const cssCanLoadResource = /(?:url|src|image-set|cross-fade)\s*\(/i

const inertStyleDeclaration = (style: CSSStyleDeclaration): string =>
  [...style]
    .flatMap((property) => {
      const value = style.getPropertyValue(property)
      if (cssCanLoadResource.test(value)) {
        return []
      }
      const priority = style.getPropertyPriority(property)
      return [`${property}:${value}${priority === "" ? "" : ` !${priority}`}`]
    })
    .join(";")

const inertCssRules = (rules: CSSRuleList): string =>
  [...rules]
    .flatMap((rule) => {
      if (rule.type === CSSRule.IMPORT_RULE) {
        return []
      }
      const style = (rule as CSSRule & { style?: CSSStyleDeclaration }).style
      if (style !== undefined) {
        const openingBrace = rule.cssText.indexOf("{")
        const header = openingBrace < 0 ? "" : rule.cssText.slice(0, openingBrace)
        return header === "" || cssCanLoadResource.test(header)
          ? []
          : [`${header}{${inertStyleDeclaration(style)}}`]
      }
      const nestedRules = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules
      if (nestedRules !== undefined) {
        const openingBrace = rule.cssText.indexOf("{")
        const header = openingBrace < 0 ? "" : rule.cssText.slice(0, openingBrace)
        return header === "" || cssCanLoadResource.test(header)
          ? []
          : [`${header}{${inertCssRules(nestedRules)}}`]
      }
      return cssCanLoadResource.test(rule.cssText) ? [] : [rule.cssText]
    })
    .join("\n")

const inertDocumentCss = (document: Document): { css: string; needsComputedFallback: boolean } => {
  const sheets = [...document.styleSheets, ...document.adoptedStyleSheets]
  let needsComputedFallback = false
  const css = sheets
    .flatMap((sheet) => {
      try {
        return [inertCssRules(sheet.cssRules)]
      } catch {
        needsComputedFallback = true
        return []
      }
    })
    .join("\n")
  return { css, needsComputedFallback }
}

const applyComputedStyleFallback = (sourceElements: Element[], probeDocument: Document): void => {
  const sourceDocument = sourceElements[0]?.ownerDocument
  if (sourceDocument === undefined) {
    return
  }
  const sourceWindow = sourceDocument.defaultView
  const probeWindow = probeDocument.defaultView
  if (sourceWindow === null || probeWindow === null) {
    return
  }

  const pseudoRules: string[] = []
  for (const [index, source] of sourceElements.entries()) {
    const target = probeDocument.querySelector(`[data-splatpad-probe-id="${index}"]`)
    if (target === null || !("style" in target)) {
      continue
    }
    const sourceStyle = sourceWindow.getComputedStyle(source)
    const targetStyle = probeWindow.getComputedStyle(target)
    const targetDeclaration = (target as HTMLElement).style
    for (const property of sourceStyle) {
      const value = sourceStyle.getPropertyValue(property)
      if (value !== targetStyle.getPropertyValue(property) && !cssCanLoadResource.test(value)) {
        targetDeclaration.setProperty(property, value, "important")
      }
    }

    for (const pseudo of ["::before", "::after"] as const) {
      const sourcePseudo = sourceWindow.getComputedStyle(source, pseudo)
      if (["none", "normal"].includes(sourcePseudo.content)) {
        continue
      }
      const targetPseudo = probeWindow.getComputedStyle(target, pseudo)
      const declarations = [...sourcePseudo]
        .flatMap((property) => {
          const value = sourcePseudo.getPropertyValue(property)
          return value === targetPseudo.getPropertyValue(property) || cssCanLoadResource.test(value)
            ? []
            : [`${property}:${value} !important`]
        })
        .join(";")
      if (declarations !== "") {
        pseudoRules.push(`[data-splatpad-probe-id="${index}"]${pseudo}{${declarations}}`)
      }
    }
  }
  if (pseudoRules.length > 0) {
    const style = probeDocument.createElement("style")
    style.textContent = pseudoRules.join("\n")
    probeDocument.head.append(style)
  }
}

const resourceElementSelector = [
  "applet",
  "audio",
  "embed",
  "iframe",
  "img",
  'input[type="image" i]',
  "object",
  "picture",
  "source",
  "track",
  "video",
  "image",
  "feImage",
  "use",
].join(",")

const resourceAttributes = [
  "archive",
  "background",
  "classid",
  "code",
  "codebase",
  "data",
  "href",
  "manifest",
  "poster",
  "src",
  "srcdoc",
  "srcset",
  "xlink:href",
]

const createComponentDocumentProbe = (
  sourceDocument: Document,
  measurementWidth: number,
  onSize: (size: { height: number; width: number }) => void,
): (() => void) => {
  const hostDocument = sourceDocument.defaultView?.frameElement?.ownerDocument
  const sourceRoot = sourceDocument.documentElement
  if (hostDocument?.body === null || hostDocument?.body === undefined || sourceRoot === null) {
    return () => undefined
  }

  const clonedRoot = sourceRoot.cloneNode(true) as HTMLElement
  const sourceElements = [sourceRoot, ...sourceRoot.querySelectorAll("*")]
  const clonedElements = [clonedRoot, ...clonedRoot.querySelectorAll("*")]
  for (const [index, sourceElement] of sourceElements.entries()) {
    const clonedElement = clonedElements[index]
    if (clonedElement === undefined || !("style" in clonedElement)) {
      continue
    }
    clonedElement.setAttribute("data-splatpad-probe-id", `${index}`)
    const styledClone = clonedElement as HTMLElement
    if (sourceElement instanceof sourceDocument.defaultView!.HTMLElement) {
      styledClone.style.cssText = inertStyleDeclaration(sourceElement.style)
    }
    if (sourceElement.matches(resourceElementSelector)) {
      const bounds = sourceElement.getBoundingClientRect()
      styledClone.style.width = `${bounds.width}px`
      styledClone.style.height = `${bounds.height}px`
    }
  }
  for (const noscript of clonedRoot.querySelectorAll("noscript")) {
    noscript.remove()
  }
  for (const script of clonedRoot.querySelectorAll("script")) {
    script.remove()
  }
  for (const style of clonedRoot.querySelectorAll("style, link")) {
    style.remove()
  }
  for (const resource of clonedRoot.querySelectorAll(resourceElementSelector)) {
    for (const attribute of resourceAttributes) {
      resource.removeAttribute(attribute)
    }
    if (resource.localName === "iframe") {
      resource.setAttribute("sandbox", "")
    }
  }
  for (const element of clonedRoot.querySelectorAll("*")) {
    element.removeAttribute("background")
    element.removeAttribute("manifest")
    for (const attribute of element.attributes) {
      if (
        attribute.name.toLowerCase().startsWith("on") ||
        cssCanLoadResource.test(attribute.value) ||
        ((attribute.name === "href" || attribute.name === "src") &&
          attribute.value.trimStart().toLowerCase().startsWith("javascript:"))
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  for (const refresh of clonedRoot.querySelectorAll('meta[http-equiv="refresh" i]')) {
    refresh.remove()
  }
  const head = clonedRoot.querySelector("head")
  const { css, needsComputedFallback } = inertDocumentCss(sourceDocument)
  if (head !== null) {
    const style = hostDocument.createElement("style")
    style.textContent = css
    head.prepend(style)
  }

  const probe = hostDocument.createElement("iframe")
  probe.dataset.splatpadMeasurementProbe = ""
  probe.setAttribute("aria-hidden", "true")
  probe.setAttribute("sandbox", "allow-same-origin")
  probe.tabIndex = -1
  probe.style.cssText = `border:0;height:1px;left:-10000px;pointer-events:none;position:fixed;top:0;visibility:hidden;width:${measurementWidth}px`
  let connected = true
  const disconnect = (): void => {
    connected = false
    probe.remove()
  }
  probe.addEventListener(
    "load",
    () => {
      const document = probe.contentDocument
      if (
        !connected ||
        document === null ||
        document.documentElement === null ||
        document.body === null
      ) {
        disconnect()
        return
      }
      if (needsComputedFallback) {
        applyComputedStyleFallback(sourceElements, document)
      }
      void document.fonts.ready.then(() => {
        if (!connected || probe.contentDocument !== document) {
          return
        }
        const measured = componentDocumentSize(document)
        const size = {
          height: measured.height,
          width: needsComputedFallback ? measurementWidth : measured.width,
        }
        disconnect()
        onSize(size)
      })
    },
    { once: true },
  )
  probe.srcdoc = `<!doctype html>${clonedRoot.outerHTML}`
  hostDocument.body.append(probe)
  return disconnect
}

const PageFrame = memo(({ data }: NodeProps<PageNode>) => {
  const {
    inspecting,
    onInspect,
    onInvalidate,
    onOutline,
    onPanEnd,
    onPanMove,
    onPanStart,
    onRegisterOutlineSelect,
    route,
    viewportWidth,
  } = data
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const interactionSurfaceRef = useRef<HTMLDivElement | null>(null)
  const measurementFrame = useRef<number | undefined>(undefined)
  const measurementGeneration = useRef(0)
  const cancelScheduledMeasurement = useRef<() => void>(() => undefined)
  const scheduleHeightMeasurement = useRef<() => void>(() => undefined)
  const disconnectMeasurement = useRef<() => void>(() => undefined)
  const hoveredElement = useRef<Element | undefined>(undefined)
  const hitElement = useRef<Element | undefined>(undefined)
  const lastInspectionClick = useRef<number | undefined>(undefined)
  const selectedComponentName = useRef<string | undefined>(undefined)
  const selectedElement = useRef<Element | undefined>(undefined)
  const selectedOutlineSelection = useRef<SelectedOutlineItem | undefined>(undefined)
  const middlePan = useRef<{ capture: HTMLDivElement; pointerId: number } | undefined>(undefined)
  const primaryInspection = useRef<
    | {
        element: Element
        pointerId: number
        start: { x: number; y: number }
      }
    | undefined
  >(undefined)
  const updateOverlays = useRef<() => void>(() => undefined)
  const disconnectInspector = useRef<() => void>(() => undefined)
  const disconnectSelectionRefresh = useRef<() => void>(() => undefined)
  const disconnectComponentOwnership = useRef<() => void>(() => undefined)
  const disconnectOutline = useRef<() => void>(() => undefined)
  const connectSelectionRefresh = useRef<(element: Element) => void>(() => undefined)
  const reconcileComponentOwnership = useRef<(names: WeakMap<Element, string>) => void>(
    () => undefined,
  )
  const componentNames = useRef(new WeakMap<Element, string>())
  const outlineIds = useRef(new WeakMap<ChildNode, string>())
  const nextOutlineId = useRef(0)

  const connectComponentOwnership = useCallback((frame: HTMLIFrameElement): void => {
    disconnectComponentOwnership.current()
    const document = frame.contentDocument
    const frameWindow = document?.defaultView
    const root = document?.documentElement
    if (
      document === null ||
      document === undefined ||
      frameWindow === null ||
      frameWindow === undefined ||
      root === null ||
      root === undefined ||
      frame.contentDocument !== document
    ) {
      componentNames.current = new WeakMap<Element, string>()
      return
    }

    let ownershipFrame: number | undefined
    const refreshOwnership = (): void => {
      ownershipFrame = undefined
      const names = new WeakMap<Element, string>()
      const activeComponents: string[] = []
      const visitChildren = (parent: Element): void => {
        for (const child of parent.childNodes) {
          const marker = readComponentMarker(child)
          if (marker?.phase === "start") {
            activeComponents.push(marker.name)
            continue
          }
          if (marker?.phase === "end") {
            let index = activeComponents.length - 1
            while (index >= 0 && activeComponents[index] !== marker.name) {
              index -= 1
            }
            if (index >= 0) {
              activeComponents.splice(index)
            }
            continue
          }
          if (!(child instanceof frameWindow.Element)) {
            continue
          }
          const componentName = activeComponents.at(-1)
          if (componentName !== undefined) {
            names.set(child, componentName)
          }
          visitChildren(child)
        }
      }
      if (document.body !== null) {
        visitChildren(document.body)
      }
      componentNames.current = names
      reconcileComponentOwnership.current(names)
    }
    const scheduleOwnership = (): void => {
      if (ownershipFrame === undefined) {
        ownershipFrame = frameWindow.requestAnimationFrame(refreshOwnership)
      }
    }
    const observer = new frameWindow.MutationObserver(scheduleOwnership)
    if (frame.contentDocument !== document || document.documentElement !== root) {
      return
    }
    observer.observe(root, {
      characterData: true,
      childList: true,
      subtree: true,
    })
    refreshOwnership()
    disconnectComponentOwnership.current = () => {
      observer.disconnect()
      if (ownershipFrame !== undefined) {
        frameWindow.cancelAnimationFrame(ownershipFrame)
      }
      disconnectComponentOwnership.current = () => undefined
    }
  }, [])

  const inspectElement = useCallback(
    (
      element: Element,
      select?: () => void,
      componentName?: string,
      outlineItem?: SelectedOutlineItem,
    ): void => {
      const document = frameRef.current?.contentDocument
      if (
        document === null ||
        document === undefined ||
        element.ownerDocument !== document ||
        !element.isConnected
      ) {
        return
      }
      const computedStyle = document.defaultView?.getComputedStyle(element)
      onInspect(
        {
          className: element.getAttribute("class") ?? "",
          componentName: componentName ?? componentNames.current.get(element),
          direction: computedStyle?.direction === "rtl" ? "rtl" : "ltr",
          element,
          route,
          writingMode: computedStyle?.writingMode ?? "horizontal-tb",
        },
        select,
        outlineItem,
      )
    },
    [onInspect, route],
  )

  reconcileComponentOwnership.current = (names) => {
    const element = selectedElement.current
    if (element === undefined || !element.isConnected) {
      return
    }
    const componentName = names.get(element)
    if (componentName === selectedComponentName.current) {
      return
    }
    selectedComponentName.current = componentName
    inspectElement(element, undefined, componentName, selectedOutlineSelection.current)
  }

  const selectOutlineElement = useCallback(
    (item: OutlineItem): void => {
      const { componentName, element } = item
      if (!element.isConnected) {
        return
      }
      inspectElement(
        element,
        () => {
          hitElement.current = element
          lastInspectionClick.current = undefined
          selectedComponentName.current = componentName
          selectedElement.current = element
          selectedOutlineSelection.current = { id: item.id, kind: item.kind, route }
          connectSelectionRefresh.current(element)
          updateOverlays.current()
        },
        componentName,
        { id: item.id, kind: item.kind, route },
      )
    },
    [inspectElement, route],
  )

  const connectOutline = useCallback(
    (frame: HTMLIFrameElement): void => {
      disconnectOutline.current()
      const document = frame.contentDocument
      const frameWindow = document?.defaultView
      const root = document?.documentElement
      if (
        document === null ||
        document === undefined ||
        frameWindow === null ||
        frameWindow === undefined ||
        root === null ||
        root === undefined ||
        frame.contentDocument !== document
      ) {
        onOutline(route, [])
        return
      }

      let outlineFrame: number | undefined
      const readDirectText = (element: Element): string =>
        [...element.childNodes]
          .filter((node) => node.nodeType === 3)
          .map((node) => node.textContent ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim()
      const describe = (element: Element): Omit<OutlineItem, "depth" | "id"> | undefined => {
        const frameLabel = element.getAttribute("data-frame")?.trim()
        if (frameLabel !== undefined && frameLabel !== "") {
          return { element, kind: "frame", label: frameLabel }
        }
        if (element.localName.toLowerCase() === "svg") {
          const label =
            element.getAttribute("aria-label")?.trim() ||
            [...element.children]
              .find((child) => child.localName.toLowerCase() === "title")
              ?.textContent?.replace(/\s+/g, " ")
              .trim() ||
            element.id.trim() ||
            "SVG"
          return { element, kind: "svg", label }
        }
        if (element.namespaceURI !== "http://www.w3.org/1999/xhtml") {
          return undefined
        }
        const label = readDirectText(element)
        return label === "" ? undefined : { element, kind: "text", label }
      }
      const refreshOutline = (): void => {
        outlineFrame = undefined
        const activeComponents: Array<{
          element?: Element
          marker: ChildNode
          name: string
        }> = []
        const componentInstances: typeof activeComponents = []
        const described: Array<{
          componentName?: string
          depth: number
          element?: Element
          kind: OutlineKind
          label: string
          node: ChildNode
        }> = []
        const visitChildren = (parent: Element, qualifyingDepth: number): void => {
          for (const child of parent.childNodes) {
            const marker = readComponentMarker(child)
            if (marker?.phase === "start") {
              const component = { marker: child, name: marker.name }
              described.push({
                componentName: marker.name,
                depth: qualifyingDepth + activeComponents.length,
                kind: "component",
                label: marker.name,
                node: child,
              })
              activeComponents.push(component)
              componentInstances.push(component)
              continue
            }
            if (marker?.phase === "end") {
              let index = activeComponents.length - 1
              while (index >= 0 && activeComponents[index]?.name !== marker.name) {
                index -= 1
              }
              if (index >= 0) {
                activeComponents.splice(index)
              }
              continue
            }
            if (!(child instanceof frameWindow.Element)) {
              continue
            }
            for (const component of activeComponents) {
              component.element ??= child
            }
            const item = describe(child)
            if (item !== undefined) {
              described.push({
                ...item,
                depth: qualifyingDepth + activeComponents.length,
                node: child,
              })
            }
            visitChildren(child, qualifyingDepth + (item === undefined ? 0 : 1))
          }
        }
        if (document.body !== null) {
          const bodyItem = describe(document.body)
          if (bodyItem !== undefined) {
            described.push({ ...bodyItem, depth: 0, node: document.body })
          }
          visitChildren(document.body, bodyItem === undefined ? 0 : 1)
        }
        const componentElements = new Map<ChildNode, Element>()
        for (const component of componentInstances) {
          if (component.element !== undefined) {
            componentElements.set(component.marker, component.element)
          }
        }
        const items = described.flatMap(({ componentName, depth, element, kind, label, node }) => {
          const target = element ?? componentElements.get(node) ?? node.parentElement
          if (target === null || target === undefined) {
            return []
          }
          let id = outlineIds.current.get(node)
          if (id === undefined) {
            id = `${route}:${nextOutlineId.current}`
            nextOutlineId.current += 1
            outlineIds.current.set(node, id)
          }
          return [{ componentName, depth, element: target, id, kind, label }]
        })
        onOutline(route, items)
      }
      const scheduleOutline = (): void => {
        if (outlineFrame === undefined) {
          outlineFrame = frameWindow.requestAnimationFrame(refreshOutline)
        }
      }
      const observer = new frameWindow.MutationObserver(scheduleOutline)
      if (frame.contentDocument !== document || document.documentElement !== root) {
        return
      }
      observer.observe(root, {
        attributeFilter: ["aria-label", "data-frame", "id"],
        attributes: true,
        characterData: true,
        childList: true,
        subtree: true,
      })
      refreshOutline()
      disconnectOutline.current = () => {
        observer.disconnect()
        if (outlineFrame !== undefined) {
          frameWindow.cancelAnimationFrame(outlineFrame)
        }
        disconnectOutline.current = () => undefined
      }
    },
    [onOutline, route],
  )

  const clearMarkers = useCallback((): void => {
    disconnectSelectionRefresh.current()
    hoveredElement.current = undefined
    hitElement.current = undefined
    lastInspectionClick.current = undefined
    selectedComponentName.current = undefined
    selectedElement.current = undefined
    selectedOutlineSelection.current = undefined
    primaryInspection.current = undefined
    updateOverlays.current()
  }, [])

  const clearSelection = useCallback((): void => {
    disconnectSelectionRefresh.current()
    hitElement.current = undefined
    lastInspectionClick.current = undefined
    selectedComponentName.current = undefined
    selectedElement.current = undefined
    selectedOutlineSelection.current = undefined
    primaryInspection.current = undefined
    updateOverlays.current()
  }, [])

  const measureFrame = useCallback(
    (frame: HTMLIFrameElement): void => {
      disconnectMeasurement.current()
      const generation = ++measurementGeneration.current
      cancelScheduledMeasurement.current()
      const document = frame.contentDocument
      const frameWindow = document?.defaultView
      const root = document?.documentElement
      if (
        document === null ||
        frameWindow === null ||
        frameWindow === undefined ||
        root === null ||
        root === undefined ||
        frame.contentDocument !== document
      ) {
        return
      }

      const isCurrentDocument = (): boolean =>
        measurementGeneration.current === generation &&
        frame.contentDocument === document &&
        document.documentElement === root &&
        root.isConnected

      let intrinsicWidth: number | undefined
      let pendingMeasurement: "height" | "intrinsic" | undefined
      let intrinsicTimer: number | undefined
      let intrinsicMaxTimer: number | undefined
      let disconnectProbe = (): void => undefined
      cancelScheduledMeasurement.current = () => {
        if (measurementFrame.current !== undefined) {
          frameWindow.cancelAnimationFrame(measurementFrame.current)
          measurementFrame.current = undefined
        }
        if (intrinsicTimer !== undefined) {
          frameWindow.clearTimeout(intrinsicTimer)
          intrinsicTimer = undefined
        }
        if (intrinsicMaxTimer !== undefined) {
          frameWindow.clearTimeout(intrinsicMaxTimer)
          intrinsicMaxTimer = undefined
        }
        disconnectProbe()
        pendingMeasurement = undefined
        cancelScheduledMeasurement.current = () => undefined
      }

      const measure = (): void => {
        if (!isCurrentDocument()) {
          return
        }
        measurementFrame.current = undefined
        const measurement = pendingMeasurement
        pendingMeasurement = undefined
        if (measurement === "intrinsic" && data.kind === "component") {
          disconnectProbe()
          disconnectProbe = createComponentDocumentProbe(
            document,
            data.measurementWidth,
            (probed) => {
              if (!isCurrentDocument()) {
                return
              }
              intrinsicWidth = probed.width
              data.onHeight(data.route, probed.height)
              data.onSize(data.route, probed)
            },
          )
          return
        }
        const componentHeight =
          data.kind === "component" ? componentRenderedHeight(document) : undefined
        const height = componentHeight ?? documentHeight(document)
        if (height > 0 && isCurrentDocument()) {
          data.onHeight(data.route, height)
          if (componentHeight !== undefined && intrinsicWidth !== undefined) {
            data.onSize(data.route, { height, width: intrinsicWidth })
          }
        }
      }

      const scheduleMeasure = (measurement: "height" | "intrinsic"): void => {
        if (!isCurrentDocument()) {
          return
        }
        if (measurement === "intrinsic" || pendingMeasurement === undefined) {
          pendingMeasurement = measurement
        }
        if (measurementFrame.current === undefined) {
          measurementFrame.current = frameWindow.requestAnimationFrame(measure)
        }
      }

      const scheduleIntrinsicMeasure = (): void => {
        if (intrinsicTimer !== undefined) {
          frameWindow.clearTimeout(intrinsicTimer)
          intrinsicTimer = undefined
        }
        if (intrinsicMaxTimer !== undefined) {
          frameWindow.clearTimeout(intrinsicMaxTimer)
          intrinsicMaxTimer = undefined
        }
        scheduleMeasure("intrinsic")
      }
      const scheduleHeightMeasure = (): void => scheduleMeasure("height")
      const scheduleQuiescentIntrinsicMeasure = (): void => {
        scheduleHeightMeasure()
        if (intrinsicTimer !== undefined) {
          frameWindow.clearTimeout(intrinsicTimer)
        }
        if (intrinsicMaxTimer === undefined) {
          intrinsicMaxTimer = frameWindow.setTimeout(scheduleIntrinsicMeasure, 600)
        }
        intrinsicTimer = frameWindow.setTimeout(() => {
          intrinsicTimer = undefined
          scheduleIntrinsicMeasure()
        }, 120)
      }
      scheduleHeightMeasurement.current = scheduleHeightMeasure
      scheduleIntrinsicMeasure()
      void document.fonts.ready.then(scheduleIntrinsicMeasure)
      if (document.body !== null) {
        const rootSize = (): string => {
          const body = document.body
          return body === null
            ? ""
            : `${root.scrollWidth}:${root.scrollHeight}:${body.scrollWidth}:${body.scrollHeight}:${body.offsetWidth}:${body.offsetHeight}`
        }
        let observedRootSize = rootSize()
        const rootSizeTimer = frameWindow.setInterval(() => {
          if (!isCurrentDocument()) {
            return
          }
          const nextRootSize = rootSize()
          if (nextRootSize !== observedRootSize) {
            observedRootSize = nextRootSize
            scheduleHeightMeasure()
          }
        }, 250)
        const mutationObserver = new frameWindow.MutationObserver(scheduleQuiescentIntrinsicMeasure)
        if (!isCurrentDocument()) {
          return
        }
        mutationObserver.observe(root, {
          attributes: true,
          characterData: true,
          childList: true,
          subtree: true,
        })
        document.addEventListener("load", scheduleQuiescentIntrinsicMeasure, true)
        document.fonts.addEventListener("loadingdone", scheduleQuiescentIntrinsicMeasure)
        frameWindow.addEventListener("resize", scheduleHeightMeasure)
        disconnectMeasurement.current = () => {
          mutationObserver.disconnect()
          frameWindow.clearInterval(rootSizeTimer)
          document.removeEventListener("load", scheduleQuiescentIntrinsicMeasure, true)
          document.fonts.removeEventListener("loadingdone", scheduleQuiescentIntrinsicMeasure)
          frameWindow.removeEventListener("resize", scheduleHeightMeasure)
          cancelScheduledMeasurement.current()
          scheduleHeightMeasurement.current = () => undefined
          disconnectMeasurement.current = () => undefined
        }
      }
    },
    [data.kind, data.measurementWidth, data.onHeight, data.onSize, data.route],
  )

  const connectInspector = useCallback(
    (frame: HTMLIFrameElement): void => {
      disconnectInspector.current()
      clearMarkers()

      const document = frame.contentDocument
      const interactionSurface = interactionSurfaceRef.current
      if (document === null || interactionSurface === null || !inspecting) {
        return
      }

      const watchSelection = (element: Element): void => {
        disconnectSelectionRefresh.current()
        const frameWindow = document.defaultView
        const root = document.documentElement
        if (
          frameWindow === null ||
          root === null ||
          frame.contentDocument !== document ||
          !element.isConnected ||
          element.ownerDocument !== document
        ) {
          return
        }

        let refreshFrame: number | undefined
        const scheduleRefresh = (): void => {
          if (refreshFrame !== undefined) {
            return
          }
          refreshFrame = frameWindow.requestAnimationFrame(() => {
            refreshFrame = undefined
            if (element === selectedElement.current && element.isConnected) {
              inspectElement(
                element,
                undefined,
                selectedComponentName.current,
                selectedOutlineSelection.current,
              )
            }
          })
        }
        const observer = new frameWindow.MutationObserver(scheduleRefresh)
        for (
          let current: Element | null = element;
          current !== null;
          current = current.parentElement
        ) {
          if (frame.contentDocument !== document || document.documentElement !== root) {
            observer.disconnect()
            return
          }
          observer.observe(current, {
            attributeFilter: ["class", "dir", "style"],
            attributes: true,
          })
        }
        if (
          document.head !== null &&
          frame.contentDocument === document &&
          document.documentElement === root
        ) {
          observer.observe(document.head, {
            attributeFilter: ["disabled", "href", "media"],
            attributes: true,
            characterData: true,
            childList: true,
            subtree: true,
          })
        }
        const onStylesheetLoad = (event: Event): void => {
          if (event.target instanceof frameWindow.HTMLLinkElement) {
            scheduleRefresh()
          }
        }
        document.addEventListener("load", onStylesheetLoad, true)
        disconnectSelectionRefresh.current = () => {
          observer.disconnect()
          document.removeEventListener("load", onStylesheetLoad, true)
          if (refreshFrame !== undefined) {
            frameWindow.cancelAnimationFrame(refreshFrame)
          }
          disconnectSelectionRefresh.current = () => undefined
        }
      }
      connectSelectionRefresh.current = watchSelection

      const overlayDocument = frame.ownerDocument
      const overlayWindow = overlayDocument.defaultView
      const hoverOverlay = overlayDocument.createElement("div")
      const selectedOverlay = overlayDocument.createElement("div")
      hoverOverlay.setAttribute(overlayAttribute, "hover")
      hoverOverlay.setAttribute("data-splatpad-inspector-route", route)
      hoverOverlay.setAttribute("aria-hidden", "true")
      selectedOverlay.setAttribute(overlayAttribute, "selected")
      selectedOverlay.setAttribute("data-splatpad-inspector-route", route)
      selectedOverlay.setAttribute("aria-hidden", "true")

      const prepareOverlay = (overlay: HTMLDivElement, color: string, zIndex: number): void => {
        const importantStyles: Record<string, string> = {
          all: "initial",
          border: `2px solid ${color}`,
          "box-sizing": "border-box",
          display: "none",
          "pointer-events": "none",
          position: "fixed",
          "z-index": `${zIndex}`,
        }
        for (const [property, value] of Object.entries(importantStyles)) {
          overlay.style.setProperty(property, value, "important")
        }
      }
      prepareOverlay(hoverOverlay, "#2563eb", 8)
      prepareOverlay(selectedOverlay, "#7c3aed", 8)
      overlayDocument.body.append(hoverOverlay, selectedOverlay)

      const positionOverlay = (overlay: HTMLDivElement, element: Element | undefined): void => {
        if (element === undefined) {
          overlay.style.setProperty("display", "none", "important")
          return
        }

        const frameBounds = frame.getBoundingClientRect()
        const frameScaleX = frame.offsetWidth === 0 ? 1 : frameBounds.width / frame.offsetWidth
        const frameScaleY = frame.offsetHeight === 0 ? 1 : frameBounds.height / frame.offsetHeight
        const frameLeft = frameBounds.left + frame.clientLeft * frameScaleX
        const frameTop = frameBounds.top + frame.clientTop * frameScaleY
        const bounds = element.getBoundingClientRect()
        const documentViewportWidth = document.documentElement.clientWidth
        const viewportHeight = document.documentElement.clientHeight
        const left =
          frameLeft + Math.max(0, Math.min(documentViewportWidth, bounds.left)) * frameScaleX
        const top = frameTop + Math.max(0, Math.min(viewportHeight, bounds.top)) * frameScaleY
        const right =
          frameLeft + Math.max(0, Math.min(documentViewportWidth, bounds.right)) * frameScaleX
        const bottom = frameTop + Math.max(0, Math.min(viewportHeight, bounds.bottom)) * frameScaleY
        if (right <= left || bottom <= top) {
          overlay.style.setProperty("display", "none", "important")
          return
        }

        const importantGeometry: Record<string, string> = {
          display: "block",
          height: `${bottom - top}px`,
          left: `${left}px`,
          top: `${top}px`,
          width: `${right - left}px`,
        }
        for (const [property, value] of Object.entries(importantGeometry)) {
          overlay.style.setProperty(property, value, "important")
        }
      }

      const positionOverlays = (): void => {
        if (hoveredElement.current !== undefined && !hoveredElement.current.isConnected) {
          hoveredElement.current = undefined
        }
        if (selectedElement.current !== undefined && !selectedElement.current.isConnected) {
          disconnectSelectionRefresh.current()
          selectedElement.current = undefined
          selectedOutlineSelection.current = undefined
          hitElement.current = undefined
          lastInspectionClick.current = undefined
          onInvalidate(route)
        }
        positionOverlay(hoverOverlay, hoveredElement.current)
        positionOverlay(selectedOverlay, selectedElement.current)
      }

      let overlayFrame: number | undefined
      const trackOverlayPositions = (): void => {
        overlayFrame = undefined
        positionOverlays()
        if (hoveredElement.current !== undefined || selectedElement.current !== undefined) {
          overlayFrame = overlayWindow?.requestAnimationFrame(trackOverlayPositions)
        }
      }
      const updateOverlayPositions = (): void => {
        positionOverlays()
        const hasTarget =
          hoveredElement.current !== undefined || selectedElement.current !== undefined
        if (overlayFrame === undefined && hasTarget) {
          overlayFrame = overlayWindow?.requestAnimationFrame(trackOverlayPositions)
        } else if (overlayFrame !== undefined && !hasTarget) {
          overlayWindow?.cancelAnimationFrame(overlayFrame)
          overlayFrame = undefined
        }
      }
      updateOverlays.current = updateOverlayPositions
      updateOverlayPositions()

      const endMiddlePan = (pointerId: number, releaseCapture: boolean): void => {
        const current = middlePan.current
        if (current === undefined || current.pointerId !== pointerId) {
          return
        }

        middlePan.current = undefined
        current.capture.removeEventListener("lostpointercapture", onLostPointerCapture)
        if (releaseCapture && current.capture.hasPointerCapture(pointerId)) {
          current.capture.releasePointerCapture(pointerId)
        }
        onPanEnd()
      }

      const hitTest = (event: PointerEvent): Element | undefined => {
        const bounds = frame.getBoundingClientRect()
        const scaleX = frame.offsetWidth === 0 ? 1 : bounds.width / frame.offsetWidth
        const scaleY = frame.offsetHeight === 0 ? 1 : bounds.height / frame.offsetHeight
        const x = (event.clientX - bounds.left) / scaleX - frame.clientLeft
        const y = (event.clientY - bounds.top) / scaleY - frame.clientTop
        return document.elementFromPoint(x, y) ?? undefined
      }

      const onPointerMove = (event: PointerEvent): void => {
        event.preventDefault()
        event.stopPropagation()
        const current = middlePan.current
        if (current !== undefined && current.pointerId === event.pointerId) {
          onPanMove({ x: event.clientX, y: event.clientY })
          return
        }

        const candidate = primaryInspection.current
        if (
          candidate !== undefined &&
          candidate.pointerId === event.pointerId &&
          Math.hypot(event.clientX - candidate.start.x, event.clientY - candidate.start.y) >
            inspectionClickMovement
        ) {
          primaryInspection.current = undefined
        }

        const element = hitTest(event)
        if (element === undefined || element === hoveredElement.current) {
          return
        }

        hoveredElement.current = element
        updateOverlayPositions()
      }

      const onPointerLeave = (): void => {
        if (middlePan.current !== undefined) {
          return
        }
        primaryInspection.current = undefined
        hoveredElement.current = undefined
        updateOverlayPositions()
      }

      const onPointerDown = (event: PointerEvent): void => {
        event.preventDefault()
        event.stopPropagation()
        const element = hitTest(event)
        if (event.button === 1) {
          try {
            interactionSurface.setPointerCapture(event.pointerId)
          } catch {
            middlePan.current = undefined
            onPanEnd()
            return
          }
          middlePan.current = { capture: interactionSurface, pointerId: event.pointerId }
          interactionSurface.addEventListener("lostpointercapture", onLostPointerCapture)
          onPanStart({ x: event.clientX, y: event.clientY })
          return
        }
        if (event.button !== 0 || element === undefined) {
          return
        }

        primaryInspection.current = {
          element,
          pointerId: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
        }
      }

      const blockAction = (event: Event): void => {
        event.preventDefault()
        event.stopPropagation()
      }

      const onPointerUp = (event: PointerEvent): void => {
        endMiddlePan(event.pointerId, true)
        blockAction(event)
        const candidate = primaryInspection.current
        primaryInspection.current = undefined
        if (
          event.button !== 0 ||
          candidate === undefined ||
          candidate.pointerId !== event.pointerId ||
          Math.hypot(event.clientX - candidate.start.x, event.clientY - candidate.start.y) >
            inspectionClickMovement ||
          hitTest(event) !== candidate.element
        ) {
          return
        }

        const currentSelection = selectedElement.current
        const continuesClickStreak =
          hitElement.current === candidate.element &&
          currentSelection !== undefined &&
          lastInspectionClick.current !== undefined &&
          event.timeStamp - lastInspectionClick.current <= inspectionClickStreakMs
        const nextSelection =
          continuesClickStreak && currentSelection !== undefined
            ? (currentSelection.parentElement ?? currentSelection)
            : candidate.element

        inspectElement(nextSelection, () => {
          hitElement.current = candidate.element
          lastInspectionClick.current = event.timeStamp
          selectedComponentName.current = componentNames.current.get(nextSelection)
          selectedElement.current = nextSelection
          selectedOutlineSelection.current = undefined
          watchSelection(nextSelection)
          updateOverlayPositions()
        })
      }

      const onPointerCancel = (event: PointerEvent): void => {
        primaryInspection.current = undefined
        endMiddlePan(event.pointerId, true)
        blockAction(event)
      }

      const onLostPointerCapture = (event: Event): void => {
        endMiddlePan((event as PointerEvent).pointerId, false)
      }

      const abortMiddlePan = (): void => {
        const current = middlePan.current
        if (current !== undefined) {
          endMiddlePan(current.pointerId, true)
        }
      }

      const onVisibilityChange = (): void => {
        if (overlayDocument.visibilityState !== "visible") {
          abortMiddlePan()
        }
      }

      interactionSurface.addEventListener("pointermove", onPointerMove)
      interactionSurface.addEventListener("pointerleave", onPointerLeave)
      interactionSurface.addEventListener("pointerdown", onPointerDown)
      interactionSurface.addEventListener("pointerup", onPointerUp)
      interactionSurface.addEventListener("pointercancel", onPointerCancel)
      interactionSurface.addEventListener("click", blockAction)
      interactionSurface.addEventListener("auxclick", blockAction)
      interactionSurface.addEventListener("dblclick", blockAction)
      interactionSurface.addEventListener("contextmenu", blockAction)
      overlayWindow?.addEventListener("blur", abortMiddlePan)
      overlayDocument.addEventListener("visibilitychange", onVisibilityChange)

      disconnectInspector.current = () => {
        interactionSurface.removeEventListener("pointermove", onPointerMove)
        interactionSurface.removeEventListener("pointerleave", onPointerLeave)
        interactionSurface.removeEventListener("pointerdown", onPointerDown)
        interactionSurface.removeEventListener("pointerup", onPointerUp)
        interactionSurface.removeEventListener("pointercancel", onPointerCancel)
        interactionSurface.removeEventListener("click", blockAction)
        interactionSurface.removeEventListener("auxclick", blockAction)
        interactionSurface.removeEventListener("dblclick", blockAction)
        interactionSurface.removeEventListener("contextmenu", blockAction)
        overlayWindow?.removeEventListener("blur", abortMiddlePan)
        overlayDocument.removeEventListener("visibilitychange", onVisibilityChange)
        disconnectSelectionRefresh.current()
        if (overlayFrame !== undefined) {
          overlayWindow?.cancelAnimationFrame(overlayFrame)
        }
        const currentPan = middlePan.current
        if (currentPan !== undefined) {
          endMiddlePan(currentPan.pointerId, true)
        }
        clearMarkers()
        hoverOverlay.remove()
        selectedOverlay.remove()
        updateOverlays.current = () => undefined
        connectSelectionRefresh.current = () => undefined
        disconnectInspector.current = () => undefined
      }
    },
    [
      clearMarkers,
      inspecting,
      inspectElement,
      onInvalidate,
      onPanEnd,
      onPanMove,
      onPanStart,
      route,
    ],
  )

  useEffect(() => {
    data.onRegisterSelectionClear(route, clearSelection)
    return () => data.onRegisterSelectionClear(route, undefined)
  }, [clearSelection, data, route])

  useEffect(() => {
    onRegisterOutlineSelect(route, selectOutlineElement)
    return () => onRegisterOutlineSelect(route, undefined)
  }, [onRegisterOutlineSelect, route, selectOutlineElement])

  useEffect(() => {
    const frame = frameRef.current
    if (data.selectedRoute === route && frame !== null) {
      connectOutline(frame)
    } else {
      disconnectOutline.current()
      onOutline(route, [])
    }
    return () => disconnectOutline.current()
  }, [connectOutline, data.selectedRoute, onOutline, route])

  useEffect(() => {
    const frame = frameRef.current
    if (frame !== null) {
      connectInspector(frame)
    }
    return () => disconnectInspector.current()
  }, [connectInspector])

  useEffect(() => {
    if (data.selectedRoute !== route) {
      disconnectSelectionRefresh.current()
      selectedElement.current = undefined
      selectedComponentName.current = undefined
      selectedOutlineSelection.current = undefined
      hitElement.current = undefined
      lastInspectionClick.current = undefined
      updateOverlays.current()
    }
  }, [data.selectedRoute, data.selectionGeneration, route])

  useEffect(() => {
    scheduleHeightMeasurement.current()
    const element = selectedElement.current
    if (element === undefined) {
      return
    }
    const refreshFrame = requestAnimationFrame(() => {
      if (element === selectedElement.current && element.isConnected) {
        inspectElement(
          element,
          undefined,
          selectedComponentName.current,
          selectedOutlineSelection.current,
        )
      }
    })
    return () => cancelAnimationFrame(refreshFrame)
  }, [inspectElement, viewportWidth])

  useEffect(
    () => () => {
      disconnectComponentOwnership.current()
      disconnectOutline.current()
      disconnectMeasurement.current()
      cancelScheduledMeasurement.current()
      scheduleHeightMeasurement.current = () => undefined
      onOutline(route, [])
      measurementGeneration.current += 1
    },
    [onOutline, route],
  )

  return (
    <article
      className={`page-frame page-frame--${data.kind}${data.interactive ? " page-frame--interactive" : ""}${data.selectedRoute === route ? " page-frame--active" : ""}`}
      data-route={data.route}
      style={{ width: viewportWidth }}
    >
      <header className="page-frame__header">
        <strong>{data.label}</strong>
        {data.preview === undefined ? null : (
          <span>{data.preview === "authored" ? "design preview" : "automatic preview"}</span>
        )}
      </header>
      <iframe
        aria-label={`Preview of ${data.route}`}
        className="page-frame__preview"
        onLoad={(event) => {
          connectComponentOwnership(event.currentTarget)
          measureFrame(event.currentTarget)
          data.onInvalidate(data.route)
          if (data.selectedRoute === route) {
            connectOutline(event.currentTarget)
          }
          connectInspector(event.currentTarget)
        }}
        ref={frameRef}
        src={data.route}
        style={{ height: data.contentHeight, width: viewportWidth }}
        tabIndex={-1}
        title={data.route}
      />
      <div
        aria-hidden="true"
        className="page-frame__interaction-surface"
        ref={interactionSurfaceRef}
        style={{ height: data.contentHeight, width: viewportWidth }}
      />
    </article>
  )
})
PageFrame.displayName = "PageFrame"

const CatalogGroup = memo(({ data }: NodeProps<CatalogGroupNode>) => (
  <header className="component-group" data-component-group={data.path}>
    <div>
      <strong>{data.label}</strong>
      <span>{data.componentCount} components</span>
    </div>
    <code>{data.path === "" ? "components" : `components/${data.path}`}</code>
  </header>
))
CatalogGroup.displayName = "CatalogGroup"

const CatalogSurface = memo(({ data }: NodeProps<CatalogSurfaceNode>) => (
  <div
    aria-hidden="true"
    className="component-catalog-surface"
    style={{ height: data.height, width: data.width }}
  />
))
CatalogSurface.displayName = "CatalogSurface"

const designNodeTypes: NodeTypes = {
  catalogGroup: CatalogGroup,
  catalogSurface: CatalogSurface,
  page: PageFrame,
}

const resolveColorVariables = (
  value: string,
  style: CSSStyleDeclaration,
  seen = new Set<string>(),
): string | undefined => {
  let result = ""
  let cursor = 0
  let start = value.indexOf("var(")
  while (start >= 0) {
    result += value.slice(cursor, start)
    let depth = 1
    let end = start + 4
    let comma = -1
    for (; end < value.length && depth > 0; end += 1) {
      if (value[end] === "(") {
        depth += 1
      } else if (value[end] === ")") {
        depth -= 1
      } else if (value[end] === "," && depth === 1 && comma < 0) {
        comma = end
      }
    }
    if (depth !== 0) {
      return undefined
    }
    const close = end - 1
    const name = value.slice(start + 4, comma < 0 ? close : comma).trim()
    const fallback = comma < 0 ? "" : value.slice(comma + 1, close).trim()
    const replacement = style.getPropertyValue(name).trim() || fallback
    if (!name.startsWith("--") || replacement === "" || seen.has(name)) {
      return undefined
    }
    const nested = resolveColorVariables(replacement, style, new Set([...seen, name]))
    if (nested === undefined) {
      return undefined
    }
    result += nested
    cursor = end
    start = value.indexOf("var(", cursor)
  }
  return result + value.slice(cursor)
}

const SpacingCard = ({ summary }: { summary: SpacingSummary }) => (
  <article
    className="designer-inspector__spacing-card"
    data-active-source-tokens={summary.tokens.join(" ")}
    data-source-tokens={summary.tokens.join(" ")}
  >
    <div className="designer-inspector__spacing-heading">
      <h4>{summary.name}</h4>
    </div>
    <dl aria-label={`${summary.name} values`} className="designer-inspector__spacing-values">
      {spacingSides.map((side) => (
        <div key={side}>
          <dt>{side}</dt>
          <dd
            data-source-tokens={summary.sides[side]?.tokens.join(" ")}
            title={summary.sides[side]?.tokens.join(", ")}
          >
            {summary.sides[side]?.value ?? "—"}
          </dd>
        </div>
      ))}
    </dl>
  </article>
)

const SemanticCard = ({
  element,
  showHeading,
  summary,
}: {
  element: Element
  showHeading: boolean
  summary: SemanticCardSummary
}) => {
  const computedStyle = element.ownerDocument.defaultView?.getComputedStyle(element)
  const css = element.ownerDocument.defaultView?.CSS
  const colorPaint = (value: SemanticCardSummary["values"][string]): string | undefined => {
    if (value.colorProperty === undefined || computedStyle === undefined || css === undefined) {
      return undefined
    }
    const resolved = resolveColorVariables(value.generatedValue ?? value.value, computedStyle)
    if (resolved === undefined || !css.supports(value.colorProperty, resolved)) {
      return undefined
    }
    const paint = computedStyle.getPropertyValue(value.colorProperty).trim()
    return paint !== "" && css.supports("color", paint) ? paint : undefined
  }
  return (
    <article
      className="designer-inspector__spacing-card designer-inspector__semantic-card"
      data-active-source-tokens={summary.tokens.join(" ")}
      data-source-tokens={summary.tokens.join(" ")}
    >
      {showHeading ? (
        <div className="designer-inspector__spacing-heading">
          <h4>{summary.name}</h4>
        </div>
      ) : null}
      <dl aria-label={`${summary.name} values`} className="designer-inspector__semantic-values">
        {Object.entries(summary.values).map(([field, value]) => {
          const paint = colorPaint(value)
          return (
            <div key={field}>
              <dt>{field}</dt>
              <dd
                data-source-tokens={value.tokens.join(" ")}
                title={`${value.generatedValue ?? value.value} · ${value.tokens.join(", ")}`}
              >
                {paint === undefined ? null : (
                  <span
                    aria-hidden="true"
                    className="designer-inspector__color-swatch"
                    style={{ backgroundColor: paint }}
                  />
                )}
                <span className="designer-inspector__semantic-value">{value.value}</span>
              </dd>
            </div>
          )
        })}
      </dl>
    </article>
  )
}

const ElementInspector = ({
  inspection,
  onOpenComponent,
  viewport,
  viewportOptions,
}: {
  inspection: InspectedElement
  onOpenComponent: (name: string) => void
  viewport: ViewportCondition
  viewportOptions: ViewportOption[]
}) => {
  const [sections, setSections] = useState<UtilitySection[] | undefined>()
  const [inspectionError, setInspectionError] = useState<string | undefined>()
  const [inspectionAttempt, setInspectionAttempt] = useState(0)
  useEffect(() => {
    let current = true
    setSections(undefined)
    setInspectionError(undefined)
    const timeout = window.setTimeout(() => {
      if (current) {
        current = false
        setInspectionError("Utility analysis timed out.")
      }
    }, 8_000)
    void inspectWind4ClassName(inspection.className, {
      direction: inspection.direction,
      viewport,
      writingMode: inspection.writingMode,
    })
      .then((next) => {
        if (current) {
          window.clearTimeout(timeout)
          setSections(next)
        }
      })
      .catch((reason: unknown) => {
        if (current) {
          window.clearTimeout(timeout)
          setInspectionError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      current = false
      window.clearTimeout(timeout)
    }
  }, [
    inspection.className,
    inspection.direction,
    inspection.writingMode,
    inspectionAttempt,
    viewport,
  ])

  return (
    <aside
      aria-busy={sections === undefined && inspectionError === undefined}
      aria-label="Element inspector"
      className="designer-inspector"
    >
      <header className="designer-inspector__header">
        <div className="designer-inspector__title-row">
          <h2>Properties</h2>
          <code>{inspection.route}</code>
        </div>
        <div className="designer-inspector__element">
          <strong>{inspection.element.localName}</strong>
          <span>{inspection.className.split(/\s+/).filter(Boolean).length} authored classes</span>
        </div>
      </header>
      {inspection.componentName === undefined ? null : (
        <section aria-label="Component instance" className="designer-inspector__component">
          <div>
            <span>Component</span>
            <strong>{inspection.componentName}</strong>
          </div>
          <button
            aria-label={`Open ${inspection.componentName} component`}
            onClick={() => {
              if (inspection.componentName !== undefined) {
                onOpenComponent(inspection.componentName)
              }
            }}
            type="button"
          >
            <span>View component</span>
            <ArrowRight aria-hidden="true" />
          </button>
        </section>
      )}
      {inspectionError === undefined ? null : (
        <div
          className="designer-inspector__message designer-inspector__message--error"
          role="alert"
        >
          <p>{inspectionError}</p>
          <button onClick={() => setInspectionAttempt((current) => current + 1)} type="button">
            Retry
          </button>
        </div>
      )}
      {sections === undefined && inspectionError === undefined ? (
        <p aria-live="polite" className="designer-inspector__message" role="status">
          Reading utilities...
        </p>
      ) : null}
      {sections?.length === 0 ? (
        <p className="designer-inspector__message">No utility classes</p>
      ) : null}
      {sections?.map((section) => {
        const semanticCards = resolveViewportSemanticCards(
          section.semantic,
          viewport,
          viewportOptions,
        )
        return (
          <section className="designer-inspector__section" key={section.name}>
            {semanticCards.length === 0 ? null : (
              <div
                className="designer-inspector__spacing"
                data-source-tokens={[...new Set(section.semantic.map(({ token }) => token))].join(
                  " ",
                )}
              >
                {semanticCards.map((summary) => (
                  <SemanticCard
                    element={inspection.element}
                    key={summary.name}
                    showHeading
                    summary={summary}
                  />
                ))}
              </div>
            )}
            {section.spacing.length === 0 ? null : (
              <div
                className="designer-inspector__spacing"
                data-source-tokens={[
                  ...new Set(section.spacing.flatMap(({ tokens }) => tokens)),
                ].join(" ")}
              >
                {(["Padding", "Margin"] as const).map((name) => {
                  const summary = resolveViewportSpacing(
                    section.spacing,
                    name,
                    viewport,
                    viewportOptions,
                  )
                  return summary === undefined ? null : <SpacingCard key={name} summary={summary} />
                })}
              </div>
            )}
            <div className="designer-inspector__utilities">
              {section.utilities.map((utility, index) => (
                <article
                  className={`designer-inspector__utility${utility.known ? "" : " designer-inspector__utility--unknown"}`}
                  data-utility-token={utility.token}
                  key={`${utility.token}-${index}`}
                >
                  <div className="designer-inspector__utility-heading">
                    <code className="designer-inspector__token">{utility.token}</code>
                    {utility.known ? null : (
                      <span className="designer-inspector__unknown">Unknown</span>
                    )}
                  </div>
                  {utility.conditions.length === 0 ? null : (
                    <div aria-label="Conditions" className="designer-inspector__conditions">
                      {utility.conditions.map((condition) => (
                        <code key={condition}>{condition}</code>
                      ))}
                    </div>
                  )}
                  {utility.rules.map((rule, ruleIndex) => (
                    <div className="designer-inspector__rule" key={`${rule.selector}-${ruleIndex}`}>
                      <div className="designer-inspector__target">
                        <span>Target</span>
                        {[
                          ...rule.parents.filter((parent) => !parent.startsWith("@")),
                          rule.selector,
                        ].map((selector) => (
                          <code key={selector} title={selector}>
                            {selector}
                          </code>
                        ))}
                      </div>
                      {rule.parents.filter((parent) => parent.startsWith("@")).length ===
                      0 ? null : (
                        <div
                          aria-label="Generated conditions"
                          className="designer-inspector__conditions"
                        >
                          {rule.parents
                            .filter((parent) => parent.startsWith("@"))
                            .map((condition) => (
                              <code key={condition}>{condition}</code>
                            ))}
                        </div>
                      )}
                      <dl className="designer-inspector__declarations">
                        {rule.declarations.map((declaration, declarationIndex) => (
                          <div key={`${declaration.property}-${declarationIndex}`}>
                            <dt>{declaration.property}</dt>
                            <dd title={declaration.value}>{declaration.value}</dd>
                          </div>
                        ))}
                      </dl>
                    </div>
                  ))}
                </article>
              ))}
            </div>
          </section>
        )
      })}
    </aside>
  )
}

const SplatpadMark = () => (
  <svg aria-hidden="true" className="designer-header__mark" viewBox="0 0 24 24">
    <path
      d="M5.4 3.5h8.8a3 3 0 0 1 2.9 3.8l-.3 1 2.6-1.5a1.1 1.1 0 0 1 1.5 1.5l-1.5 2.5 1.1.2a1.1 1.1 0 0 1 .2 2.1l-2.8 1.2 1.2 2a1.1 1.1 0 0 1-1.5 1.5l-1.4-.8v1.6a1.9 1.9 0 0 1-1.9 1.9H5.4a1.9 1.9 0 0 1-1.9-1.9V5.4a1.9 1.9 0 0 1 1.9-1.9Z"
      fill="currentColor"
    />
    <path
      d="M13.8 7.6c-1.3-1-4.4-.9-5.2.5-.8 1.5.6 2.4 2.8 2.8 2.5.5 3.7 1.5 3 3.2-.8 2-4.1 2.4-6.3.9"
      fill="none"
      stroke="#7c3aed"
      strokeLinecap="round"
      strokeWidth="2.3"
    />
  </svg>
)

interface CanvasTheme {
  background: string
  dark: boolean
}

const defaultCanvasTheme: CanvasTheme = { background: "rgb(255, 255, 255)", dark: false }

const opaqueRgb = (document: Document, value: string): [number, number, number] | undefined => {
  const canvas = document.createElement("canvas")
  canvas.width = 1
  canvas.height = 1
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (context === null) {
    return undefined
  }
  context.clearRect(0, 0, 1, 1)
  context.fillStyle = value
  context.fillRect(0, 0, 1, 1)
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
  return alpha === 255 ? [red, green, blue] : undefined
}

const sampleRootBackground = (frame: HTMLIFrameElement): CanvasTheme => {
  const document = frame.contentDocument
  const frameWindow = document?.defaultView
  if (
    document === null ||
    document === undefined ||
    frameWindow === null ||
    frameWindow === undefined
  ) {
    return defaultCanvasTheme
  }
  const candidates = [document.body, document.documentElement]
  for (const candidate of candidates) {
    if (candidate === null) {
      continue
    }
    const background = frameWindow.getComputedStyle(candidate).backgroundColor
    const rgb = opaqueRgb(document, background)
    if (rgb !== undefined) {
      const [red, green, blue] = rgb.map((channel) => {
        const linear = channel / 255
        return linear <= 0.03928 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4
      })
      return {
        background,
        dark: red * 0.2126 + green * 0.7152 + blue * 0.0722 < 0.32,
      }
    }
  }
  return defaultCanvasTheme
}

const createRootBackgroundSnapshot = (sourceDocument: Document): string => {
  const sourceRoot = sourceDocument.documentElement
  const clonedRoot = sourceRoot.cloneNode(true) as HTMLElement
  for (const noscript of clonedRoot.querySelectorAll("noscript")) {
    noscript.remove()
  }
  for (const script of clonedRoot.querySelectorAll("script")) {
    script.remove()
  }
  for (const style of clonedRoot.querySelectorAll("style, link")) {
    style.remove()
  }
  for (const resource of clonedRoot.querySelectorAll(resourceElementSelector)) {
    for (const attribute of resourceAttributes) {
      resource.removeAttribute(attribute)
    }
    if (resource.localName === "iframe") {
      resource.setAttribute("sandbox", "")
    }
  }
  for (const element of [clonedRoot, ...clonedRoot.querySelectorAll("*")]) {
    element.removeAttribute("background")
    element.removeAttribute("manifest")
    for (let index = element.attributes.length - 1; index >= 0; index -= 1) {
      const attribute = element.attributes[index]
      if (attribute === undefined) {
        continue
      }
      if (
        attribute.name.toLowerCase().startsWith("on") ||
        cssCanLoadResource.test(attribute.value) ||
        ((attribute.name === "href" || attribute.name === "src") &&
          attribute.value.trimStart().toLowerCase().startsWith("javascript:"))
      ) {
        element.removeAttribute(attribute.name)
      }
    }
  }
  for (const refresh of clonedRoot.querySelectorAll('meta[http-equiv="refresh" i]')) {
    refresh.remove()
  }
  const head = clonedRoot.querySelector("head")
  if (head !== null) {
    const style = sourceDocument.createElement("style")
    style.textContent = inertDocumentCss(sourceDocument).css
    head.prepend(style)
  }
  return `<!doctype html>${clonedRoot.outerHTML}`
}

const Designer = () => {
  const [initialSession] = useState(readDesignerSession)
  const [routes, setRoutes] = useState<RouteRecord[]>([])
  const [components, setComponents] = useState<ComponentRecord[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [siteName, setSiteName] = useState("Splatpad")
  const [view, setView] = useState<DesignerView>(initialSession.view ?? "pages")
  const [activeRoute, setActiveRoute] = useState<string | undefined>(initialSession.activeRoute)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [componentSizes, setComponentSizes] = useState<
    Record<string, { height: number; width: number }>
  >({})
  const [canvasTheme, setCanvasTheme] = useState(defaultCanvasTheme)
  const [backgroundSnapshot, setBackgroundSnapshot] = useState<string | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [tool, setTool] = useState<DesignerTool>("pan")
  const [spacePanning, setSpacePanning] = useState(false)
  const [inspection, setInspection] = useState<InspectedElement | undefined>(undefined)
  const [outlines, setOutlines] = useState<Record<string, OutlineItem[]>>({})
  const [selectedOutlineItem, setSelectedOutlineItem] = useState<SelectedOutlineItem | undefined>(
    undefined,
  )
  const [selectionGeneration, setSelectionGeneration] = useState(0)
  const [viewportOptions, setViewportOptions] = useState<ViewportOption[]>([])
  const [viewport, setViewport] = useState<ViewportCondition>("Default")
  const flow = useRef<ReactFlowInstance<DesignNode> | undefined>(undefined)
  const iframePan = useRef<
    | {
        pointer: { x: number; y: number }
        viewport: { x: number; y: number; zoom: number }
      }
    | undefined
  >(undefined)
  const fittedRoutes = useRef("")
  const selectionClears = useRef(new Map<string, () => void>())
  const outlineSelectors = useRef(new Map<string, (item: OutlineItem) => void>())
  const pendingOutlineSelection = useRef<{ item: OutlineItem; route: string } | undefined>(
    undefined,
  )
  const componentFocusStarted = useRef(false)
  const pendingComponentFocus = useRef<string | undefined>(undefined)
  const initialViewResolved = useRef(false)
  const backgroundSampler = useRef<HTMLIFrameElement | null>(null)
  const disconnectBackgroundSampler = useRef<() => void>(() => undefined)
  const scheduleBackgroundSample = useRef<() => void>(() => undefined)
  const viewportOption = viewportOptions.find(({ condition }) => condition === viewport)
  const designItems = useMemo<DesignItem[]>(
    () =>
      view === "pages"
        ? routes.map(({ route }) => ({
            depth: route === "/" ? 0 : Math.max(0, route.split("/").filter(Boolean).length - 1),
            label: route,
            route,
          }))
        : components.map(({ name, preview, route }) => ({
            depth: Math.max(0, name.split("/").length - 1),
            label: name,
            preview,
            route,
          })),
    [components, routes, view],
  )
  const activeItem = designItems.find(({ route }) => route === activeRoute)

  const captureRootBackground = useCallback((): void => {
    const frame = document.querySelector<HTMLIFrameElement>('.page-frame__preview[title="/"]')
    const sourceDocument = frame?.contentDocument
    const canonicalRoot = new URL("/", globalThis.location.href).href
    if (
      frame === null ||
      sourceDocument === null ||
      sourceDocument === undefined ||
      sourceDocument.documentElement === null ||
      sourceDocument.body === null ||
      sourceDocument.readyState !== "complete" ||
      sourceDocument.URL !== canonicalRoot ||
      frame.contentDocument !== sourceDocument ||
      sourceDocument.defaultView?.frameElement !== frame ||
      !frame.isConnected
    ) {
      setBackgroundSnapshot(undefined)
      return
    }
    setBackgroundSnapshot(createRootBackgroundSnapshot(sourceDocument))
  }, [])

  const connectBackgroundSampler = useCallback((frame: HTMLIFrameElement | null): void => {
    disconnectBackgroundSampler.current()
    if (frame === null) {
      return
    }
    const document = frame.contentDocument
    const frameWindow = document?.defaultView
    const root = document?.documentElement
    if (
      document === null ||
      document === undefined ||
      frameWindow === null ||
      frameWindow === undefined ||
      root === null ||
      root === undefined ||
      frame.contentDocument !== document
    ) {
      return
    }

    let sampleFrame: number | undefined
    const resample = (): void => {
      sampleFrame = undefined
      if (frame.contentDocument !== document) {
        return
      }
      const nextTheme = sampleRootBackground(frame)
      setCanvasTheme((current) =>
        current.background === nextTheme.background && current.dark === nextTheme.dark
          ? current
          : nextTheme,
      )
    }
    const scheduleSample = (): void => {
      if (sampleFrame === undefined) {
        sampleFrame = frameWindow.requestAnimationFrame(resample)
      }
    }
    scheduleBackgroundSample.current = scheduleSample
    const mutationObserver = new frameWindow.MutationObserver(scheduleSample)
    if (frame.contentDocument !== document || document.documentElement !== root) {
      return
    }
    mutationObserver.observe(root, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
    document.addEventListener("load", scheduleSample, true)
    frameWindow.addEventListener("resize", scheduleSample)
    resample()
    disconnectBackgroundSampler.current = () => {
      mutationObserver.disconnect()
      document.removeEventListener("load", scheduleSample, true)
      frameWindow.removeEventListener("resize", scheduleSample)
      if (sampleFrame !== undefined) {
        frameWindow.cancelAnimationFrame(sampleFrame)
      }
      scheduleBackgroundSample.current = () => undefined
      disconnectBackgroundSampler.current = () => undefined
    }
  }, [])

  useEffect(() => () => disconnectBackgroundSampler.current(), [])

  useEffect(() => {
    if (view !== "components") {
      disconnectBackgroundSampler.current()
    }
  }, [view])

  useEffect(() => {
    if (view !== "components") {
      return
    }
    const sampleFrame = requestAnimationFrame(() => scheduleBackgroundSample.current())
    return () => cancelAnimationFrame(sampleFrame)
  }, [view, viewportOption?.width])

  useEffect(() => {
    if (!catalogLoaded || initialViewResolved.current) {
      return
    }
    initialViewResolved.current = true
    if (routes.length === 0 && components.length > 0) {
      setView("components")
      setActiveRoute((current) =>
        components.some(({ route }) => route === current) ? current : undefined,
      )
    }
  }, [catalogLoaded, components, routes])

  useEffect(() => {
    try {
      sessionStorage.setItem(designerSessionKey, JSON.stringify({ activeRoute, view }))
    } catch {
      // The designer still works when browser storage is unavailable.
    }
  }, [activeRoute, view])

  useEffect(() => {
    let current = true
    void getWind4ViewportOptions().then((options) => {
      if (current) {
        setViewportOptions(options)
      }
    })
    return () => {
      current = false
    }
  }, [])

  useEffect(() => {
    let stopped = false
    let pollTimer: number | undefined

    const loadRoutes = async (): Promise<void> => {
      try {
        const response = await fetch("/__splatpad/design/routes")
        if (!response.ok) {
          throw new Error(`Route discovery failed with status ${response.status}.`)
        }
        const payload = (await response.json()) as RouteResponse
        if (!stopped) {
          setSiteName(payload.siteName)
          setRoutes((current) =>
            current.map(({ route }) => route).join("\n") ===
            payload.routes.map(({ route }) => route).join("\n")
              ? current
              : payload.routes,
          )
          setComponents((current) =>
            current.map(({ name, preview, route }) => `${name}:${preview}:${route}`).join("\n") ===
            payload.components
              .map(({ name, preview, route }) => `${name}:${preview}:${route}`)
              .join("\n")
              ? current
              : payload.components,
          )
          setCatalogLoaded(true)
          setError(undefined)
        }
      } catch (reason: unknown) {
        if (!stopped) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      } finally {
        if (!stopped) {
          pollTimer = window.setTimeout(loadRoutes, 500)
        }
      }
    }

    void loadRoutes()

    return () => {
      stopped = true
      if (pollTimer !== undefined) {
        window.clearTimeout(pollTimer)
      }
    }
  }, [])

  const onHeight = useCallback((route: string, height: number): void => {
    setHeights((current) => (current[route] === height ? current : { ...current, [route]: height }))
  }, [])

  const onSize = useCallback((route: string, size: { height: number; width: number }): void => {
    setComponentSizes((current) => {
      const previous = current[route]
      return previous?.height === size.height && previous.width === size.width
        ? current
        : { ...current, [route]: size }
    })
  }, [])

  const selectViewport = useCallback((nextViewport: ViewportCondition): void => {
    setHeights({})
    setComponentSizes({})
    setViewport(nextViewport)
  }, [])

  const clearAllFrameSelections = useCallback((): void => {
    for (const clear of selectionClears.current.values()) {
      clear()
    }
  }, [])

  const clearSelectedElement = useCallback((): void => {
    clearAllFrameSelections()
    setInspection(undefined)
    setSelectedOutlineItem(undefined)
    setSelectionGeneration((current) => current + 1)
  }, [clearAllFrameSelections])

  const inspectElement = useCallback(
    (
      nextInspection: InspectedElement,
      select?: () => void,
      outlineItem?: SelectedOutlineItem,
    ): void => {
      if (select !== undefined) {
        clearAllFrameSelections()
        select()
      }
      setActiveRoute(nextInspection.route)
      setInspection(nextInspection)
      setSelectedOutlineItem(outlineItem)
      setSelectionGeneration((current) => current + 1)
    },
    [clearAllFrameSelections],
  )

  const registerSelectionClear = useCallback(
    (route: string, clear: (() => void) | undefined): void => {
      if (clear === undefined) {
        selectionClears.current.delete(route)
      } else {
        selectionClears.current.set(route, clear)
      }
    },
    [],
  )

  const updateOutline = useCallback((route: string, items: OutlineItem[]): void => {
    setOutlines((current) => ({ ...current, [route]: items }))
  }, [])

  const registerOutlineSelect = useCallback(
    (route: string, select: ((item: OutlineItem) => void) | undefined): void => {
      if (select === undefined) {
        outlineSelectors.current.delete(route)
      } else {
        outlineSelectors.current.set(route, select)
      }
    },
    [],
  )

  const activateTool = useCallback(
    (nextTool: DesignerTool): void => {
      if (nextTool === "pan") {
        clearSelectedElement()
        setSpacePanning(false)
      }
      setTool(nextTool)
    },
    [clearSelectedElement],
  )

  const selectView = useCallback(
    (nextView: DesignerView): void => {
      if (nextView === view) {
        return
      }
      clearSelectedElement()
      setHeights({})
      setComponentSizes({})
      setOutlines({})
      setActiveRoute(undefined)
      componentFocusStarted.current = false
      pendingComponentFocus.current = undefined
      fittedRoutes.current = ""
      if (nextView === "components") {
        captureRootBackground()
      } else {
        disconnectBackgroundSampler.current()
      }
      setView(nextView)
    },
    [captureRootBackground, clearSelectedElement, view],
  )

  const invalidateInspection = useCallback((route: string): void => {
    setInspection((current) => (current?.route === route ? undefined : current))
    setSelectedOutlineItem((current) => (current?.route === route ? undefined : current))
    setSelectionGeneration((current) => current + 1)
  }, [])

  const startViewportPan = useCallback((pointer: { x: number; y: number }): void => {
    const instance = flow.current
    if (instance === undefined) {
      return
    }

    componentFocusStarted.current = false
    pendingComponentFocus.current = undefined
    iframePan.current = { pointer, viewport: instance.getViewport() }
  }, [])

  const moveViewportPan = useCallback((pointer: { x: number; y: number }): void => {
    const instance = flow.current
    const gesture = iframePan.current
    if (instance === undefined || gesture === undefined) {
      return
    }

    void instance.setViewport({
      x: gesture.viewport.x + pointer.x - gesture.pointer.x,
      y: gesture.viewport.y + pointer.y - gesture.pointer.y,
      zoom: gesture.viewport.zoom,
    })
  }, [])

  const endViewportPan = useCallback((): void => {
    iframePan.current = undefined
  }, [])

  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.matches("input, textarea, select") || target.isContentEditable)

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isEditableTarget(event.target) || event.altKey || event.ctrlKey || event.metaKey) {
        return
      }

      switch (event.key.toLowerCase()) {
        case "v":
          event.preventDefault()
          activateTool("pan")
          break
        case "i":
          event.preventDefault()
          activateTool("inspect")
          break
        case "escape":
          if (tool === "inspect") {
            event.preventDefault()
            clearSelectedElement()
          }
          break
        case " ":
          if (tool === "inspect") {
            event.preventDefault()
            setSpacePanning(true)
          }
          break
      }
    }

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === " ") {
        setSpacePanning(false)
      }
    }

    const resetTemporaryPan = (): void => setSpacePanning(false)
    const onVisibilityChange = (): void => {
      if (document.visibilityState !== "visible") {
        resetTemporaryPan()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", resetTemporaryPan)
    document.addEventListener("visibilitychange", onVisibilityChange)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", resetTemporaryPan)
      document.removeEventListener("visibilitychange", onVisibilityChange)
      resetTemporaryPan()
    }
  }, [activateTool, clearSelectedElement, tool])

  useEffect(() => {
    if (inspection !== undefined && !designItems.some(({ route }) => route === inspection.route)) {
      clearSelectedElement()
    }
  }, [clearSelectedElement, designItems, inspection])

  useEffect(() => {
    if (!catalogLoaded) {
      return
    }
    if (activeRoute === undefined || !designItems.some(({ route }) => route === activeRoute)) {
      setActiveRoute(designItems[0]?.route)
    }
  }, [activeRoute, catalogLoaded, designItems])

  const focusRoute = useCallback(
    (route: string): void => {
      clearSelectedElement()
      setActiveRoute(route)
      const instance = flow.current
      const node = instance?.getNode(route)
      const canvas = document.querySelector<HTMLElement>(".designer-canvas")
      const width = node?.measured?.width ?? node?.width
      const height = node?.measured?.height ?? node?.height
      if (
        instance !== undefined &&
        node !== undefined &&
        canvas !== null &&
        width !== undefined &&
        height !== undefined
      ) {
        const zoom = Math.min(
          1,
          Math.max(
            0.18,
            Math.min((canvas.clientWidth - 96) / width, (canvas.clientHeight - 96) / height),
          ),
        )
        void instance.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
          duration: 250,
          zoom,
        })
      }
    },
    [clearSelectedElement],
  )

  const openComponent = useCallback(
    (name: string): void => {
      const component = components.find((candidate) => candidate.name === name)
      if (component === undefined) {
        return
      }
      clearSelectedElement()
      setHeights({})
      setComponentSizes({})
      setOutlines({})
      fittedRoutes.current = ""
      componentFocusStarted.current = false
      pendingComponentFocus.current = component.route
      captureRootBackground()
      setActiveRoute(component.route)
      setView("components")
    },
    [captureRootBackground, clearSelectedElement, components],
  )

  const focusOutlineElement = useCallback((route: string, element: Element): void => {
    const instance = flow.current
    const node = instance?.getNode(route)
    const canvas = document.querySelector<HTMLElement>(".designer-canvas")
    if (instance === undefined || node === undefined || canvas === null || !element.isConnected) {
      return
    }

    const bounds = element.getBoundingClientRect()
    const width = Math.max(1, bounds.width)
    const height = Math.max(1, bounds.height)
    const zoom = Math.min(
      1.5,
      Math.max(
        0.18,
        Math.min(
          (canvas.clientWidth - 160) / Math.max(width, 160),
          (canvas.clientHeight - 160) / Math.max(height, 100),
        ),
      ),
    )
    void instance.setCenter(
      node.position.x + bounds.left + width / 2,
      node.position.y + frameHeaderHeight + bounds.top + height / 2,
      { duration: 250, zoom },
    )
  }, [])

  const selectOutlineItem = useCallback(
    (item: OutlineItem): void => {
      const route = activeRoute
      if (route === undefined || !item.element.isConnected) {
        return
      }
      if (tool === "inspect") {
        const select = outlineSelectors.current.get(route)
        if (select !== undefined) {
          select(item)
        }
        return
      }
      pendingOutlineSelection.current = {
        item,
        route,
      }
      setTool("inspect")
      setSpacePanning(false)
    },
    [activeRoute, tool],
  )

  useEffect(() => {
    const pending = pendingOutlineSelection.current
    if (tool !== "inspect" || pending === undefined || pending.route !== activeRoute) {
      return
    }
    const frame = requestAnimationFrame(() => {
      const current = pendingOutlineSelection.current
      if (current !== pending) {
        return
      }
      pendingOutlineSelection.current = undefined
      const select = outlineSelectors.current.get(pending.route)
      if (select !== undefined) {
        select(pending.item)
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [activeRoute, tool])

  const nodes = useMemo<DesignNode[]>(() => {
    if (viewportOption === undefined) {
      return []
    }
    const createFrameNode = (
      route: string,
      height: number,
      width: number,
      position: { x: number; y: number },
    ): PageNode => ({
      id: route,
      type: "page",
      data: {
        contentHeight: height,
        inspecting: tool === "inspect",
        interactive: tool === "inspect" && !spacePanning,
        kind: view === "components" ? "component" : "page",
        label: designItems.find((item) => item.route === route)?.label ?? route,
        measurementWidth: viewport === "Default" ? 240 : width,
        preview: designItems.find((item) => item.route === route)?.preview,
        onHeight,
        onInspect: inspectElement,
        onInvalidate: invalidateInspection,
        onOutline: updateOutline,
        onPanEnd: endViewportPan,
        onPanMove: moveViewportPan,
        onPanStart: startViewportPan,
        onRegisterSelectionClear: registerSelectionClear,
        onRegisterOutlineSelect: registerOutlineSelect,
        onSize,
        route,
        selectedRoute: activeRoute,
        selectionGeneration,
        viewportWidth: width,
      },
      draggable: false,
      height: height + frameHeaderHeight,
      selectable: false,
      width,
      position,
    })

    if (view === "pages") {
      const positioned = layoutDesignRoutes(
        designItems.map(({ route }) => ({
          route,
          height: heights[route] ?? initialFrameHeight,
        })),
      )
      const horizontalScale = (viewportOption.width + 120) / (frameWidth + 120)
      return positioned.map(({ route, height, position }) =>
        createFrameNode(route, height, viewportOption.width, {
          x: position.x * horizontalScale,
          y: position.y,
        }),
      )
    }

    const layout = layoutDesignComponents(
      designItems.map(({ label, route }) => {
        const measured = componentSizes[route]
        const defaultWidth = viewport === "Default" ? 360 : Math.max(240, viewportOption.width)
        return {
          height: measured?.height ?? 240,
          name: label,
          route,
          width:
            viewport === "Default"
              ? Math.min(viewportOption.width, 720, Math.max(240, measured?.width ?? defaultWidth))
              : defaultWidth,
        }
      }),
    )
    if (layout.components.length === 0) {
      return []
    }
    const surfacePadding = 48
    const contentWidth = Math.max(
      ...layout.components.map(({ position, width }) => position.x + width),
      ...layout.groups.map(({ position, width }) => position.x + width),
    )
    const contentHeight = Math.max(
      ...layout.components.map(({ height, position }) => position.y + height + frameHeaderHeight),
      ...layout.groups.map(({ height, position }) => position.y + height),
    )
    return [
      {
        id: "component-catalog-surface",
        type: "catalogSurface",
        data: {
          height: contentHeight + surfacePadding * 2,
          width: contentWidth + surfacePadding * 2,
        },
        draggable: false,
        height: contentHeight + surfacePadding * 2,
        selectable: false,
        width: contentWidth + surfacePadding * 2,
        position: { x: -surfacePadding, y: -surfacePadding },
        zIndex: -1,
      } satisfies CatalogSurfaceNode,
      ...layout.groups.map<CatalogGroupNode>((group) => ({
        id: `component-group:${group.name || "root"}`,
        type: "catalogGroup",
        data: {
          componentCount: group.componentCount,
          label: group.label,
          path: group.name,
        },
        draggable: false,
        height: 32,
        selectable: false,
        width: group.width,
        position: group.position,
      })),
      ...layout.components.map(({ route, height, position, width }) =>
        createFrameNode(route, height, width, position),
      ),
    ]
  }, [
    endViewportPan,
    heights,
    inspectElement,
    activeRoute,
    componentSizes,
    designItems,
    invalidateInspection,
    moveViewportPan,
    onHeight,
    onSize,
    registerOutlineSelect,
    registerSelectionClear,
    selectionGeneration,
    spacePanning,
    startViewportPan,
    tool,
    updateOutline,
    viewportOption,
    view,
  ])

  useEffect(() => {
    const pendingRoute = pendingComponentFocus.current
    const allComponentsMeasured = designItems.every(
      ({ route }) => heights[route] !== undefined && componentSizes[route] !== undefined,
    )
    if (view !== "components" || pendingRoute === undefined || !allComponentsMeasured) {
      return
    }
    if (!componentFocusStarted.current) {
      componentFocusStarted.current = true
      focusRoute(pendingRoute)
    }
    const timer = window.setTimeout(() => {
      if (pendingComponentFocus.current !== pendingRoute) {
        return
      }
      fittedRoutes.current = `${view}\n${viewport}\n${designItems
        .map(({ route }) => route)
        .join("\n")}`
      componentFocusStarted.current = false
      pendingComponentFocus.current = undefined
      focusRoute(pendingRoute)
    }, 500)
    return () => window.clearTimeout(timer)
  }, [componentSizes, designItems, focusRoute, heights, nodes, view, viewport])

  useEffect(() => {
    const routeKey = `${view}\n${viewport}\n${designItems.map(({ route }) => route).join("\n")}`
    const allFramesMeasured = designItems.every(({ route }) => heights[route] !== undefined)

    if (
      !allFramesMeasured ||
      fittedRoutes.current === routeKey ||
      pendingComponentFocus.current !== undefined
    ) {
      return
    }

    fittedRoutes.current = routeKey
    if (view === "components") {
      void flow.current?.setViewport({ x: 72, y: 72, zoom: 0.78 }, { duration: 200 })
    } else {
      void flow.current?.fitView({ duration: 200, padding: 0.08 })
    }
  }, [designItems, heights, nodes, view, viewport])

  if (error !== undefined) {
    return <main className="designer-state designer-state--error">{error}</main>
  }
  if (!catalogLoaded) {
    return <main className="designer-state">Loading site routes...</main>
  }
  if (viewportOption === undefined) {
    return <main className="designer-state">Reading viewport breakpoints...</main>
  }

  return (
    <main className="designer">
      <header className="designer-header" aria-label="Editor header">
        <div className="designer-header__brand">
          <SplatpadMark />
        </div>
        <div className="designer-header__location">
          <strong>{siteName}</strong>
          <code>{activeItem?.label ?? (view === "pages" ? "/" : "Components")}</code>
        </div>
        <label className="designer-viewport-control">
          <span>Viewport</span>
          <select
            aria-label="Viewport breakpoint"
            onChange={(event) => selectViewport(event.target.value)}
            value={viewport}
          >
            {viewportOptions.map((option) => (
              <option key={option.condition} value={option.condition}>
                {option.label}
                {option.threshold === "" ? "" : ` (${option.threshold})`}
              </option>
            ))}
          </select>
        </label>
      </header>

      <div className="designer-workspace">
        <aside aria-label="Site outline" className="designer-routes">
          <nav aria-label="Design views" className="designer-routes__views">
            <button
              aria-label="Pages"
              aria-pressed={view === "pages"}
              onClick={() => selectView("pages")}
              type="button"
            >
              <File aria-hidden="true" />
              <span>Pages</span>
              <strong>{routes.length}</strong>
            </button>
            <button
              aria-label="Components"
              aria-pressed={view === "components"}
              onClick={() => selectView("components")}
              type="button"
            >
              <Box aria-hidden="true" />
              <span>Components</span>
              <strong>{components.length}</strong>
            </button>
          </nav>
          <section className="designer-routes__section">
            <header>
              <h2>{view === "pages" ? "Pages" : "Components"}</h2>
              <span>{designItems.length}</span>
            </header>
            <nav aria-label={view === "pages" ? "Site pages" : "Site components"}>
              {designItems.map(({ depth, label, preview, route }) => (
                <button
                  aria-current={route === activeRoute ? "page" : undefined}
                  key={route}
                  onClick={() => {
                    componentFocusStarted.current = false
                    pendingComponentFocus.current = undefined
                    focusRoute(route)
                  }}
                  style={{ paddingLeft: 12 + depth * 14 }}
                  title={
                    preview === undefined
                      ? label
                      : `${label} (${preview === "authored" ? "design preview" : "automatic preview"})`
                  }
                  type="button"
                >
                  {depth > 0 ? (
                    <ChevronRight aria-hidden="true" />
                  ) : view === "pages" ? (
                    <File aria-hidden="true" />
                  ) : (
                    <Box aria-hidden="true" />
                  )}
                  <span>{label}</span>
                </button>
              ))}
              {designItems.length === 0 ? (
                <p className="designer-routes__empty">
                  {view === "pages" ? "No pages found." : "No components found."}
                </p>
              ) : null}
            </nav>
          </section>
          <section className="designer-routes__section designer-outline">
            <header>
              <h2>Outline</h2>
              <span>{activeRoute === undefined ? 0 : (outlines[activeRoute]?.length ?? 0)}</span>
            </header>
            <nav aria-label="Page outline">
              <div role="tree">
                {(activeRoute === undefined ? [] : (outlines[activeRoute] ?? [])).map((item) => {
                  const Icon =
                    item.kind === "component"
                      ? ComponentIcon
                      : item.kind === "frame"
                        ? Box
                        : item.kind === "svg"
                          ? Image
                          : Type
                  return (
                    <button
                      aria-keyshortcuts="Shift+Enter"
                      aria-level={item.depth + 1}
                      aria-selected={
                        selectedOutlineItem !== undefined &&
                        selectedOutlineItem.route === activeRoute &&
                        selectedOutlineItem.id === item.id &&
                        selectedOutlineItem.kind === item.kind
                      }
                      data-outline-kind={item.kind}
                      key={item.id}
                      onDoubleClick={() => {
                        if (activeRoute !== undefined) {
                          focusOutlineElement(activeRoute, item.element)
                        }
                      }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && event.shiftKey && activeRoute !== undefined) {
                          event.preventDefault()
                          focusOutlineElement(activeRoute, item.element)
                        }
                      }}
                      onClick={() => selectOutlineItem(item)}
                      role="treeitem"
                      style={{ paddingLeft: 12 + item.depth * 14 }}
                      title={`${item.label} · Double-click or Shift+Enter to zoom`}
                      type="button"
                    >
                      <Icon aria-hidden="true" />
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </nav>
          </section>
        </aside>

        <section
          aria-label="Design canvas"
          className={`designer-canvas${view === "components" ? " designer-canvas--components" : ""}${canvasTheme.dark ? " designer-canvas--dark" : ""}`}
          data-canvas-background={canvasTheme.background}
          style={
            view === "components"
              ? ({ "--component-canvas": canvasTheme.background } as CSSProperties)
              : undefined
          }
        >
          {view === "components" ? (
            <iframe
              aria-hidden="true"
              className="designer-canvas__background-sampler"
              onLoad={(event) => connectBackgroundSampler(event.currentTarget)}
              ref={backgroundSampler}
              sandbox="allow-same-origin"
              src={backgroundSnapshot === undefined ? "/" : undefined}
              srcDoc={backgroundSnapshot}
              style={{
                border: 0,
                height: 1,
                opacity: 0,
                pointerEvents: "none",
                position: "absolute",
                visibility: "hidden",
                width: viewportOption.width,
              }}
              tabIndex={-1}
              title=""
            />
          ) : null}
          <ReactFlow
            elementsSelectable={false}
            fitView={view === "pages"}
            fitViewOptions={{ padding: 0.08 }}
            maxZoom={1.5}
            minZoom={0.02}
            nodeTypes={designNodeTypes}
            nodes={nodes}
            nodesConnectable={false}
            nodesDraggable={false}
            onPaneClick={() => {
              if (tool === "inspect") {
                clearSelectedElement()
              }
            }}
            onInit={(instance) => {
              flow.current = instance
            }}
            panOnDrag={tool === "pan" || spacePanning ? [0, 1] : [1]}
            panOnScroll
            preventScrolling
            zoomOnDoubleClick={false}
          >
            <Background color="#3f3f46" gap={24} size={1} variant={BackgroundVariant.Dots} />
            <Controls position="bottom-right" showInteractive={false} />
          </ReactFlow>
          <nav aria-label="Canvas tools" className="designer-toolbar">
            <button
              aria-label="Pan tool (V)"
              aria-pressed={tool === "pan"}
              className="designer-toolbar__button"
              onClick={() => activateTool("pan")}
              title="Pan (V)"
              type="button"
            >
              <Hand aria-hidden="true" />
              <span>Pan</span>
            </button>
            <button
              aria-label="Inspect tool (I)"
              aria-pressed={tool === "inspect"}
              className="designer-toolbar__button"
              onClick={() => activateTool("inspect")}
              title="Inspect (I)"
              type="button"
            >
              <MousePointer2 aria-hidden="true" />
              <span>Inspect</span>
            </button>
          </nav>
        </section>

        <section aria-label="Properties panel" className="designer-properties">
          {inspection === undefined ? (
            <aside className="designer-properties__empty">
              <h2>Properties</h2>
              <p>Choose Inspect, then select an element on the canvas.</p>
            </aside>
          ) : (
            <ElementInspector
              inspection={inspection}
              onOpenComponent={openComponent}
              viewport={viewport}
              viewportOptions={viewportOptions}
            />
          )}
        </section>
      </div>

      <footer className="designer-footer" aria-label="Editor status">
        <span className="designer-footer__status">
          <i aria-hidden="true" /> Ready
        </span>
        <span>
          {designItems.length} {view}
        </span>
        <code>{activeItem?.label ?? (view === "pages" ? "/" : "Components")}</code>
        <span className="designer-footer__viewport">
          {viewportOption.label} · {viewportOption.width}px
        </span>
      </footer>
    </main>
  )
}

const root = document.querySelector("#root")
if (root === null) {
  throw new Error("Splatpad designer root element was not found.")
}
createRoot(root).render(<Designer />)
