// oxlint-disable unicorn/no-array-sort -- Sorting fresh entry arrays keeps ES2022 support.
export const frameWidth = 1_440
export const initialFrameHeight = 900
export const frameHeaderHeight = 44
export const horizontalGap = 120
export const verticalGap = 120
export const routeBandGap = 200

export interface DesignRoute {
  height: number
  route: string
}

export interface PositionedDesignRoute extends DesignRoute {
  position: { x: number; y: number }
}

interface RouteTreeNode {
  children: Map<string, RouteTreeNode>
  route?: DesignRoute
}

interface LayoutResult {
  height: number
  routes: PositionedDesignRoute[]
}

const createTreeNode = (): RouteTreeNode => ({ children: new Map() })

const routeSegments = (route: string): string[] =>
  route === "/" ? [] : route.split("/").filter(Boolean)

const buildRouteTree = (
  routes: readonly DesignRoute[],
): {
  rootRoute?: DesignRoute
  topLevel: RouteTreeNode[]
} => {
  const root = createTreeNode()
  let rootRoute: DesignRoute | undefined

  for (const route of routes) {
    const segments = routeSegments(route.route)
    if (segments.length === 0) {
      rootRoute = route
      continue
    }

    let node = root
    for (const segment of segments) {
      let child = node.children.get(segment)
      if (child === undefined) {
        child = createTreeNode()
        node.children.set(segment, child)
      }
      node = child
    }
    node.route = route
  }

  return {
    rootRoute,
    topLevel: [...root.children.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, node]) => node),
  }
}

const sortedChildren = (node: RouteTreeNode): RouteTreeNode[] =>
  [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, child]) => child)

const layoutTreeNode = (node: RouteTreeNode, depth: number, top: number): LayoutResult => {
  const routes: PositionedDesignRoute[] = []
  const childDepth = node.route === undefined ? depth : depth + 1
  let childTop = top
  let childrenHeight = 0

  for (const child of sortedChildren(node)) {
    const childLayout = layoutTreeNode(child, childDepth, childTop)
    routes.push(...childLayout.routes)
    childTop += childLayout.height + verticalGap
    childrenHeight += childLayout.height + verticalGap
  }

  if (childrenHeight > 0) {
    childrenHeight -= verticalGap
  }

  const ownHeight = node.route === undefined ? 0 : node.route.height + frameHeaderHeight

  if (node.route !== undefined) {
    routes.unshift({
      ...node.route,
      position: {
        x: depth * (frameWidth + horizontalGap),
        y: top,
      },
    })
  }

  return {
    height: Math.max(ownHeight, childrenHeight),
    routes,
  }
}

export const layoutDesignRoutes = (routes: readonly DesignRoute[]): PositionedDesignRoute[] => {
  const tree = buildRouteTree(routes)
  const positioned: PositionedDesignRoute[] = []
  let top = 0

  if (tree.rootRoute !== undefined) {
    positioned.push({ ...tree.rootRoute, position: { x: 0, y: top } })
    top += tree.rootRoute.height + frameHeaderHeight + routeBandGap
  }

  for (const node of tree.topLevel) {
    const layout = layoutTreeNode(node, 0, top)
    positioned.push(...layout.routes)
    top += layout.height + routeBandGap
  }

  return positioned
}
