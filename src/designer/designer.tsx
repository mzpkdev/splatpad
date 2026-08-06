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
  contentHeight: number
  inspecting: boolean
  interactive: boolean
  onHeight: (route: string, height: number) => void
  onInspect: (inspection: InspectedElement, select: () => void) => void
  onInvalidate: (route: string) => void
  onPanEnd: () => void
  onPanMove: (position: { x: number; y: number }) => void
  onPanStart: (position: { x: number; y: number }) => void
  onRegisterSelectionClear: (route: string, clear: (() => void) | undefined) => void
  route: string
  selectedRoute: string | undefined
  selectionGeneration: number
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
  const { inspecting, onInspect, onInvalidate, onPanEnd, onPanMove, onPanStart, route } = data
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const interactionSurfaceRef = useRef<HTMLDivElement | null>(null)
  const measurementFrame = useRef<number | undefined>(undefined)
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

  const clearMarkers = useCallback((): void => {
    hoveredElement.current = undefined
    hitElement.current = undefined
    lastInspectionClick.current = undefined
    selectedElement.current = undefined
    primaryInspection.current = undefined
    updateOverlays.current()
  }, [])

  const clearSelection = useCallback((): void => {
    hitElement.current = undefined
    lastInspectionClick.current = undefined
    selectedElement.current = undefined
    primaryInspection.current = undefined
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
      const interactionSurface = interactionSurfaceRef.current
      if (document === null || interactionSurface === null || !inspecting) {
        return
      }

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

        onInspect({ className: nextSelection.getAttribute("class") ?? "", route }, () => {
          hitElement.current = candidate.element
          lastInspectionClick.current = event.timeStamp
          selectedElement.current = nextSelection
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
        disconnectInspector.current = () => undefined
      }
    },
    [clearMarkers, inspecting, onInspect, onInvalidate, onPanEnd, onPanMove, onPanStart, route],
  )

  useEffect(() => {
    data.onRegisterSelectionClear(route, clearSelection)
    return () => data.onRegisterSelectionClear(route, undefined)
  }, [clearSelection, data, route])

  useEffect(() => {
    const frame = frameRef.current
    if (frame !== null) {
      connectInspector(frame)
    }
    return () => disconnectInspector.current()
  }, [connectInspector])

  useEffect(() => {
    if (data.selectedRoute !== route) {
      selectedElement.current = undefined
      hitElement.current = undefined
      lastInspectionClick.current = undefined
      updateOverlays.current()
    }
  }, [data.selectedRoute, data.selectionGeneration, route])

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
      <div
        aria-hidden="true"
        className="page-frame__interaction-surface"
        ref={interactionSurfaceRef}
        style={{ height: data.contentHeight }}
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
  const [selectionGeneration, setSelectionGeneration] = useState(0)
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
    (nextInspection: InspectedElement, select: () => void): void => {
      clearAllFrameSelections()
      select()
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
    if (inspection !== undefined && !routes.some(({ route }) => route === inspection.route)) {
      clearSelectedElement()
    }
  }, [clearSelectedElement, inspection, routes])

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
        contentHeight: height,
        inspecting: tool === "inspect",
        interactive: tool === "inspect" && !spacePanning,
        onHeight,
        onInspect: inspectElement,
        onInvalidate: invalidateInspection,
        onPanEnd: endViewportPan,
        onPanMove: moveViewportPan,
        onPanStart: startViewportPan,
        onRegisterSelectionClear: registerSelectionClear,
        route,
        selectedRoute: inspection?.route,
        selectionGeneration,
      },
      draggable: false,
      height: height + frameHeaderHeight,
      selectable: false,
      width: frameWidth,
    }))
  }, [
    endViewportPan,
    heights,
    inspectElement,
    inspection?.route,
    invalidateInspection,
    moveViewportPan,
    onHeight,
    routes,
    registerSelectionClear,
    selectionGeneration,
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
