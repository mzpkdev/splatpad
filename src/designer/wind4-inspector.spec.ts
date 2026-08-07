import { describe, expect, it, vi } from "vitest"
import {
  createUtilityInspector,
  describeSpacingCondition,
  inspectWind4ClassName,
  resolveGeneratorViewportOptions,
  resolveViewportSemanticCards,
  resolveViewportSpacing,
} from "./wind4-inspector"

const wind4Viewports = resolveGeneratorViewportOptions({
  config: {
    theme: {
      breakpoint: { "2xl": "96rem", lg: "64rem", md: "48rem", sm: "40rem", xl: "80rem" },
    },
  },
})

const resolvedSemantic = async (className: string, viewport = "Default") => {
  const sections = await inspectWind4ClassName(className)
  return resolveViewportSemanticCards(
    sections.flatMap(({ semantic }) => semantic),
    viewport,
    wind4Viewports,
  )
}

describe("Wind4 utility inspector", () => {
  it("groups ordinary utilities by their generated CSS properties", async () => {
    const sections = await inspectWind4ClassName("grid p-4 w-8 text-sm bg-red-500 border shadow")

    expect(sections.map(({ name }) => name)).toEqual([
      "Layout",
      "Spacing",
      "Size",
      "Typography",
      "Fill",
      "Border",
      "Effects",
    ])
    expect(sections[1]).toMatchObject({
      spacing: [
        {
          condition: "Default",
          name: "Padding",
          sides: {
            Bottom: { value: "4" },
            Left: { value: "4" },
            Right: { value: "4" },
            Top: { value: "4" },
          },
          sources: [
            {
              rules: [
                {
                  declarations: [{ property: "padding", value: "calc(var(--spacing) * 4)" }],
                  parents: [],
                  selector: ".p-4",
                },
              ],
              token: "p-4",
            },
          ],
          tokens: ["p-4"],
        },
      ],
      utilities: [],
    })
  })

  it("turns an arbitrary solid fill into a semantic value with provenance", async () => {
    const [section] = await inspectWind4ClassName("bg-[#123456]")

    expect(section).toMatchObject({
      name: "Fill",
      semantic: [
        {
          card: "Fill",
          field: "Background",
          token: "bg-[#123456]",
        },
      ],
      utilities: [],
    })
    const [fill] = resolveViewportSemanticCards(section!.semantic, "Default", wind4Viewports)
    expect(fill).toMatchObject({
      name: "Fill",
      tokens: ["bg-[#123456]"],
      values: { Background: { tokens: ["bg-[#123456]"] } },
    })
    expect(fill?.values.Background?.value).toContain("#123456")
  })

  it("preserves token variants and attaches generated conditions to their rule", async () => {
    const [section] = await inspectWind4ClassName("md:hover:grid")

    expect(section?.utilities[0]).toMatchObject({
      conditions: ["md", "hover"],
      rules: [{ parents: ["@media (min-width: 48rem)"] }],
      token: "md:hover:grid",
      utility: "grid",
    })
  })

  it("keeps every declaration produced by a multi-declaration utility", async () => {
    const [section] = await inspectWind4ClassName("truncate")

    expect(section?.utilities[0]?.rules).toEqual([
      {
        body: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        declarations: [
          { property: "overflow", value: "hidden" },
          { property: "text-overflow", value: "ellipsis" },
          { property: "white-space", value: "nowrap" },
        ],
        order: expect.any(Number),
        parents: [],
        selector: ".truncate",
        sort: 0,
      },
    ])
  })

  it("keeps unknown utilities visible in Other", async () => {
    const [section] = await inspectWind4ClassName("brand-widget")

    expect(section).toMatchObject({
      name: "Other",
      utilities: [
        {
          known: false,
          rules: [],
          token: "brand-widget",
          utility: "brand-widget",
        },
      ],
    })
  })

  it("keeps descendant targets for spacing and dividing utilities", async () => {
    const sections = await inspectWind4ClassName("space-x-4 divide-x")
    const inspectedUtilities = sections.flatMap(({ utilities }) => utilities)

    expect(inspectedUtilities[0]?.rules).toMatchObject([
      {
        parents: [".space-x-4"],
        selector: ":where(&>:not(:last-child))",
        declarations: [
          { property: "--un-space-x-reverse", value: "0" },
          { property: "margin-inline-start" },
          { property: "margin-inline-end" },
        ],
      },
    ])
    expect(inspectedUtilities[1]?.rules).toMatchObject([
      {
        parents: [".divide-x"],
        selector: ":where(&>:not(:last-child))",
        declarations: [
          { property: "--un-divide-x-reverse", value: "0" },
          { property: "border-left-width" },
          { property: "border-left-style" },
          { property: "border-right-width" },
          { property: "border-right-style" },
        ],
      },
    ])
  })

  it("excludes raw keyframes and property helpers from animation utilities", async () => {
    const [section] = await inspectWind4ClassName("animate-spin")

    expect(section).toMatchObject({
      name: "Effects",
      utilities: [
        {
          rules: [
            {
              declarations: [{ property: "animation", value: "spin 1s linear infinite" }],
              parents: [],
              selector: ".animate-spin",
            },
          ],
        },
      ],
    })
  })

  it("keeps generated fallback and conditional color candidates together as raw CSS", async () => {
    const [section] = await inspectWind4ClassName("bg-red-500/50")

    expect(section?.semantic).toEqual([])
    expect(section?.utilities[0]).toMatchObject({
      rules: [{ parents: [] }, { parents: ["@supports (color: color-mix(in lab, red, red))"] }],
      token: "bg-red-500/50",
    })
  })

  it("parses each unique token once and reuses the cached promise", async () => {
    const generate = vi.fn(async (tokens: string[]) => ({
      matched: new Map([[tokens[0], { data: [[0, ".p-4", "padding:1rem;", undefined]] }]]),
    }))
    const inspect = createUtilityInspector({ generate: generate as never })

    await inspect("p-4 p-4")
    await inspect("p-4")

    expect(generate).toHaveBeenCalledOnce()
  })

  it("summarizes p-3 as semantic padding on every side", async () => {
    const [spacing] = await inspectWind4ClassName("p-3")

    expect(spacing).toMatchObject({
      name: "Spacing",
      spacing: [
        {
          condition: "Default",
          name: "Padding",
          sides: {
            Bottom: { tokens: ["p-3"], value: "3" },
            Left: { tokens: ["p-3"], value: "3" },
            Right: { tokens: ["p-3"], value: "3" },
            Top: { tokens: ["p-3"], value: "3" },
          },
        },
      ],
      utilities: [],
    })
  })

  it("resolves axis utilities and side overrides by generated UnoCSS order", async () => {
    const [spacing] = await inspectWind4ClassName("pl-2 py-5 px-4 p-3")

    expect(spacing?.spacing[0]?.sides).toMatchObject({
      Bottom: { value: "5" },
      Left: { tokens: ["p-3", "px-4", "pl-2"], value: "2" },
      Right: { value: "4" },
      Top: { value: "5" },
    })
  })

  it("derives logical and physical sides from the generated declarations", async () => {
    const [spacing] = await inspectWind4ClassName("ps-3 pe-4 pt-5 pr-6 pb-7 pl-8")

    expect(spacing?.spacing[0]?.sides).toMatchObject({
      Bottom: { value: "7" },
      Left: { value: "3" },
      Right: { value: "6" },
      Top: { value: "5" },
    })
    expect(
      spacing?.spacing[0]?.sources.map(({ rules }) => rules[0]?.declarations[0]?.property),
    ).toEqual([
      "padding-inline-start",
      "padding-inline-end",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
    ])
  })

  it("keeps negative and auto source values in semantic margin", async () => {
    const [spacing] = await inspectWind4ClassName("m-auto -mt-2 mr-3")

    expect(spacing?.spacing[0]?.sides).toMatchObject({
      Bottom: { value: "auto" },
      Left: { value: "auto" },
      Right: { value: "3" },
      Top: { value: "-2" },
    })
  })

  it("shows arbitrary source values without generated calc expressions", async () => {
    const [spacing] = await inspectWind4ClassName("p-[13px]")

    expect(spacing?.spacing[0]?.sides).toMatchObject({
      Bottom: { value: "13px" },
      Left: { value: "13px" },
      Right: { value: "13px" },
      Top: { value: "13px" },
    })
  })

  it("expands generated box, block, and inline shorthand declarations", async () => {
    const [box] = await inspectWind4ClassName("p-[1px_2px_3px_4px]")
    const [axes] = await inspectWind4ClassName("py-[1px_2px] px-[3px_4px]")

    expect(box?.spacing[0]?.sides).toMatchObject({
      Bottom: { value: "3px" },
      Left: { value: "4px" },
      Right: { value: "2px" },
      Top: { value: "1px" },
    })
    expect(axes?.spacing[0]?.sides).toMatchObject({
      Bottom: { value: "2px" },
      Left: { value: "3px" },
      Right: { value: "4px" },
      Top: { value: "1px" },
    })
  })

  it("uses expanded side values for equal-component arbitrary shorthands", async () => {
    const [box] = await inspectWind4ClassName("p-[1px_1px]")
    const [axis] = await inspectWind4ClassName("py-[1px_1px]")

    expect(Object.values(box?.spacing[0]?.sides ?? {}).map(({ value }) => value)).toEqual([
      "1px",
      "1px",
      "1px",
      "1px",
    ])
    expect(axis?.spacing[0]?.sides).toMatchObject({
      Bottom: { value: "1px" },
      Top: { value: "1px" },
    })
  })

  it("decodes escaped arbitrary underscores and readable negative custom properties", async () => {
    const [padding] = await inspectWind4ClassName(String.raw`p-[var(--foo\_bar)]`)
    const [margin] = await inspectWind4ClassName("-m-[--gap]")

    expect(Object.values(padding?.spacing[0]?.sides ?? {}).map(({ value }) => value)).toEqual([
      "var(--foo_bar)",
      "var(--foo_bar)",
      "var(--foo_bar)",
      "var(--foo_bar)",
    ])
    expect(Object.values(margin?.spacing[0]?.sides ?? {}).map(({ value }) => value)).toEqual([
      "-var(--gap)",
      "-var(--gap)",
      "-var(--gap)",
      "-var(--gap)",
    ])
    expect(margin?.spacing[0]?.sources[0]?.rules[0]?.declarations).toEqual([
      { property: "margin", value: "calc(var(--gap) * -1)" },
    ])
  })

  it("summarizes viewport conditions while keeping state combinations raw", async () => {
    const [spacing] = await inspectWind4ClassName("p-3 sm:p-4 hover:px-2 sm:hover:pl-1")

    expect(spacing?.spacing.map(({ condition, sides }) => ({ condition, sides }))).toMatchObject([
      { condition: "Default", sides: { Top: { value: "3" } } },
      { condition: "sm", sides: { Top: { value: "4" } } },
    ])
    expect(spacing?.utilities.map(({ token }) => token)).toEqual(["hover:px-2", "sm:hover:pl-1"])
  })

  it("is independent of class attribute order when UnoCSS order decides the winner", async () => {
    const first = await inspectWind4ClassName("p-3 px-4 pl-2")
    const reversed = await inspectWind4ClassName("pl-2 px-4 p-3")

    expect(first[0]?.spacing[0]?.sides).toEqual(reversed[0]?.spacing[0]?.sides)
    expect(first[0]?.spacing[0]?.sides.Left?.value).toBe("2")
  })

  it("uses UnoCSS selector and body ordering when rule indices tie", async () => {
    const sideOverrides = await Promise.all(
      ["p-[13px] pl-2", "pl-2 p-[13px]"].map((className) => inspectWind4ClassName(className)),
    )
    for (const [spacing] of sideOverrides) {
      expect(spacing?.spacing[0]?.sides.Left?.value).toBe("2")
    }
    const boxOverrides = await Promise.all(
      ["p-[13px] p-4", "p-4 p-[13px]"].map((className) => inspectWind4ClassName(className)),
    )
    for (const [spacing] of boxOverrides) {
      expect(Object.values(spacing?.spacing[0]?.sides ?? {}).map(({ value }) => value)).toEqual([
        "4",
        "4",
        "4",
        "4",
      ])
    }
  })

  it("normalizes prefix and suffix important syntax before summarizing spacing", async () => {
    const importantBoxes = await Promise.all(
      ["!p-4 p-8", "p-8 p-4!"].map((className) => inspectWind4ClassName(className)),
    )
    for (const [spacing] of importantBoxes) {
      expect(Object.values(spacing?.spacing[0]?.sides ?? {}).map(({ value }) => value)).toEqual([
        "4",
        "4",
        "4",
        "4",
      ])
    }

    const [spacing] = await inspectWind4ClassName("!px-4 px-8")
    expect(spacing?.spacing[0]?.sides).toMatchObject({
      Left: { value: "4" },
      Right: { value: "4" },
    })
  })

  it("keeps mixed-effect accessibility utilities raw and lossless", async () => {
    const sections = await inspectWind4ClassName("sr-only not-sr-only")
    const utilities = sections.flatMap(({ utilities: sectionUtilities }) => sectionUtilities)

    expect(utilities.map(({ token }) => token)).toEqual(["sr-only", "not-sr-only"])
    expect(utilities[0]?.rules[0]?.declarations).toHaveLength(9)
    expect(utilities[1]?.rules[0]?.declarations).toHaveLength(8)
    expect(sections.flatMap(({ spacing }) => spacing)).toEqual([])
  })

  it("keeps descendant-target spacing as a raw utility", async () => {
    const [spacing] = await inspectWind4ClassName("[&>*]:p-4")

    expect(spacing?.spacing).toEqual([])
    expect(spacing?.utilities[0]).toMatchObject({
      token: "[&>*]:p-4",
      rules: [{ selector: ".\\[\\&\\>\\*\\]\\:p-4>*" }],
    })
  })

  it("keeps pseudo-element spacing as a raw utility", async () => {
    const [spacing] = await inspectWind4ClassName("before:p-4")

    expect(spacing?.spacing).toEqual([])
    expect(spacing?.utilities[0]).toMatchObject({
      token: "before:p-4",
      rules: [{ selector: ".before\\:p-4::before" }],
    })
  })

  it("keeps arbitrary selector conditions visible as raw utilities", async () => {
    const [spacing] = await inspectWind4ClassName(`[&[data-x="::"]]:p-4`)

    expect(spacing?.spacing).toEqual([])
    expect(spacing?.utilities[0]).toMatchObject({ token: `[&[data-x="::"]]:p-4` })
  })

  it("maps unscoped logical spacing from the selected element direction", async () => {
    const [ltr] = await inspectWind4ClassName("ps-2 pe-3", { direction: "ltr" })
    const [rtl] = await inspectWind4ClassName("ps-2 pe-3", { direction: "rtl" })

    expect(ltr?.spacing[0]?.sides).toMatchObject({
      Left: { value: "2" },
      Right: { value: "3" },
    })
    expect(rtl?.spacing[0]?.sides).toMatchObject({
      Left: { value: "3" },
      Right: { value: "2" },
    })
  })

  it("keeps explicit rtl spacing as a distinct state utility", async () => {
    const [spacing] = await inspectWind4ClassName("rtl:ps-2 rtl:pe-3 rtl:pl-4 rtl:pr-5", {
      direction: "ltr",
    })

    expect(spacing?.spacing).toEqual([])
    expect(spacing?.utilities.map(({ token }) => token)).toEqual([
      "rtl:ps-2",
      "rtl:pe-3",
      "rtl:pl-4",
      "rtl:pr-5",
    ])
  })

  it("keeps explicit ltr spacing as a distinct state utility", async () => {
    const [spacing] = await inspectWind4ClassName("ltr:ps-2 ltr:pe-3", { direction: "rtl" })

    expect(spacing?.spacing).toEqual([])
    expect(spacing?.utilities.map(({ token }) => token)).toEqual(["ltr:ps-2", "ltr:pe-3"])
  })

  it.each([
    ["sm", "Sm screens and up", "≥640px"],
    ["md", "Md screens and up", "≥768px"],
    ["lg", "Lg screens and up", "≥1024px"],
    ["xl", "Xl screens and up", "≥1280px"],
    ["2xl", "2xl screens and up", "≥1536px"],
  ])("describes the %s breakpoint", (condition, label, detail) => {
    expect(describeSpacingCondition([condition], wind4Viewports)).toEqual({ detail, label })
  })

  it("describes Default, combined breakpoint state, and unknown conditions", () => {
    expect(describeSpacingCondition([], wind4Viewports)).toEqual({ label: "Default" })
    expect(describeSpacingCondition(["hover", "sm"], wind4Viewports)).toEqual({
      detail: "≥640px",
      label: "Sm screens and up · Hover",
    })
    expect(describeSpacingCondition(["supports-[display:grid]"], wind4Viewports)).toEqual({
      label: "supports-[display:grid]",
    })
  })

  it("cascades Base through the active mobile-first viewport", async () => {
    const [spacing] = await inspectWind4ClassName("p-3 sm:px-4 md:pt-8")

    expect(
      resolveViewportSpacing(spacing!.spacing, "Padding", "Default", wind4Viewports)?.sides,
    ).toMatchObject({ Left: { value: "3" }, Top: { value: "3" } })
    expect(
      resolveViewportSpacing(spacing!.spacing, "Padding", "sm", wind4Viewports)?.sides,
    ).toMatchObject({
      Bottom: { value: "3" },
      Left: { value: "4" },
      Right: { value: "4" },
      Top: { value: "3" },
    })
    expect(
      resolveViewportSpacing(spacing!.spacing, "Padding", "md", wind4Viewports)?.sides,
    ).toMatchObject({
      Bottom: { value: "3" },
      Left: { value: "4" },
      Right: { value: "4" },
      Top: { value: "8" },
    })
  })

  it("resolves breakpoint spacing independently of class token order and importance", async () => {
    const results = await Promise.all(
      ["p-3 md:pt-8 sm:pt-4", "sm:pt-4 p-3 md:pt-8"].map((className) =>
        inspectWind4ClassName(className),
      ),
    )
    for (const [spacing] of results) {
      expect(
        resolveViewportSpacing(spacing!.spacing, "Padding", "md", wind4Viewports)?.sides.Top,
      ).toMatchObject({ value: "8" })
    }

    const [important] = await inspectWind4ClassName("p-3 sm:!pt-4 md:pt-8")
    expect(
      resolveViewportSpacing(important!.spacing, "Padding", "md", wind4Viewports)?.sides.Top,
    ).toMatchObject({ value: "4" })
  })

  it("models the requested typography fields and explicit leading overrides", async () => {
    const [typography] = await resolvedSemantic(
      "font-sans text-xl font-bold leading-8 tracking-wide text-center uppercase whitespace-pre text-[#123456]",
    )
    expect(typography).toMatchObject({
      name: "Typography",
      values: {
        Alignment: { value: "center" },
        Color: { colorProperty: "color", tokens: ["text-[#123456]"] },
        Family: { value: "sans" },
        "Letter spacing": { value: "wide" },
        "Line height": { tokens: ["text-xl", "leading-8"], value: "8" },
        Size: { value: "xl" },
        Transform: { value: "uppercase" },
        Weight: { value: "bold" },
        Whitespace: { value: "pre" },
      },
    })
  })

  it("expands dimensions including size and keeps arbitrary values readable", async () => {
    const [dimensions] = await resolvedSemantic(
      "size-8 min-w-2 max-w-full min-h-1 max-h-[40rem] aspect-video md:w-[13px]",
      "md",
    )
    expect(dimensions).toMatchObject({
      name: "Dimensions",
      values: {
        "Aspect ratio": { value: "video" },
        Height: { value: "8" },
        "Max height": { value: "40rem" },
        "Max width": { value: "full" },
        "Min height": { value: "1" },
        "Min width": { value: "2" },
        Width: { tokens: ["size-8", "md:w-[13px]"], value: "13px" },
      },
    })
  })

  it("shows direct auto-layout fields while preserving complex grids raw", async () => {
    const sections = await inspectWind4ClassName(
      "flex flex-row flex-wrap items-center justify-between gap-4 gap-x-2 grid-cols-3",
    )
    const [layout] = resolveViewportSemanticCards(
      sections.flatMap(({ semantic }) => semantic),
      "Default",
      wind4Viewports,
    )
    expect(layout).toMatchObject({
      name: "Auto Layout",
      values: {
        Align: { value: "center" },
        "Column gap": { tokens: ["gap-4", "gap-x-2"], value: "2" },
        Direction: { value: "row" },
        Justify: { value: "space-between" },
        Mode: { value: "flex" },
        "Row gap": { value: "4" },
        Wrap: { value: "wrap" },
      },
    })
    expect(sections.flatMap(({ utilities }) => utilities).map(({ token }) => token)).toContain(
      "grid-cols-3",
    )
  })

  it("keeps field-specific values for multi-component arbitrary gaps", async () => {
    const cards = await resolvedSemantic("flex gap-[10px_20px]")

    expect(cards.find(({ name }) => name === "Auto Layout")?.values).toMatchObject({
      "Column gap": { tokens: ["gap-[10px_20px]"], value: "20px" },
      "Row gap": { tokens: ["gap-[10px_20px]"], value: "10px" },
    })
  })

  it("expands multi-component and elliptical arbitrary corner radii", async () => {
    const physical = await resolvedSemantic("rounded-[1px_2px_3px_4px]")
    const elliptical = await resolvedSemantic("rounded-[1px_2px_3px_4px/5px_6px_7px_8px]")

    expect(physical.find(({ name }) => name === "Corners")?.values).toMatchObject({
      "Bottom left": { value: "4px" },
      "Bottom right": { value: "3px" },
      "Top left": { value: "1px" },
      "Top right": { value: "2px" },
    })
    expect(elliptical.find(({ name }) => name === "Corners")?.values).toMatchObject({
      "Bottom left": { value: "4px / 8px" },
      "Bottom right": { value: "3px / 7px" },
      "Top left": { value: "1px / 5px" },
      "Top right": { value: "2px / 6px" },
    })
  })

  it("keeps generated side expansion for multi-component arbitrary border widths", async () => {
    const cards = await resolvedSemantic("border-[length:1px_2px_3px_4px]")

    expect(cards.find(({ name }) => name === "Stroke")?.values).toMatchObject({
      "Bottom width": { value: "3px" },
      "Left width": { value: "4px" },
      "Right width": { value: "2px" },
      "Top width": { value: "1px" },
    })
  })

  it("only consumes auto-layout utilities when a layout display applies at the viewport", async () => {
    const className = "md:flex gap-4"
    const defaultSections = await inspectWind4ClassName(className, { viewport: "Default" })
    const mediumSections = await inspectWind4ClassName(className, { viewport: "md" })

    expect(defaultSections.flatMap(({ semantic }) => semantic)).toEqual([])
    expect(defaultSections.flatMap(({ utilities }) => utilities).map(({ token }) => token)).toEqual(
      className.split(" "),
    )
    expect(
      resolveViewportSemanticCards(
        mediumSections.flatMap(({ semantic }) => semantic),
        "md",
        wind4Viewports,
      ),
    ).toMatchObject([
      {
        name: "Auto Layout",
        values: {
          "Column gap": { value: "4" },
          Mode: { value: "flex" },
          "Row gap": { value: "4" },
        },
      },
    ])
    expect(mediumSections.flatMap(({ utilities }) => utilities)).toEqual([])
  })

  it("keeps auto-layout utilities raw when the active cascade disables layout", async () => {
    const className = "flex md:hidden gap-4"
    const defaultSections = await inspectWind4ClassName(className, { viewport: "Default" })
    const mediumSections = await inspectWind4ClassName(className, { viewport: "md" })

    expect(
      resolveViewportSemanticCards(
        defaultSections.flatMap(({ semantic }) => semantic),
        "Default",
        wind4Viewports,
      )[0],
    ).toMatchObject({ name: "Auto Layout", values: { Mode: { value: "flex" } } })
    expect(mediumSections.flatMap(({ semantic }) => semantic)).toEqual([])
    expect(mediumSections.flatMap(({ utilities }) => utilities).map(({ token }) => token)).toEqual(
      className.split(" "),
    )
  })

  it("models fill, stroke, physical corners, opacity, and safe scalar effects", async () => {
    const cards = await resolvedSemantic(
      "bg-[#123456] fill-current border border-solid border-s-[#123456] rounded-lg rounded-tl-sm opacity-50 isolate mix-blend-multiply",
    )
    expect(cards.map(({ name }) => name)).toEqual([
      "Fill",
      "Stroke",
      "Corners",
      "Opacity",
      "Effects",
    ])
    expect(cards.find(({ name }) => name === "Stroke")?.values).toMatchObject({
      "Left color": {
        colorProperty: "border-left-color",
        tokens: ["border-s-[#123456]"],
      },
      "Top style": { value: "solid" },
      "Top width": { value: "1px" },
    })
    expect(cards.find(({ name }) => name === "Corners")?.values).toMatchObject({
      "Bottom left": { value: "lg" },
      "Top left": { tokens: ["rounded-lg", "rounded-tl-sm"], value: "sm" },
    })
    expect(cards.find(({ name }) => name === "Opacity")?.values.Opacity).toMatchObject({
      value: "50",
    })
    expect(cards.find(({ name }) => name === "Effects")?.values).toMatchObject({
      "Blend mode": { value: "multiply" },
      Isolation: { value: "isolate" },
    })
  })

  it("uses semantic source scales across every token-backed card field", async () => {
    const cards = await resolvedSemantic(
      "flex gap-4 text-5xl font-bold leading-tight tracking-tight w-full max-w-6xl bg-[#123456] border-2 border-[#654321] rounded-lg opacity-50 isolate",
    )

    expect(cards.find(({ name }) => name === "Typography")?.values).toMatchObject({
      "Letter spacing": { value: "tight" },
      "Line height": { value: "tight" },
      Size: { value: "5xl" },
      Weight: { value: "bold" },
    })
    expect(cards.find(({ name }) => name === "Dimensions")?.values).toMatchObject({
      "Max width": { value: "6xl" },
      Width: { value: "full" },
    })
    expect(cards.find(({ name }) => name === "Auto Layout")?.values).toMatchObject({
      "Column gap": { value: "4" },
      "Row gap": { value: "4" },
    })
    expect(cards.find(({ name }) => name === "Fill")?.values.Background).toMatchObject({
      colorProperty: "background-color",
      value: "#123456",
    })
    expect(cards.find(({ name }) => name === "Stroke")?.values).toMatchObject({
      "Top color": { colorProperty: "border-top-color", value: "#654321" },
      "Top width": { generatedValue: "2px", value: "2" },
    })
    expect(cards.find(({ name }) => name === "Typography")?.values.Size).not.toHaveProperty(
      "colorProperty",
    )
    expect(cards.find(({ name }) => name === "Stroke")?.values["Top width"]).not.toHaveProperty(
      "colorProperty",
    )
    expect(cards.find(({ name }) => name === "Corners")?.values["Top left"]).toMatchObject({
      value: "lg",
    })
    expect(cards.find(({ name }) => name === "Opacity")?.values.Opacity).toMatchObject({
      value: "50",
    })
    expect(cards.find(({ name }) => name === "Effects")?.values.Isolation).toMatchObject({
      value: "isolate",
    })
  })

  it("does not invent a line-height scale for a coupled text size declaration", async () => {
    const [typography] = await resolvedSemantic("text-5xl")

    expect(typography?.values.Size).toMatchObject({
      generatedValue: expect.stringContaining("var(--text-5xl"),
      value: "5xl",
    })
    expect(typography?.values["Line height"]?.value).toContain("var(--text-5xl")
    expect(typography?.values["Line height"]?.value).not.toBe("5xl")
  })

  it("maps logical stroke and corners using the selected direction", async () => {
    const sections = await inspectWind4ClassName("border-s-2 rounded-ss-lg", { direction: "rtl" })
    const cards = resolveViewportSemanticCards(
      sections.flatMap(({ semantic }) => semantic),
      "Default",
      wind4Viewports,
    )
    expect(cards.find(({ name }) => name === "Stroke")?.values).toHaveProperty("Right width")
    expect(cards.find(({ name }) => name === "Corners")?.values).toHaveProperty("Top right")
  })

  it("maps logical spacing, stroke, and corners in vertical-rl writing mode", async () => {
    const sections = await inspectWind4ClassName(
      "write-vertical-right ps-4 border-s-2 rounded-ss-lg",
      { direction: "ltr", writingMode: "vertical-rl" },
    )
    const cards = resolveViewportSemanticCards(
      sections.flatMap(({ semantic }) => semantic),
      "Default",
      wind4Viewports,
    )

    expect(sections.flatMap(({ spacing }) => spacing)[0]?.sides).toMatchObject({
      Top: { value: "4" },
    })
    expect(cards.find(({ name }) => name === "Stroke")?.values).toHaveProperty("Top width")
    expect(cards.find(({ name }) => name === "Corners")?.values).toHaveProperty("Top right")
  })

  it("keeps logical utilities raw when the writing mode cannot be mapped", async () => {
    const sections = await inspectWind4ClassName("ps-4 border-s-2 rounded-ss-lg", {
      direction: "ltr",
      writingMode: "sideways-rl",
    })

    expect(sections.flatMap(({ spacing }) => spacing)).toEqual([])
    expect(sections.flatMap(({ semantic }) => semantic)).toEqual([])
    expect(sections.flatMap(({ utilities }) => utilities).map(({ token }) => token)).toEqual([
      "ps-4",
      "border-s-2",
      "rounded-ss-lg",
    ])
  })

  it("keeps internally conditional generator rule sets losslessly raw", async () => {
    const className = "container bg-red-500/50"
    const sections = await inspectWind4ClassName(className)

    expect(sections.flatMap(({ semantic }) => semantic)).toEqual([])
    expect(sections.flatMap(({ utilities }) => utilities).map(({ token }) => token)).toEqual(
      className.split(" "),
    )
    expect(
      sections
        .flatMap(({ utilities }) => utilities)
        .find(({ token }) => token === "container")
        ?.rules.map(({ parents }) => parents),
    ).toEqual([
      [],
      ["@media (min-width: 40rem)"],
      ["@media (min-width: 48rem)"],
      ["@media (min-width: 64rem)"],
      ["@media (min-width: 80rem)"],
      ["@media (min-width: 96rem)"],
    ])
    expect(
      sections
        .flatMap(({ utilities }) => utilities)
        .find(({ token }) => token === "bg-red-500/50")
        ?.rules.map(({ parents }) => parents),
    ).toEqual([[], ["@supports (color: color-mix(in lab, red, red))"]])
  })

  it("keeps state, compound, composed, and unsafe selector utilities losslessly raw", async () => {
    const className =
      "hover:w-4 md:hover:bg-red-500 [&>*]:rounded-lg before:opacity-50 truncate bg-gradient-to-r shadow-lg ring-2 blur-sm rotate-6 transition animate-spin sr-only"
    const sections = await inspectWind4ClassName(className)
    expect(
      new Set(sections.flatMap(({ utilities }) => utilities).map(({ token }) => token)),
    ).toEqual(new Set(className.split(" ")))
  })

  it("applies semantic breakpoint cascade and lets lower important values win", async () => {
    const results = await Promise.all(
      ["w-3 md:w-8 sm:w-4", "sm:w-4 w-3 md:w-8"].map((className) =>
        resolvedSemantic(className, "md"),
      ),
    )
    for (const [dimensions] of results) {
      expect(dimensions?.values.Width?.value).toBe("8")
    }
    const [dimensions] = await resolvedSemantic("!w-4 md:w-8", "md")
    expect(dimensions?.values.Width?.value).toBe("4")
  })

  it("derives option order, labels, and widths from a custom generator theme", () => {
    expect(
      resolveGeneratorViewportOptions({
        config: { theme: { breakpoint: { desktop: "75rem", phone: "420px", tablet: "52rem" } } },
      }),
    ).toEqual([
      { condition: "Default", label: "Default", threshold: "<420px", width: 419 },
      { condition: "phone", label: "Phone screens and up", threshold: "≥420px", width: 420 },
      { condition: "tablet", label: "Tablet screens and up", threshold: "≥832px", width: 832 },
      {
        condition: "desktop",
        label: "Desktop screens and up",
        threshold: "≥1200px",
        width: 1_200,
      },
    ])
  })
})
