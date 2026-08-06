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
  onPan: (delta: { x: number; y: number }) => void
  onSpacePanning: (active: boolean) => void
  route: string
}

type PageNode = Node<PageNodeData, "page">

const hoverAttribute = "data-splatpad-inspector-hover"
const selectedAttribute = "data-splatpad-inspector-selected"
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
    [${hoverAttribute}] {
      box-shadow: inset 0 0 0 2px #2563eb !important;
    }
    [${selectedAttribute}] {
      box-shadow: inset 0 0 0 2px #7c3aed !important;
    }
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

const PageFrame = memo(({ data }: NodeProps<PageNode>) => {
  const { inspecting, onActivateTool, onClearInspection, onInspect, onPan, onSpacePanning, route } =
    data
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const measurementFrame = useRef<number | undefined>(undefined)
  const hoveredElement = useRef<Element | undefined>(undefined)
  const hitElement = useRef<Element | undefined>(undefined)
  const lastInspectionClick = useRef<number | undefined>(undefined)
  const selectedElement = useRef<Element | undefined>(undefined)
  const middlePan = useRef<{ pointerId: number; x: number; y: number } | undefined>(undefined)
  const disconnectInspector = useRef<() => void>(() => undefined)

  const clearMarkers = useCallback((): void => {
    hoveredElement.current?.removeAttribute(hoverAttribute)
    selectedElement.current?.removeAttribute(selectedAttribute)
    hoveredElement.current = undefined
    hitElement.current = undefined
    lastInspectionClick.current = undefined
    selectedElement.current = undefined
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

      const onPointerOver = (event: PointerEvent): void => {
        const element = eventElement(event, document)
        if (element === undefined || element === hoveredElement.current) {
          return
        }

        hoveredElement.current?.removeAttribute(hoverAttribute)
        hoveredElement.current = element
        element.setAttribute(hoverAttribute, "")
      }

      const onPointerOut = (event: PointerEvent): void => {
        if (event.relatedTarget !== null) {
          return
        }
        hoveredElement.current?.removeAttribute(hoverAttribute)
        hoveredElement.current = undefined
      }

      const onPointerDown = (event: PointerEvent): void => {
        event.preventDefault()
        event.stopImmediatePropagation()

        const element = eventElement(event, document)
        if (event.button === 1) {
          middlePan.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY }
          element?.setPointerCapture(event.pointerId)
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
        onPan({ x: event.screenX - current.x, y: event.screenY - current.y })
        middlePan.current = { pointerId: event.pointerId, x: event.screenX, y: event.screenY }
      }

      const onPointerUp = (event: PointerEvent): void => {
        const current = middlePan.current
        if (current !== undefined && current.pointerId === event.pointerId) {
          const element = eventElement(event, document)
          if (element?.hasPointerCapture(event.pointerId)) {
            element.releasePointerCapture(event.pointerId)
          }
          middlePan.current = undefined
        }
        blockAction(event)
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
        style.remove()
        middlePan.current = undefined
        clearMarkers()
        disconnectInspector.current = () => undefined
      }
    },
    [
      clearMarkers,
      inspecting,
      onActivateTool,
      onClearInspection,
      onInspect,
      onPan,
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

  const panViewport = useCallback((delta: { x: number; y: number }): void => {
    const instance = flow.current
    if (instance === undefined) {
      return
    }
    const viewport = instance.getViewport()
    void instance.setViewport({
      x: viewport.x + delta.x,
      y: viewport.y + delta.y,
      zoom: viewport.zoom,
    })
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
        onPan: panViewport,
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
    heights,
    invalidateInspection,
    onHeight,
    panViewport,
    routes,
    spacePanning,
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
