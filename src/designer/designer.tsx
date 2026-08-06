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

interface PageNodeData extends Record<string, unknown> {
  contentHeight: number
  onHeight: (route: string, height: number) => void
  route: string
}

type PageNode = Node<PageNodeData, "page">

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
  const measurementFrame = useRef<number | undefined>(undefined)

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

  useEffect(
    () => () => {
      if (measurementFrame.current !== undefined) {
        cancelAnimationFrame(measurementFrame.current)
      }
    },
    [],
  )

  return (
    <article className="page-frame" data-route={data.route}>
      <header className="page-frame__header">{data.route}</header>
      <iframe
        aria-label={`Preview of ${data.route}`}
        className="page-frame__preview"
        onLoad={(event) => measureFrame(event.currentTarget)}
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
      data: { contentHeight: height, onHeight, route },
      draggable: false,
      height: height + frameHeaderHeight,
      selectable: false,
      width: frameWidth,
    }))
  }, [heights, onHeight, routes])

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
        onInit={(instance) => {
          flow.current = instance
        }}
        panOnDrag
        panOnScroll
        preventScrolling
        zoomOnDoubleClick={false}
      >
        <Background color="#d0d0d0" gap={24} size={1} variant={BackgroundVariant.Dots} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
    </main>
  )
}

const root = document.querySelector("#root")
if (root === null) {
  throw new Error("Splatpad designer root element was not found.")
}
createRoot(root).render(<Designer />)
