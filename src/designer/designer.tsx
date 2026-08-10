import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react"
import type { Node, NodeProps, NodeTypes, ReactFlowInstance } from "@xyflow/react"
import { Box, ChevronRight, File, Hand, Image, MousePointer2, Type } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { frameHeaderHeight, frameWidth, initialFrameHeight, layoutDesignRoutes } from "./layout"
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
  direction: "ltr" | "rtl"
  element: Element
  route: string
  writingMode: string
}

type OutlineKind = "frame" | "svg" | "text"

interface OutlineItem {
  depth: number
  element: Element
  id: string
  kind: OutlineKind
  label: string
}

interface PageNodeData extends Record<string, unknown> {
  contentHeight: number
  inspecting: boolean
  interactive: boolean
  label: string
  onHeight: (route: string, height: number) => void
  onInspect: (inspection: InspectedElement, select?: () => void) => void
  onInvalidate: (route: string) => void
  onOutline: (route: string, items: OutlineItem[]) => void
  onPanEnd: () => void
  onPanMove: (position: { x: number; y: number }) => void
  onPanStart: (position: { x: number; y: number }) => void
  onRegisterSelectionClear: (route: string, clear: (() => void) | undefined) => void
  onRegisterOutlineSelect: (route: string, select: ((element: Element) => void) | undefined) => void
  route: string
  selectedRoute: string | undefined
  selectionGeneration: number
  viewportWidth: number
}

type PageNode = Node<PageNodeData, "page">

