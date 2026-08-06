import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react"
import type { Node, NodeProps, NodeTypes, ReactFlowInstance } from "@xyflow/react"
import { Hand, MousePointer2 } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { frameHeaderHeight, frameWidth, initialFrameHeight, layoutDesignRoutes } from "./layout"

interface RouteRecord {
  route: string
}

interface RouteResponse {
  routes: RouteRecord[]
}

type DesignerTool = "inspect" | "pan"

interface InspectedElement {
  className: string
  route: string
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

  const clearMarkers = useCallback((): void => {
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

  const connectInspector = useCallback(
    (frame: HTMLIFrameElement): void => {
      disconnectInspector.current()
      clearMarkers()

      const document = frame.contentDocument
      if (document === null || !inspecting) {
        return
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
        const viewportWidth = document.documentElement.clientWidth
        const viewportHeight = document.documentElement.clientHeight
        const left = frameLeft + Math.max(0, Math.min(viewportWidth, bounds.left)) * frameScaleX
        const top = frameTop + Math.max(0, Math.min(viewportHeight, bounds.top)) * frameScaleY
        const right = frameLeft + Math.max(0, Math.min(viewportWidth, bounds.right)) * frameScaleX
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
        updateOverlayPositions()
        onInspect({ className: nextSelection.getAttribute("class") ?? "", route })
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
        style={{ height: data.contentHeight }}
        tabIndex={-1}
        title={data.route}
      />
    </article>
  )
})
PageFrame.displayName = "PageFrame"

const nodeTypes: NodeTypes = { page: PageFrame }

const Designer = () => {
  const [routes, setRoutes] = useState<RouteRecord[]>([])
  const [heights, setHeights] = useState<Record<string, number>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const [tool, setTool] = useState<DesignerTool>("pan")
  const [spacePanning, setSpacePanning] = useState(false)
  const [inspection, setInspection] = useState<InspectedElement | undefined>(undefined)
  const [clearInspection, setClearInspection] = useState(0)
  const flow = useRef<ReactFlowInstance<PageNode> | undefined>(undefined)
  const iframePan = useRef<
    | {
        pointer: { x: number; y: number }
        viewport: { x: number; y: number; zoom: number }
      }
    | undefined
  >(undefined)
  const fittedRoutes = useRef("")

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
    const positioned = layoutDesignRoutes(
      routes.map(({ route }) => ({
        route,
        height: heights[route] ?? initialFrameHeight,
      })),
    )

    return positioned.map(({ route, height, position }) => ({
      id: route,
      type: "page",
      position,
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
      },
      draggable: false,
      height: height + frameHeaderHeight,
      selectable: false,
      width: frameWidth,
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
  ])

  useEffect(() => {
    const routeKey = routes.map(({ route }) => route).join("\n")
    const allFramesMeasured = routes.every(({ route }) => heights[route] !== undefined)

    if (!allFramesMeasured || fittedRoutes.current === routeKey) {
      return
    }

    fittedRoutes.current = routeKey
    void flow.current?.fitView({ duration: 200, padding: 0.08 })
  }, [heights, nodes, routes])

  if (error !== undefined) {
    return <main className="designer-state designer-state--error">{error}</main>
  }
  if (routes.length === 0) {
    return <main className="designer-state">Loading site routes...</main>
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
        <aside aria-label="Element inspector" className="designer-inspector">
          <code>{inspection.className}</code>
        </aside>
      )}
    </main>
  )
}

const root = document.querySelector("#root")
if (root === null) {
  throw new Error("Splatpad designer root element was not found.")
}
createRoot(root).render(<Designer />)
