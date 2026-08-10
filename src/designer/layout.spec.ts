import { describe, expect, it } from "vitest"
import {
  componentGap,
  frameHeaderHeight,
  frameWidth,
  horizontalGap,
  layoutDesignComponents,
  layoutDesignRoutes,
  routeBandGap,
  verticalGap,
} from "./layout"

describe("design route layout", () => {
  it("moves route depth right and stacks sibling subtrees downward", () => {
    const positioned = layoutDesignRoutes([
      { route: "/", height: 100 },
      { route: "/docs/", height: 200 },
      { route: "/docs/api/", height: 300 },
      { route: "/docs/api/auth/", height: 400 },
      { route: "/docs/api/auth/oauth/", height: 500 },
      { route: "/docs/guides/", height: 600 },
      { route: "/docs/guides/advanced/", height: 700 },
      { route: "/docs/guides/start/", height: 800 },
      { route: "/shop/", height: 900 },
    ])
    const byRoute = Object.fromEntries(positioned.map(({ route, position }) => [route, position]))
    const stride = frameWidth + horizontalGap
    const docsTop = 100 + frameHeaderHeight + routeBandGap

    expect(byRoute).toEqual({
      "/": { x: 0, y: 0 },
      "/docs/": { x: 0, y: docsTop },
      "/docs/api/": { x: stride, y: docsTop },
      "/docs/api/auth/": { x: stride * 2, y: docsTop },
      "/docs/api/auth/oauth/": { x: stride * 3, y: docsTop },
      "/docs/guides/": {
        x: stride,
        y: docsTop + 500 + frameHeaderHeight + verticalGap,
      },
      "/docs/guides/advanced/": {
        x: stride * 2,
        y: docsTop + 500 + frameHeaderHeight + verticalGap,
      },
      "/docs/guides/start/": {
        x: stride * 2,
        y: docsTop + 500 + frameHeaderHeight + verticalGap + 700 + frameHeaderHeight + verticalGap,
      },
      "/shop/": {
        x: 0,
        y:
          docsTop +
          500 +
          frameHeaderHeight +
          verticalGap +
          700 +
          frameHeaderHeight +
          verticalGap +
          800 +
          frameHeaderHeight +
          routeBandGap,
      },
    })
  })

  it("compresses missing route prefixes instead of leaving empty columns", () => {
    expect(layoutDesignRoutes([{ route: "/docs/api/reference/", height: 500 }])).toEqual([
      {
        route: "/docs/api/reference/",
        height: 500,
        position: { x: 0, y: 0 },
      },
    ])
  })
})

describe("component catalog layout", () => {
  it("groups by directory and wraps each group into compact rows", () => {
    const layout = layoutDesignComponents(
      [
        { height: 200, name: "forms/select", route: "/select/", width: 300 },
        { height: 180, name: "button", route: "/button/", width: 240 },
        { height: 220, name: "forms/input", route: "/input/", width: 400 },
        { height: 160, name: "forms/checkbox", route: "/checkbox/", width: 260 },
      ],
      720,
    )

    expect(layout.groups.map(({ label, componentCount }) => ({ label, componentCount }))).toEqual([
      { label: "Root components", componentCount: 1 },
      { label: "forms", componentCount: 3 },
    ])
    const byName = Object.fromEntries(
      layout.components.map(({ name, group, position }) => [name, { group, position }]),
    )
    expect(byName.button).toEqual({ group: "", position: { x: 0, y: 42 } })
    expect(byName["forms/checkbox"].position.x).toBe(0)
    expect(byName["forms/input"].position.x).toBeGreaterThan(0)
    expect(byName["forms/select"].position.x).toBe(0)
    expect(byName["forms/select"].position.y - byName["forms/input"].position.y).toBe(
      220 + frameHeaderHeight + componentGap,
    )
  })

  it("keeps all authored variants represented by one component entry", () => {
    const layout = layoutDesignComponents([
      { height: 320, name: "actions/button", route: "/button/", width: 720 },
    ])

    expect(layout.components).toHaveLength(1)
    expect(layout.groups[0]).toMatchObject({ componentCount: 1, label: "actions" })
  })
})