const overlayAttribute = "data-splatpad-inspector-overlay"
const inspectionClickStreakMs = 500
const inspectionClickMovement = 4

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
  const hoveredElement = useRef<Element | undefined>(undefined)
  const hitElement = useRef<Element | undefined>(undefined)
  const lastInspectionClick = useRef<number | undefined>(undefined)
  const selectedElement = useRef<Element | undefined>(undefined)
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
  const disconnectOutline = useRef<() => void>(() => undefined)
  const connectSelectionRefresh = useRef<(element: Element) => void>(() => undefined)
  const outlineIds = useRef(new WeakMap<Element, string>())
  const nextOutlineId = useRef(0)

  const inspectElement = useCallback(
    (element: Element, select?: () => void): void => {
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
          direction: computedStyle?.direction === "rtl" ? "rtl" : "ltr",
          element,
          route,
          writingMode: computedStyle?.writingMode ?? "horizontal-tb",
        },
        select,
      )
    },
    [onInspect, route],
  )

  const selectOutlineElement = useCallback(
    (element: Element): void => {
      if (!element.isConnected) {
        return
      }
      inspectElement(element, () => {
        hitElement.current = element
        lastInspectionClick.current = undefined
        selectedElement.current = element
        connectSelectionRefresh.current(element)
        updateOverlays.current()
      })
    },
    [inspectElement],
  )

  const connectOutline = useCallback(
    (frame: HTMLIFrameElement): void => {
      disconnectOutline.current()
      const document = frame.contentDocument
      const frameWindow = document?.defaultView
      if (
        document === null ||
        document === undefined ||
        frameWindow === null ||
        frameWindow === undefined
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
        const elements =
          document.body === null ? [] : [document.body, ...document.body.querySelectorAll("*")]
        const described = elements
          .map(describe)
          .filter((item): item is Omit<OutlineItem, "depth" | "id"> => item !== undefined)
        const qualifying = new Set(described.map(({ element }) => element))
        const items = described.map(({ element, kind, label }) => {
          let depth = 0
          for (
            let ancestor = element.parentElement;
            ancestor !== null;
            ancestor = ancestor.parentElement
          ) {
            if (qualifying.has(ancestor)) {
              depth += 1
            }
          }
          let id = outlineIds.current.get(element)
          if (id === undefined) {
            id = `${route}:${nextOutlineId.current}`
            nextOutlineId.current += 1
            outlineIds.current.set(element, id)
          }
          return { depth, element, id, kind, label }
        })
        onOutline(route, items)
      }
      const scheduleOutline = (): void => {
        if (outlineFrame === undefined) {
          outlineFrame = frameWindow.requestAnimationFrame(refreshOutline)
        }
      }
      const observer = new frameWindow.MutationObserver(scheduleOutline)
      observer.observe(document.documentElement, {
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
    selectedElement.current = undefined
    primaryInspection.current = undefined
    updateOverlays.current()
  }, [])

  const clearSelection = useCallback((): void => {
    disconnectSelectionRefresh.current()
    hitElement.current = undefined
    lastInspectionClick.current = undefined
    selectedElement.current = undefined
    primaryInspection.current = undefined
    updateOverlays.current()
  }, [])

  const measureFrame = useCallback(
    (frame: HTMLIFrameElement): void => {
      const generation = ++measurementGeneration.current
      if (measurementFrame.current !== undefined) {
        cancelAnimationFrame(measurementFrame.current)
        measurementFrame.current = undefined
      }
      const document = frame.contentDocument
      if (document === null) {
        return
      }

      const isCurrentDocument = (): boolean =>
        measurementGeneration.current === generation && frame.contentDocument === document

      const measure = (): void => {
        if (!isCurrentDocument()) {
          return
        }
        measurementFrame.current = undefined
        const height = documentHeight(document)
        if (height > 0 && isCurrentDocument()) {
          data.onHeight(data.route, height)
        }
      }

      const scheduleMeasure = (): void => {
        if (!isCurrentDocument()) {
          return
        }
        if (measurementFrame.current !== undefined) {
          cancelAnimationFrame(measurementFrame.current)
        }
        measurementFrame.current = requestAnimationFrame(measure)
      }

      scheduleMeasure()
      void document.fonts.ready.then(scheduleMeasure)
    },
    [data],
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
        if (frameWindow === null) {
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
              inspectElement(element)
            }
          })
        }
        const observer = new frameWindow.MutationObserver(scheduleRefresh)
        for (
          let current: Element | null = element;
          current !== null;
          current = current.parentElement
        ) {
          observer.observe(current, {
            attributeFilter: ["class", "dir", "style"],
            attributes: true,
          })
        }
        if (document.head !== null) {
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
          selectedElement.current = nextSelection
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
      hitElement.current = undefined
      lastInspectionClick.current = undefined
      updateOverlays.current()
    }
  }, [data.selectedRoute, data.selectionGeneration, route])

  useEffect(() => {
    const frame = frameRef.current
    if (frame !== null) {
      measureFrame(frame)
    }
    const element = selectedElement.current
    if (element === undefined) {
      return
    }
    const refreshFrame = requestAnimationFrame(() => {
      if (element === selectedElement.current && element.isConnected) {
        inspectElement(element)
      }
    })
    return () => cancelAnimationFrame(refreshFrame)
  }, [inspectElement, measureFrame, viewportWidth])

  useEffect(
    () => () => {
      disconnectOutline.current()
      onOutline(route, [])
      measurementGeneration.current += 1
      if (measurementFrame.current !== undefined) {
        cancelAnimationFrame(measurementFrame.current)
        measurementFrame.current = undefined
      }
    },
    [onOutline, route],
  )

  return (
    <article
      className={`page-frame${data.interactive ? " page-frame--interactive" : ""}${data.selectedRoute === route ? " page-frame--active" : ""}`}
      data-route={data.route}
      style={{ width: viewportWidth }}
    >
      <header className="page-frame__header">{data.label}</header>
      <iframe
        aria-label={`Preview of ${data.route}`}
        className="page-frame__preview"
        onLoad={(event) => {
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

const nodeTypes: NodeTypes = { page: PageFrame }

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
  viewport,
  viewportOptions,
}: {
  inspection: InspectedElement
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

const Designer = () => {
  const [initialSession] = useState(readDesignerSession)
  const [routes, setRoutes] = useState<RouteRecord[]>([])
  const [components, setComponents] = useState<ComponentRecord[]>([])
  const [catalogLoaded, setCatalogLoaded] = useState(false)
  const [siteName, setSiteName] = useState("Splatpad")
  const [view, setView] = useState<DesignerView>(initialSession.view ?? "pages")
  const [activeRoute, setActiveRoute] = useState<string | undefined>(initialSession.activeRoute)
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [tool, setTool] = useState<DesignerTool>("pan")
  const [spacePanning, setSpacePanning] = useState(false)
  const [inspection, setInspection] = useState<InspectedElement | undefined>(undefined)
  const [outlines, setOutlines] = useState<Record<string, OutlineItem[]>>({})
  const [selectionGeneration, setSelectionGeneration] = useState(0)
  const [viewportOptions, setViewportOptions] = useState<ViewportOption[]>([])
  const [viewport, setViewport] = useState<ViewportCondition>("Default")
  const flow = useRef<ReactFlowInstance<PageNode> | undefined>(undefined)
  const iframePan = useRef<
    | {
        pointer: { x: number; y: number }
        viewport: { x: number; y: number; zoom: number }
      }
    | undefined
  >(undefined)
  const fittedRoutes = useRef("")
  const selectionClears = useRef(new Map<string, () => void>())
  const outlineSelectors = useRef(new Map<string, (element: Element) => void>())
  const pendingOutlineSelection = useRef<{ element: Element; route: string } | undefined>(undefined)
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

  const selectViewport = useCallback((nextViewport: ViewportCondition): void => {
    setHeights({})
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
    setSelectionGeneration((current) => current + 1)
  }, [clearAllFrameSelections])

  const inspectElement = useCallback(
    (nextInspection: InspectedElement, select?: () => void): void => {
      if (select !== undefined) {
        clearAllFrameSelections()
        select()
      }
      setActiveRoute(nextInspection.route)
      setInspection(nextInspection)
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
    (route: string, select: ((element: Element) => void) | undefined): void => {
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
      setOutlines({})
      setActiveRoute(undefined)
      fittedRoutes.current = ""
      setView(nextView)
    },
    [clearSelectedElement, view],
  )

  const invalidateInspection = useCallback((route: string): void => {
    setInspection((current) => (current?.route === route ? undefined : current))
    setSelectionGeneration((current) => current + 1)
  }, [])

  const startViewportPan = useCallback((pointer: { x: number; y: number }): void => {
    const instance = flow.current
    if (instance === undefined) {
      return
    }

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
        outlineSelectors.current.get(route)?.(item.element)
        return
      }
      pendingOutlineSelection.current = { element: item.element, route }
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
      outlineSelectors.current.get(pending.route)?.(pending.element)
    })
    return () => cancelAnimationFrame(frame)
  }, [activeRoute, tool])

  const nodes = useMemo<PageNode[]>(() => {
    if (viewportOption === undefined) {
      return []
    }
    const positioned = layoutDesignRoutes(
      designItems.map(({ route }) => ({
        route,
        height: heights[route] ?? initialFrameHeight,
      })),
    )

    const horizontalScale = (viewportOption.width + 120) / (frameWidth + 120)
    return positioned.map(({ route, height, position }) => ({
      id: route,
      type: "page",
      data: {
        contentHeight: height,
        inspecting: tool === "inspect",
        interactive: tool === "inspect" && !spacePanning,
        label: designItems.find((item) => item.route === route)?.label ?? route,
        onHeight,
        onInspect: inspectElement,
        onInvalidate: invalidateInspection,
        onOutline: updateOutline,
        onPanEnd: endViewportPan,
        onPanMove: moveViewportPan,
        onPanStart: startViewportPan,
        onRegisterSelectionClear: registerSelectionClear,
        onRegisterOutlineSelect: registerOutlineSelect,
        route,
        selectedRoute: activeRoute,
        selectionGeneration,
        viewportWidth: viewportOption.width,
      },
      draggable: false,
      height: height + frameHeaderHeight,
      selectable: false,
      width: viewportOption.width,
      position: { x: position.x * horizontalScale, y: position.y },
    }))
  }, [
    endViewportPan,
    heights,
    inspectElement,
    activeRoute,
    designItems,
    invalidateInspection,
    moveViewportPan,
    onHeight,
    registerOutlineSelect,
    registerSelectionClear,
    selectionGeneration,
    spacePanning,
    startViewportPan,
    tool,
    updateOutline,
    viewportOption,
  ])

  useEffect(() => {
    const routeKey = `${view}\n${viewport}\n${designItems.map(({ route }) => route).join("\n")}`
    const allFramesMeasured = designItems.every(({ route }) => heights[route] !== undefined)

    if (!allFramesMeasured || fittedRoutes.current === routeKey) {
      return
    }

    fittedRoutes.current = routeKey
    void flow.current?.fitView({ duration: 200, padding: 0.08 })
  }, [designItems, heights, nodes, view, viewport])

  if (error !== undefined) {
    return <main className="designer-state designer-state--error">{error}</main>
  }
  if (routes.length === 0) {
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
                  onClick={() => focusRoute(route)}
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
                <p className="designer-routes__empty">No components found.</p>
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
                  const Icon = item.kind === "frame" ? Box : item.kind === "svg" ? Image : Type
                  return (
                    <button
                      aria-keyshortcuts="Shift+Enter"
                      aria-level={item.depth + 1}
                      aria-selected={inspection?.element === item.element}
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

        <section aria-label="Design canvas" className="designer-canvas">
          <ReactFlow
            elementsSelectable={false}
            fitView
            fitViewOptions={{ padding: 0.08 }}
            maxZoom={1.5}
            minZoom={0.02}
            nodeTypes={nodeTypes}
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
