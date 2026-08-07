import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react"
import type { Node, NodeProps, NodeTypes, ReactFlowInstance } from "@xyflow/react"
import { Hand, MousePointer2 } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { frameHeaderHeight, frameWidth, initialFrameHeight, layoutDesignRoutes } from "./layout"
import {
  getWind4ViewportOptions,
  inspectWind4ClassName,
  resolveViewportSemanticCards,
  resolveViewportSpacing,
} from "./wind4-inspector"
import { spacingSides } from "./wind4-inspector"
import type {
  SpacingSummary,
  SemanticCardSummary,
  UtilitySection,
  ViewportCondition,
  ViewportOption,
} from "./wind4-inspector"

interface RouteRecord {
  route: string
}

interface RouteResponse {
  routes: RouteRecord[]
}

type DesignerTool = "inspect" | "pan"

interface InspectedElement {
  className: string
  direction: "ltr" | "rtl"
  element: Element
  route: string
  writingMode: string
}

interface PageNodeData extends Record<string, unknown> {
  clearInspection: number
  contentHeight: number
  inspecting: boolean
  interactive: boolean
  onActivateTool: (tool: DesignerTool) => void
  onClearInspection: () => void
  onHeight: (route: string, height: number) => void
  onInspect: (inspection: InspectedElement) => void
  onInvalidate: (route: string) => void
  onPanEnd: () => void
  onPanMove: (position: { x: number; y: number }) => void
  onPanStart: (position: { x: number; y: number }) => void
  onSpacePanning: (active: boolean) => void
  route: string
  viewportWidth: number
}

type PageNode = Node<PageNodeData, "page">

const hoverAttribute = "data-splatpad-inspector-hover"
const selectedAttribute = "data-splatpad-inspector-selected"
const overlayAttribute = "data-splatpad-inspector-overlay"
const inspectorStyleId = "splatpad-inspector-styles"
const inspectionClickStreakMs = 500

const eventElement = (event: Event, document: Document): Element | undefined => {
  const ElementConstructor = document.defaultView?.Element
  return ElementConstructor !== undefined && event.target instanceof ElementConstructor
    ? event.target
    : undefined
}

