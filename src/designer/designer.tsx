import { Background, BackgroundVariant, Controls, ReactFlow } from "@xyflow/react"
import type { Node, NodeProps, NodeTypes, ReactFlowInstance } from "@xyflow/react"
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
  onSpacePanning: (active: boolean) => void
  route: string
}

type PageNode = Node<PageNodeData, "page">

const hoverAttribute = "data-splatpad-inspector-hover"
const selectedAttribute = "data-splatpad-inspector-selected"
const inspectorStyleId = "splatpad-inspector-styles"

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
      outline: 2px solid #2563eb !important;
      outline-offset: -2px !important;
    }
    [${selectedAttribute}] {
      outline: 2px solid #7c3aed !important;
      outline-offset: -2px !important;
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
  const { inspecting, onActivateTool, onClearInspection, onInspect, onSpacePanning, route } = data
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const measurementFrame = useRef<number | undefined>(undefined)
  const hoveredElement = useRef<Element | undefined>(undefined)
  const selectedElement = useRef<Element | undefined>(undefined)
  const disconnectInspector = useRef<() => void>(() => undefined)

  const clearMarkers = useCallback((): void => {
    hoveredElement.current?.removeAttribute(hoverAttribute)
    selectedElement.current?.removeAttribute(selectedAttribute)
    hoveredElement.current = undefined
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

        if (event.button !== 0) {
          return
        }
        const element = eventElement(event, document)
        if (element === undefined) {
          return
        }

        selectedElement.current?.removeAttribute(selectedAttribute)
        selectedElement.current = element
        element.setAttribute(selectedAttribute, "")
        onInspect({ className: element.getAttribute("class") ?? "", route })
      }

      const blockAction = (event: Event): void => {
        event.preventDefault()
        event.stopImmediatePropagation()
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
      document.addEventListener("pointerup", blockAction, true)
      document.addEventListener("click", blockAction, true)
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
        document.removeEventListener("pointerup", blockAction, true)
        document.removeEventListener("click", blockAction, true)
        document.removeEventListener("dblclick", blockAction, true)
        document.removeEventListener("contextmenu", blockAction, true)
        document.removeEventListener("submit", blockAction, true)
        document.removeEventListener("wheel", onWheel, true)
        document.removeEventListener("keydown", onKeyDown, true)
        document.removeEventListener("keyup", onKeyUp, true)
        style.remove()
        clearMarkers()
        disconnectInspector.current = () => undefined
      }
    },
    [clearMarkers, inspecting, onActivateTool, onClearInspection, onInspect, onSpacePanning, route],
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
        panOnDrag={tool === "pan" || spacePanning}
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
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M7 11V7a2 2 0 0 1 4 0v3-5a2 2 0 0 1 4 0v5-3a2 2 0 0 1 4 0v7c0 4.4-3.6 8-8 8h-1.2a8 8 0 0 1-6.4-3.2L1.8 16a2 2 0 0 1 3-2.6L7 15.2V11Z" />
          </svg>
        </button>
        <button
          aria-label="Inspect tool (I)"
          aria-pressed={tool === "inspect"}
          className="designer-toolbar__button"
          onClick={() => activateTool("inspect")}
          title="Inspect (I)"
          type="button"
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="m5 3 14 8-6 2-2 6L5 3Z" />
          </svg>
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