const installInspectorStyles = (document: Document): HTMLStyleElement => {
  const existing = document.querySelector<HTMLStyleElement>(`#${inspectorStyleId}`)
  if (existing !== null) {
    return existing
  }

  const style = document.createElement("style")
  style.id = inspectorStyleId
  style.textContent = `
    * { cursor: crosshair !important; }
  `
  document.head.append(style)
  return style
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

const pointerPosition = (
  frame: HTMLIFrameElement,
  event: PointerEvent,
): { x: number; y: number } => {
  const bounds = frame.getBoundingClientRect()
  const scaleX = frame.offsetWidth === 0 ? 1 : bounds.width / frame.offsetWidth
  const scaleY = frame.offsetHeight === 0 ? 1 : bounds.height / frame.offsetHeight
  return {
    x: bounds.left + event.clientX * scaleX,
    y: bounds.top + event.clientY * scaleY,
  }
}

const PageFrame = memo(({ data }: NodeProps<PageNode>) => {
  const {
    inspecting,
    onActivateTool,
    onClearInspection,
    onInspect,
    onInvalidate,
    onPanEnd,
    onPanMove,
    onPanStart,
    onSpacePanning,
    route,
    viewportWidth,
  } = data
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const measurementFrame = useRef<number | undefined>(undefined)
  const hoveredElement = useRef<Element | undefined>(undefined)
  const hitElement = useRef<Element | undefined>(undefined)
  const lastInspectionClick = useRef<number | undefined>(undefined)
  const selectedElement = useRef<Element | undefined>(undefined)
  const middlePan = useRef<{ capture: Element; pointerId: number } | undefined>(undefined)
  const updateOverlays = useRef<() => void>(() => undefined)
  const disconnectInspector = useRef<() => void>(() => undefined)
  const disconnectSelectionRefresh = useRef<() => void>(() => undefined)

  const inspectElement = useCallback(
    (element: Element): void => {
      const frame = frameRef.current
      if (frame === null) {
        return
      }
      const document = frame.contentDocument
      if (document === null || !element.isConnected || element.ownerDocument !== document) {
        return
      }
      const computedStyle = document.defaultView?.getComputedStyle(element)
      onInspect({
        className: element.getAttribute("class") ?? "",
        direction: computedStyle?.direction === "rtl" ? "rtl" : "ltr",
        element,
        route,
        writingMode: computedStyle?.writingMode ?? "horizontal-tb",
      })
    },
    [onInspect, route],
  )

  const clearMarkers = useCallback((): void => {
    disconnectSelectionRefresh.current()
    hoveredElement.current?.removeAttribute(hoverAttribute)
    selectedElement.current?.removeAttribute(selectedAttribute)
    hoveredElement.current = undefined
    hitElement.current = undefined
    lastInspectionClick.current = undefined
    selectedElement.current = undefined
    updateOverlays.current()
  }, [])

  const measureFrame = useCallback(
    (frame: HTMLIFrameElement): void => {
      if (measurementFrame.current !== undefined) {
        cancelAnimationFrame(measurementFrame.current)
      }
      const document = frame.contentDocument
      if (document === null) {
        return
      }

      const measure = (): void => {
        const height = documentHeight(document)
        if (height > 0) {
          data.onHeight(data.route, height)
        }
      }

      const scheduleMeasure = (): void => {
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

  useEffect(() => {
    const frame = frameRef.current
    if (frame !== null) {
      measureFrame(frame)
    }
  }, [measureFrame, viewportWidth])

  const connectInspector = useCallback(
    (frame: HTMLIFrameElement): void => {
      disconnectInspector.current()
      clearMarkers()

      const document = frame.contentDocument
      if (document === null || !inspecting) {
        return
      }

      const connectSelectionRefresh = (element: Element): void => {
        disconnectSelectionRefresh.current()
        const frameWindow = document.defaultView
        if (frameWindow === null) {
          return
        }

        let refreshFrame: number | undefined
        const observer = new frameWindow.MutationObserver(() => {
          if (refreshFrame !== undefined) {
            return
          }
          refreshFrame = frameWindow.requestAnimationFrame(() => {
            refreshFrame = undefined
            if (element === selectedElement.current && element.isConnected) {
              inspectElement(element)
            }
          })
        })
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
        disconnectSelectionRefresh.current = () => {
          observer.disconnect()
          if (refreshFrame !== undefined) {
            frameWindow.cancelAnimationFrame(refreshFrame)
          }
          disconnectSelectionRefresh.current = () => undefined
        }
      }

      const style = installInspectorStyles(document)
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
      prepareOverlay(hoverOverlay, "#2563eb", 2_147_483_646)
      prepareOverlay(selectedOverlay, "#7c3aed", 2_147_483_647)
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

      const onPointerOver = (event: PointerEvent): void => {
        const element = eventElement(event, document)
        if (element === undefined || element === hoveredElement.current) {
          return
        }

        hoveredElement.current?.removeAttribute(hoverAttribute)
        hoveredElement.current = element
        element.setAttribute(hoverAttribute, "")
        updateOverlayPositions()
      }

      const onPointerOut = (event: PointerEvent): void => {
        if (event.relatedTarget !== null) {
          return
        }
        hoveredElement.current?.removeAttribute(hoverAttribute)
        hoveredElement.current = undefined
        updateOverlayPositions()
      }

      const onPointerDown = (event: PointerEvent): void => {
        event.preventDefault()
        event.stopImmediatePropagation()

        const element = eventElement(event, document)
        if (event.button === 1) {
          const capture = element ?? document.documentElement
          try {
            capture.setPointerCapture(event.pointerId)
          } catch {
            middlePan.current = undefined
            onPanEnd()
            return
          }
          middlePan.current = { capture, pointerId: event.pointerId }
          capture.addEventListener("lostpointercapture", onLostPointerCapture)
          onPanStart(pointerPosition(frame, event))
          return
        }
        if (event.button !== 0 || element === undefined) {
          return
        }

        const currentSelection = selectedElement.current
        const continuesClickStreak =
          hitElement.current === element &&
          currentSelection !== undefined &&
          lastInspectionClick.current !== undefined &&
          event.timeStamp - lastInspectionClick.current <= inspectionClickStreakMs
        const nextSelection =
          continuesClickStreak && currentSelection !== undefined
            ? (currentSelection.parentElement ?? currentSelection)
            : element
        selectedElement.current?.removeAttribute(selectedAttribute)
        hitElement.current = element
        lastInspectionClick.current = event.timeStamp
        selectedElement.current = nextSelection
        nextSelection.setAttribute(selectedAttribute, "")
        connectSelectionRefresh(nextSelection)
        updateOverlayPositions()
        inspectElement(nextSelection)
      }

      const blockAction = (event: Event): void => {
        event.preventDefault()
        event.stopImmediatePropagation()
      }

      const onPointerMove = (event: PointerEvent): void => {
        const current = middlePan.current
        if (current === undefined || current.pointerId !== event.pointerId) {
          return
        }

        event.preventDefault()
        event.stopImmediatePropagation()
        onPanMove(pointerPosition(frame, event))
      }

      const onPointerUp = (event: PointerEvent): void => {
        endMiddlePan(event.pointerId, true)
        blockAction(event)
      }

      const onLostPointerCapture = (event: Event): void => {
        endMiddlePan((event as PointerEvent).pointerId, false)
      }

      const onWheel = (event: WheelEvent): void => {
        event.preventDefault()
        event.stopImmediatePropagation()

        const frameBounds = frame.getBoundingClientRect()
        const scale = frame.offsetWidth === 0 ? 1 : frameBounds.width / frame.offsetWidth
        frame.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: frameBounds.left + event.clientX * scale,
            clientY: frameBounds.top + event.clientY * scale,
            ctrlKey: event.ctrlKey,
            deltaMode: event.deltaMode,
            deltaX: event.deltaX,
            deltaY: event.deltaY,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
          }),
        )
      }

      const onKeyDown = (event: KeyboardEvent): void => {
        if (event.altKey || event.ctrlKey || event.metaKey) {
          blockAction(event)
          return
        }

        switch (event.key.toLowerCase()) {
          case "v":
            event.preventDefault()
            event.stopImmediatePropagation()
            frame.ownerDocument.defaultView?.focus()
            onActivateTool("pan")
            break
          case "i":
            event.preventDefault()
            event.stopImmediatePropagation()
            break
          case "escape":
            event.preventDefault()
            event.stopImmediatePropagation()
            onClearInspection()
            break
          case " ":
            event.preventDefault()
            event.stopImmediatePropagation()
            onSpacePanning(true)
            break
          default:
            blockAction(event)
        }
      }

      const onKeyUp = (event: KeyboardEvent): void => {
        if (event.key === " ") {
          onSpacePanning(false)
        }
        blockAction(event)
      }

      document.addEventListener("pointerover", onPointerOver, true)
      document.addEventListener("pointerout", onPointerOut, true)
      document.addEventListener("pointerdown", onPointerDown, true)
      document.addEventListener("pointermove", onPointerMove, true)
      document.addEventListener("pointerup", onPointerUp, true)
      document.addEventListener("pointercancel", onPointerUp, true)
      document.addEventListener("click", blockAction, true)
      document.addEventListener("auxclick", blockAction, true)
      document.addEventListener("dblclick", blockAction, true)
      document.addEventListener("contextmenu", blockAction, true)
      document.addEventListener("submit", blockAction, true)
      document.addEventListener("wheel", onWheel, { capture: true, passive: false })
      document.addEventListener("keydown", onKeyDown, true)
      document.addEventListener("keyup", onKeyUp, true)

      disconnectInspector.current = () => {
        document.removeEventListener("pointerover", onPointerOver, true)
        document.removeEventListener("pointerout", onPointerOut, true)
        document.removeEventListener("pointerdown", onPointerDown, true)
        document.removeEventListener("pointermove", onPointerMove, true)
        document.removeEventListener("pointerup", onPointerUp, true)
        document.removeEventListener("pointercancel", onPointerUp, true)
        document.removeEventListener("click", blockAction, true)
        document.removeEventListener("auxclick", blockAction, true)
        document.removeEventListener("dblclick", blockAction, true)
        document.removeEventListener("contextmenu", blockAction, true)
        document.removeEventListener("submit", blockAction, true)
        document.removeEventListener("wheel", onWheel, true)
        document.removeEventListener("keydown", onKeyDown, true)
        document.removeEventListener("keyup", onKeyUp, true)
        disconnectSelectionRefresh.current()
        if (overlayFrame !== undefined) {
          overlayWindow?.cancelAnimationFrame(overlayFrame)
        }
        style.remove()
        const currentPan = middlePan.current
        if (currentPan !== undefined) {
          endMiddlePan(currentPan.pointerId, true)
        }
        clearMarkers()
        hoverOverlay.remove()
        selectedOverlay.remove()
        updateOverlays.current = () => undefined
        disconnectInspector.current = () => undefined
      }
    },
    [
      clearMarkers,
      inspecting,
      inspectElement,
      onActivateTool,
      onClearInspection,
      onInspect,
      onInvalidate,
      onPanEnd,
      onPanMove,
      onPanStart,
      onSpacePanning,
      route,
    ],
  )

  useEffect(() => {
    const frame = frameRef.current
    if (frame !== null) {
      connectInspector(frame)
    }
    return () => disconnectInspector.current()
  }, [connectInspector])

  useEffect(() => {
    clearMarkers()
  }, [clearMarkers, data.clearInspection])

  useEffect(() => {
    const element = selectedElement.current
    if (element === undefined) {
      return
    }
    const refreshFrame = requestAnimationFrame(() => {
      if (element !== selectedElement.current || !element.isConnected) {
        if (element === selectedElement.current) {
          onInvalidate(route)
        }
        return
      }
      inspectElement(element)
    })
    return () => cancelAnimationFrame(refreshFrame)
  }, [inspectElement, onInvalidate, route, viewportWidth])

  useEffect(
    () => () => {
      if (measurementFrame.current !== undefined) {
        cancelAnimationFrame(measurementFrame.current)
      }
    },
    [],
  )

  return (
    <article
      className={`page-frame${data.interactive ? " page-frame--interactive" : ""}`}
      data-route={data.route}
      style={{ width: viewportWidth }}
    >
      <header className="page-frame__header">{data.route}</header>
      <iframe
        aria-label={`Preview of ${data.route}`}
        className="page-frame__preview"
        onLoad={(event) => {
          measureFrame(event.currentTarget)
          data.onInvalidate(data.route)
          connectInspector(event.currentTarget)
        }}
        ref={frameRef}
        src={data.route}
        style={{ height: data.contentHeight, width: viewportWidth }}
        tabIndex={-1}
        title={data.route}
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
  let resolvedValue = ""
  let cursor = 0
  let start = value.indexOf("var(", cursor)
  while (start >= 0) {
    resolvedValue += value.slice(cursor, start)
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
    const nameEnd = comma < 0 ? close : comma
    const name = value.slice(start + 4, nameEnd).trim()
    const declared = style.getPropertyValue(name).trim()
    const fallback = comma < 0 ? "" : value.slice(comma + 1, close).trim()
    const resolved = declared || fallback
    if (!name.startsWith("--") || resolved === "" || seen.has(name)) {
      return undefined
    }
    const nested = resolveColorVariables(resolved, style, new Set([...seen, name]))
    if (nested === undefined) {
      return undefined
    }
    resolvedValue += nested
    cursor = end
    start = value.indexOf("var(", cursor)
  }
  return resolvedValue + value.slice(cursor)
}

const SpacingCard = ({
  allTokens,
  name,
  summary,
}: {
  allTokens: string[]
  name: "Margin" | "Padding"
  summary: SpacingSummary
}) => {
  return (
    <article
      className="designer-inspector__spacing-card"
      data-active-source-tokens={summary.tokens.join(" ")}
      data-source-tokens={allTokens.join(" ")}
    >
      <div className="designer-inspector__spacing-heading">
        <h4>{name}</h4>
      </div>
      <dl aria-label={`${name} values`} className="designer-inspector__spacing-values">
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
}

const SemanticCard = ({
  allTokens,
  element,
  summary,
}: {
  allTokens: string[]
  element: Element
  summary: SemanticCardSummary
}) => {
  const computedStyle = element.ownerDocument.defaultView?.getComputedStyle(element)
  const css = element.ownerDocument.defaultView?.CSS
  const colorPaint = (semantic: SemanticCardSummary["values"][string]): string | undefined => {
    if (semantic.colorProperty === undefined || computedStyle === undefined || css === undefined) {
      return undefined
    }
    const generatedValue = semantic.generatedValue ?? semantic.value
    const variablesResolved = resolveColorVariables(generatedValue, computedStyle)
    if (
      variablesResolved === undefined ||
      !css.supports(semantic.colorProperty, variablesResolved)
    ) {
      return undefined
    }
    const paint = computedStyle.getPropertyValue(semantic.colorProperty).trim()
    return paint !== "" && css.supports("color", paint) ? paint : undefined
  }

  return (
    <article
      className="designer-inspector__spacing-card designer-inspector__semantic-card"
      data-active-source-tokens={summary.tokens.join(" ")}
      data-source-tokens={allTokens.join(" ")}
    >
      <div className="designer-inspector__spacing-heading">
        <h4>{summary.name}</h4>
      </div>
      <dl aria-label={`${summary.name} values`} className="designer-inspector__semantic-values">
        {Object.entries(summary.values).map(([field, semantic]) => {
          const paint = colorPaint(semantic)
          return (
            <div key={field}>
              <dt>{field}</dt>
              <dd
                data-source-tokens={semantic.tokens.join(" ")}
                title={`${semantic.generatedValue ?? semantic.value} · ${semantic.tokens.join(", ")}`}
              >
                {paint === undefined ? null : (
                  <span
                    aria-hidden="true"
                    className="designer-inspector__color-swatch"
                    style={{ backgroundColor: paint }}
                  />
                )}
                <span className="designer-inspector__semantic-value">{semantic.value}</span>
              </dd>
            </div>
          )
        })}
      </dl>
    </article>
  )
}

const ElementInspector = ({
  className,
  direction,
  element,
  viewport,
  viewportOptions,
  writingMode,
}: {
  className: string
  direction: "ltr" | "rtl"
  element: Element
  viewport: ViewportCondition
  viewportOptions: ViewportOption[]
  writingMode: string
}) => {
  const [sections, setSections] = useState<UtilitySection[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let current = true
    setSections(undefined)
    setError(undefined)
    void inspectWind4ClassName(className, { direction, viewport, writingMode })
      .then((nextSections) => {
        if (current) {
          setSections(nextSections)
        }
      })
      .catch((reason: unknown) => {
        if (current) {
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      })
    return () => {
      current = false
    }
  }, [className, direction, viewport, writingMode])

  return (
    <aside
      aria-busy={sections === undefined && error === undefined}
      aria-label="Element inspector"
      className="designer-inspector"
    >
      <header className="designer-inspector__header">
        <h2>Properties</h2>
      </header>
      {error === undefined ? null : (
        <p className="designer-inspector__message designer-inspector__message--error" role="alert">
          {error}
        </p>
      )}
      {error !== undefined || sections !== undefined ? null : (
        <p aria-live="polite" className="designer-inspector__message" role="status">
          Reading utilities...
        </p>
      )}
      {sections?.length === 0 ? (
        <p aria-live="polite" className="designer-inspector__message" role="status">
          No utility classes
        </p>
      ) : null}
      {sections?.map((section) => (
        <section className="designer-inspector__section" key={section.name}>
          <h3>{section.name}</h3>
          {section.semantic.length === 0 ? null : (
            <div
              className="designer-inspector__spacing"
              data-source-tokens={[...new Set(section.semantic.map(({ token }) => token))].join(
                " ",
              )}
            >
              {resolveViewportSemanticCards(section.semantic, viewport, viewportOptions).map(
                (summary) => (
                  <SemanticCard
                    allTokens={[
                      ...new Set(
                        section.semantic
                          .filter(({ card }) => card === summary.name)
                          .map(({ token }) => token),
                      ),
                    ]}
                    element={element}
                    key={summary.name}
                    summary={summary}
                  />
                ),
              )}
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
                const allTokens = section.spacing
                  .filter((candidate) => candidate.name === name)
                  .flatMap(({ tokens }) => tokens)
                return summary === undefined ? null : (
                  <SpacingCard allTokens={allTokens} key={name} name={name} summary={summary} />
                )
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
                    {rule.parents.filter((parent) => parent.startsWith("@")).length === 0 ? null : (
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
      ))}
    </aside>
  )
}

const Designer = () => {
  const [routes, setRoutes] = useState<RouteRecord[]>([])
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [tool, setTool] = useState<DesignerTool>("pan")
  const [spacePanning, setSpacePanning] = useState(false)
  const [inspection, setInspection] = useState<InspectedElement | undefined>(undefined)
  const [clearInspection, setClearInspection] = useState(0)
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
  const viewportOption = viewportOptions.find(({ condition }) => condition === viewport)

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
          setRoutes((current) =>
            current.map(({ route }) => route).join("\n") ===
            payload.routes.map(({ route }) => route).join("\n")
              ? current
              : payload.routes,
          )
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

  const clearSelectedElement = useCallback((): void => {
    setInspection(undefined)
    setClearInspection((current) => current + 1)
  }, [])

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

  const invalidateInspection = useCallback((route: string): void => {
    setInspection((current) => (current?.route === route ? undefined : current))
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

    const onBlur = (): void => setSpacePanning(false)
    window.addEventListener("keydown", onKeyDown)
    window.addEventListener("keyup", onKeyUp)
    window.addEventListener("blur", onBlur)
    return () => {
      window.removeEventListener("keydown", onKeyDown)
      window.removeEventListener("keyup", onKeyUp)
      window.removeEventListener("blur", onBlur)
    }
  }, [activateTool, clearSelectedElement, tool])

  const nodes = useMemo<PageNode[]>(() => {
    if (viewportOption === undefined) {
      return []
    }
    const positioned = layoutDesignRoutes(
      routes.map(({ route }) => ({
        route,
        height: heights[route] ?? initialFrameHeight,
      })),
    )

    const horizontalScale = (viewportOption.width + 120) / (frameWidth + 120)
    return positioned.map(({ route, height, position }) => ({
      id: route,
      type: "page",
      data: {
        clearInspection,
        contentHeight: height,
        inspecting: tool === "inspect",
        interactive: tool === "inspect" && !spacePanning,
        onActivateTool: activateTool,
        onClearInspection: clearSelectedElement,
        onHeight,
        onInspect: setInspection,
        onInvalidate: invalidateInspection,
        onPanEnd: endViewportPan,
        onPanMove: moveViewportPan,
        onPanStart: startViewportPan,
        onSpacePanning: setSpacePanning,
        route,
        viewportWidth: viewportOption.width,
      },
      draggable: false,
      height: height + frameHeaderHeight,
      selectable: false,
      width: viewportOption.width,
      position: { x: position.x * horizontalScale, y: position.y },
    }))
  }, [
    activateTool,
    clearInspection,
    clearSelectedElement,
    endViewportPan,
    heights,
    invalidateInspection,
    moveViewportPan,
    onHeight,
    routes,
    spacePanning,
    startViewportPan,
    tool,
    viewportOption?.width,
  ])

  useEffect(() => {
    const routeKey = `${viewport}\n${routes.map(({ route }) => route).join("\n")}`
    const allFramesMeasured = routes.every(({ route }) => heights[route] !== undefined)

    if (!allFramesMeasured || fittedRoutes.current === routeKey) {
      return
    }

    fittedRoutes.current = routeKey
    void flow.current?.fitView({ duration: 200, padding: 0.08 })
  }, [heights, nodes, routes, viewport])

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
        <Background color="#d0d0d0" gap={24} size={1} variant={BackgroundVariant.Dots} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
      <label className="designer-viewport-control">
        <span>Viewport</span>
        <select
          aria-label="Viewport breakpoint"
          onChange={(event) => setViewport(event.target.value as ViewportCondition)}
          value={viewport}
        >
          {viewportOptions.map((option) => (
            <option key={option.condition} value={option.condition}>
              {option.label}
              {option.threshold === "" ? "" : ` — ${option.threshold}`}
            </option>
          ))}
        </select>
      </label>
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
        </button>
      </nav>
      {inspection === undefined ? null : (
        <ElementInspector
          className={inspection.className}
          direction={inspection.direction}
          element={inspection.element}
          viewport={viewport}
          viewportOptions={viewportOptions}
          writingMode={inspection.writingMode}
          key={`${inspection.route}\u0000${inspection.className}\u0000${inspection.direction}\u0000${inspection.writingMode}`}
        />
      )}
    </main>
  )
}

const root = document.querySelector("#root")
if (root === null) {
  throw new Error("Splatpad designer root element was not found.")
}
createRoot(root).render(<Designer />)
