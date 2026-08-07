// oxlint-disable unicorn/no-array-sort -- Sorting a fresh derived breakpoint array keeps ES2022 support.
import { presetWind4 } from "@unocss/preset-wind4"
import { createGenerator, toEscapedSelector } from "@unocss/core"
import type { UnoGenerator } from "@unocss/core"

export const inspectorSectionNames = [
  "Layout",
  "Spacing",
  "Size",
  "Typography",
  "Fill",
  "Border",
  "Effects",
  "Other",
] as const

export type InspectorSectionName = (typeof inspectorSectionNames)[number]

export interface UtilityDeclaration {
  property: string
  value: string
}

export interface UtilityRule {
  body: string
  currentSelector?: string
  declarations: UtilityDeclaration[]
  order: number
  parents: string[]
  selector: string
  sort: number
  sourceOrder?: number
}

export interface InspectedUtility {
  conditions: string[]
  known: boolean
  rules: UtilityRule[]
  section: InspectorSectionName
  token: string
  utility: string
}

export interface UtilitySection {
  name: InspectorSectionName
  semantic: SemanticCandidate[]
  spacing: SpacingSummary[]
  utilities: InspectedUtility[]
}

export const semanticCardNames = [
  "Typography",
  "Dimensions",
  "Auto Layout",
  "Fill",
  "Stroke",
  "Corners",
  "Opacity",
  "Effects",
] as const

export type SemanticCardName = (typeof semanticCardNames)[number]

export interface SemanticCandidate {
  body: string
  card: SemanticCardName
  colorProperty?: string
  condition: string
  currentSelector?: string
  field: string
  important: boolean
  order: number
  property: string
  selector: string
  sort: number
  sourceParent?: string
  sourceOrder?: number
  token: string
  value: string
  generatedValue?: string
}

export interface SemanticValue {
  colorProperty?: string
  generatedValue?: string
  tokens: string[]
  value: string
}

export interface SemanticCardSummary {
  name: SemanticCardName
  tokens: string[]
  values: Record<string, SemanticValue>
}

export const spacingSides = ["Top", "Right", "Bottom", "Left"] as const

export type SpacingSide = (typeof spacingSides)[number]

export interface SpacingValue {
  candidates?: SemanticCandidate[]
  tokens: string[]
  value: string
}

export interface SpacingSummary {
  condition: string
  conditions: string[]
  name: "Margin" | "Padding"
  sides: Partial<Record<SpacingSide, SpacingValue>>
  sources: InspectedUtility[]
  tokens: string[]
}

export interface SpacingConditionDescription {
  detail?: string
  label: string
}

export interface ViewportOption {
  condition: string
  label: string
  threshold: string
  width: number
}

export type ViewportCondition = string

interface GeneratorWithTheme {
  config?: { theme?: { breakpoint?: Record<string, string> } }
}

const humanizeBreakpointName = (name: string): string => {
  const words = name.replace(/[-_]+/g, " ")
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} screens and up`
}

const cssLengthInPixels = (value: string): number | undefined => {
  const match = /^([\d.]+)(px|r?em)$/.exec(value.trim())
  if (match === null) {
    return undefined
  }
  const amount = Number(match[1])
  return Number.isFinite(amount) ? amount * (match[2] === "px" ? 1 : 16) : undefined
}

export const resolveGeneratorViewportOptions = (
  generator: GeneratorWithTheme,
): ViewportOption[] => {
  const breakpoints = Object.entries(generator.config?.theme?.breakpoint ?? {})
    .flatMap(([condition, value]) => {
      const width = cssLengthInPixels(value)
      return width === undefined ? [] : [{ condition, width }]
    })
    .sort((left, right) => left.width - right.width)
  const firstWidth = breakpoints[0]?.width
  if (firstWidth === undefined) {
    return [{ condition: "Default", label: "Default", threshold: "", width: 1 }]
  }
  return [
    {
      condition: "Default",
      label: "Default",
      threshold: `<${firstWidth}px`,
      width: Math.max(1, firstWidth - 1),
    },
    ...breakpoints.map(({ condition, width }) => ({
      condition,
      label: humanizeBreakpointName(condition),
      threshold: `≥${width}px`,
      width,
    })),
  ]
}

const stateConditionLabels: Record<string, string> = {
  active: "Active",
  dark: "Dark mode",
  focus: "Focus",
  hover: "Hover",
  ltr: "Left-to-right",
  rtl: "Right-to-left",
}

export const describeSpacingCondition = (
  conditions: readonly string[],
  viewportOptions: readonly ViewportOption[],
): SpacingConditionDescription => {
  if (conditions.length === 0) {
    return { label: "Default" }
  }
  const breakpointDescriptions = new Map(
    viewportOptions
      .slice(1)
      .map((option) => [option.condition, { detail: option.threshold, label: option.label }]),
  )
  const ordered = [
    ...conditions.filter((condition) => breakpointDescriptions.has(condition)),
    ...conditions.filter((condition) => !breakpointDescriptions.has(condition)),
  ]
  const breakpoint = ordered.find((condition) => breakpointDescriptions.has(condition))
  return {
    ...(breakpoint === undefined ? {} : { detail: breakpointDescriptions.get(breakpoint)!.detail }),
    label: ordered
      .map(
        (condition) =>
          breakpointDescriptions.get(condition)?.label ??
          stateConditionLabels[condition] ??
          condition,
      )
      .join(" · "),
  }
}

export const resolveViewportSpacing = (
  summaries: readonly SpacingSummary[],
  name: "Margin" | "Padding",
  viewport: ViewportCondition,
  viewportOptions: readonly ViewportOption[],
): SpacingSummary | undefined => {
  const activeIndex = viewportOptions.findIndex(({ condition }) => condition === viewport)
  const applicable = summaries.filter((summary) => {
    if (summary.name !== name) {
      return false
    }
    if (summary.conditions.length === 0) {
      return true
    }
    const conditionIndex = viewportOptions.findIndex(
      ({ condition }) => condition === summary.conditions[0],
    )
    return summary.conditions.length === 1 && conditionIndex > 0 && conditionIndex <= activeIndex
  })
  if (applicable.length === 0) {
    return undefined
  }

  const sides: Partial<Record<SpacingSide, SpacingValue>> = {}
  for (const side of spacingSides) {
    const candidates = applicable.flatMap((summary) => summary.sides[side]?.candidates ?? [])
    if (candidates.length === 0) {
      continue
    }
    const ordered = orderCandidates(candidates)
    const winner = ordered.at(-1)!
    sides[side] = {
      candidates,
      tokens: unique(ordered.map(({ token }) => token)),
      value: winner.value,
    }
  }
  const tokens = spacingSides.flatMap((side) => sides[side]?.tokens ?? [])
  return {
    condition: viewport,
    conditions: viewport === "Default" ? [] : [viewport],
    name,
    sides,
    sources: applicable.flatMap(({ sources }) => sources),
    tokens: tokens.filter((token, index) => tokens.indexOf(token) === index),
  }
}

export const resolveViewportSemanticCards = (
  candidates: readonly SemanticCandidate[],
  viewport: ViewportCondition,
  viewportOptions: readonly ViewportOption[],
): SemanticCardSummary[] => {
  const activeIndex = viewportOptions.findIndex(({ condition }) => condition === viewport)
  return semanticCardNames.flatMap((name) => {
    const cardCandidates = candidates.filter(({ card, condition }) => {
      const conditionIndex = viewportOptions.findIndex((option) => option.condition === condition)
      return card === name && conditionIndex >= 0 && conditionIndex <= activeIndex
    })
    const fields = unique(cardCandidates.map(({ field }) => field))
    const values = Object.fromEntries(
      fields.map((field) => {
        const ordered = orderCandidates(
          cardCandidates.filter((candidate) => candidate.field === field),
        )
        const winner = ordered.at(-1)!
        return [
          field,
          {
            ...(winner.colorProperty === undefined ? {} : { colorProperty: winner.colorProperty }),
            ...(winner.generatedValue === undefined
              ? {}
              : { generatedValue: winner.generatedValue }),
            tokens: unique(ordered.map(({ token }) => token)),
            value: winner.value,
          },
        ]
      }),
    )
    return fields.length === 0
      ? []
      : [{ name, tokens: unique(cardCandidates.map(({ token }) => token)), values }]
  })
}

interface UtilityGenerator {
  config?: { theme?: { breakpoint?: Record<string, string> } }
  generate: UnoGenerator["generate"]
  parentOrders?: ReadonlyMap<string, number>
}

export interface UtilityInspectionOptions {
  direction?: "ltr" | "rtl"
  viewport?: ViewportCondition
  writingMode?: string
}

interface LogicalAxes {
  blockEnd: SpacingSide
  blockStart: SpacingSide
  inlineEnd: SpacingSide
  inlineStart: SpacingSide
}

const logicalAxes = (
  writingMode: string | undefined,
  direction: "ltr" | "rtl",
): LogicalAxes | undefined => {
  const inlineStart: SpacingSide = direction === "rtl" ? "Bottom" : "Top"
  const inlineEnd: SpacingSide = direction === "rtl" ? "Top" : "Bottom"
  switch (writingMode ?? "horizontal-tb") {
    case "horizontal-tb":
      return {
        blockEnd: "Bottom",
        blockStart: "Top",
        inlineEnd: direction === "rtl" ? "Left" : "Right",
        inlineStart: direction === "rtl" ? "Right" : "Left",
      }
    case "vertical-lr":
      return { blockEnd: "Right", blockStart: "Left", inlineEnd, inlineStart }
    case "vertical-rl":
      return { blockEnd: "Left", blockStart: "Right", inlineEnd, inlineStart }
    default:
      return undefined
  }
}

const splitOutsideBrackets = (value: string, separator: string): string[] => {
  const parts: string[] = []
  let current = ""
  let depth = 0
  let quote: string | undefined
  let escaped = false

  for (const character of value) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === "\\") {
      current += character
      escaped = true
      continue
    }
    if (quote !== undefined) {
      current += character
      if (character === quote) {
        quote = undefined
      }
      continue
    }
    if (character === '"' || character === "'") {
      current += character
      quote = character
      continue
    }
    if (["[", "("].includes(character)) {
      depth += 1
    } else if (["]", ")"].includes(character)) {
      depth = Math.max(0, depth - 1)
    }
    if (character === separator && depth === 0) {
      parts.push(current)
      current = ""
    } else {
      current += character
    }
  }
  parts.push(current)
  return parts
}

const parseDeclarations = (body: string): UtilityDeclaration[] =>
  splitOutsideBrackets(body, ";").flatMap((declaration) => {
    const [property, ...valueParts] = splitOutsideBrackets(declaration, ":")
    const value = valueParts.join(":").trim()
    return property?.trim() === "" || value === "" ? [] : [{ property: property!.trim(), value }]
  })

const propertySection = (property: string): InspectorSectionName => {
  if (
    /^(display|position|inset|top|right|bottom|left|z-index|float|clear|overflow|overscroll|visibility|columns|break-|box-sizing|box-decoration|object-|aspect-ratio|grid|align-|justify-|place-|flex|order|gap)/.test(
      property,
    )
  ) {
    return "Layout"
  }
  if (/^(margin|padding)/.test(property)) {
    return "Spacing"
  }
  if (/^(width|height|min-|max-)/.test(property)) {
    return "Size"
  }
  if (
    /^(color|font|line-height|letter-spacing|text-|white-space|word-|overflow-wrap|hyphens|list-style|vertical-align|content)/.test(
      property,
    )
  ) {
    return "Typography"
  }
  if (/^(background|fill)/.test(property)) {
    return "Fill"
  }
  if (/^(border|outline|stroke)/.test(property)) {
    return "Border"
  }
  if (
    /^(box-shadow|filter|backdrop-filter|opacity|mix-blend|transform|translate|rotate|scale|transition|animation|cursor|pointer-events|user-select)/.test(
      property,
    )
  ) {
    return "Effects"
  }
  return "Other"
}

const sectionForDeclarations = (declarations: UtilityDeclaration[]): InspectorSectionName => {
  const publicDeclaration = declarations.find(({ property }) => !property.startsWith("--"))
  return propertySection(publicDeclaration?.property ?? declarations[0]?.property ?? "")
}

const parseTokenParts = (token: string): { conditions: string[]; utility: string } => {
  const parts = splitOutsideBrackets(token, ":")
  return { conditions: parts.slice(0, -1), utility: parts.at(-1) ?? token }
}

const splitCssValues = (value: string): string[] => {
  const values: string[] = []
  let current = ""
  let depth = 0
  for (const character of value.trim()) {
    if (["(", "["].includes(character)) {
      depth += 1
    } else if ([")", "]"].includes(character)) {
      depth = Math.max(0, depth - 1)
    }
    if (/\s/.test(character) && depth === 0) {
      if (current !== "") {
        values.push(current)
        current = ""
      }
    } else {
      current += character
    }
  }
  if (current !== "") {
    values.push(current)
  }
  return values
}

const withoutImportant = (value: string): string => value.replace(/\s*!important\s*$/, "")

const expandBoxValues = (value: string): Record<SpacingSide, string> | undefined => {
  const values = splitCssValues(value)
  if (values.length === 0 || values.length > 4) {
    return undefined
  }
  const [top, second = top, third = top, fourth = second] = values
  return {
    Top: top!,
    Right: second!,
    Bottom: third!,
    Left: fourth!,
  }
}

const spacingDeclaration = (
  declaration: UtilityDeclaration,
  direction: "ltr" | "rtl",
  writingMode: string | undefined,
): { name: "Margin" | "Padding"; sides: Partial<Record<SpacingSide, string>> } | undefined => {
  const match = /^(margin|padding)(?:-(.+))?$/.exec(declaration.property)
  if (match === null) {
    return undefined
  }
  const name = match[1] === "margin" ? "Margin" : "Padding"
  const value = withoutImportant(declaration.value)
  const expanded = expandBoxValues(value)
  if (expanded === undefined) {
    return undefined
  }
  const suffix = match[2]
  const components = splitCssValues(value)
  if (suffix === "block" || suffix === "inline") {
    const axes = logicalAxes(writingMode, direction)
    if (axes === undefined) {
      return undefined
    }
    if (components.length === 0 || components.length > 2) {
      return undefined
    }
    const [start, end = start] = components
    return suffix === "block"
      ? { name, sides: { [axes.blockEnd]: end, [axes.blockStart]: start } }
      : { name, sides: { [axes.inlineEnd]: end, [axes.inlineStart]: start } }
  }
  const axes = logicalAxes(writingMode, direction)
  const sideNames: Record<string, SpacingSide[]> = {
    ...(axes === undefined
      ? {}
      : {
          "block-end": [axes.blockEnd],
          "block-start": [axes.blockStart],
          "inline-end": [axes.inlineEnd],
          "inline-start": [axes.inlineStart],
        }),
    bottom: ["Bottom"],
    left: ["Left"],
    right: ["Right"],
    top: ["Top"],
  }
  const affected = suffix === undefined ? [...spacingSides] : sideNames[suffix]
  if (affected === undefined) {
    return undefined
  }
  const values: Partial<Record<SpacingSide, string>> = {}
  for (const side of affected) {
    values[side] = suffix === undefined ? expanded[side] : value
  }
  return { name, sides: values }
}

const decodeArbitrarySourceValue = (value: string): string => {
  let decoded = ""
  let escaped = false
  for (const character of value) {
    if (escaped) {
      decoded += character
      escaped = false
    } else if (character === "\\") {
      escaped = true
    } else {
      decoded += character === "_" ? " " : character
    }
  }
  return escaped ? `${decoded}\\` : decoded
}

const sourceSpacingValue = (utility: string): string | undefined => {
  const normalized = utility.replace(/^!/, "").replace(/!$/, "")
  const match = /^(-?)(?:m|p)(?:[xytrblse])?-(.+)$/.exec(normalized)
  if (match === null) {
    return undefined
  }
  let source =
    match[2]!.startsWith("[") && match[2]!.endsWith("]")
      ? decodeArbitrarySourceValue(match[2]!.slice(1, -1))
      : match[2]!
  if (source.startsWith("--")) {
    source = `var(${source})`
  }
  return `${match[1] === "-" ? "-" : ""}${source}`
}

type SpacingCandidate = SemanticCandidate

type SemanticConflictGuard = (candidate: SemanticCandidate) => boolean

const unique = <Value>(values: readonly Value[]): Value[] => [...new Set(values)]

const selectedElementSpecificity = (candidate: SemanticCandidate): number => {
  const baseSelector = toEscapedSelector(candidate.token)
  let specificity = 0
  let index = candidate.selector.indexOf(baseSelector)
  while (index !== -1) {
    specificity += 1
    index = candidate.selector.indexOf(baseSelector, index + baseSelector.length)
  }
  return specificity
}

const compareCandidates = (left: SemanticCandidate, right: SemanticCandidate): number => {
  if (left.important !== right.important) {
    return left.important ? 1 : -1
  }
  const specificity = selectedElementSpecificity(left) - selectedElementSpecificity(right)
  if (specificity !== 0) {
    return specificity
  }
  if (left.sourceOrder !== undefined || right.sourceOrder !== undefined) {
    const sourcePosition =
      (left.sourceOrder ?? 0) - (right.sourceOrder ?? 0) ||
      (left.sourceParent ?? "").localeCompare(right.sourceParent ?? "")
    if (sourcePosition !== 0) {
      return sourcePosition
    }
  }
  return (
    left.order - right.order ||
    left.sort - right.sort ||
    (left.currentSelector?.localeCompare(right.currentSelector ?? "") ?? 0) ||
    left.selector.localeCompare(right.selector) ||
    left.body.localeCompare(right.body)
  )
}

const selectorTargetsSelectedElement = (selector: string, token: string): boolean => {
  const baseSelector = toEscapedSelector(token)
  const baseIndex = selector.lastIndexOf(baseSelector)
  if (baseIndex === -1) {
    return false
  }

  const suffix = selector.slice(baseIndex + baseSelector.length)
  let depth = 0
  let escaped = false
  let quote: string | undefined
  for (let index = 0; index < suffix.length; index += 1) {
    const character = suffix[index]!
    if (escaped) {
      escaped = false
      continue
    }
    if (character === "\\") {
      escaped = true
      continue
    }
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined
      }
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (["[", "("].includes(character)) {
      depth += 1
      continue
    }
    if (["]", ")"].includes(character)) {
      depth = Math.max(0, depth - 1)
      continue
    }
    if (depth === 0 && character === ":" && suffix[index + 1] === ":") {
      return false
    }
    if (depth === 0 && (/\s/.test(character) || [">", "+", "~"].includes(character))) {
      return false
    }
  }
  return true
}

const ruleContextMatchesViewport = (
  rule: UtilityRule,
  utility: InspectedUtility,
  viewportParents: ReadonlyMap<string, readonly string[]>,
): boolean => {
  const expectedParents =
    utility.conditions.length === 0 ? [] : viewportParents.get(utility.conditions[0]!)
  return (
    expectedParents !== undefined &&
    rule.parents.length === expectedParents.length &&
    rule.parents.every((parent, index) => parent === expectedParents[index])
  )
}

const orderCandidates = <Candidate extends SemanticCandidate>(
  candidates: readonly Candidate[],
): Candidate[] => {
  const ordered: Candidate[] = []
  for (const candidate of candidates) {
    const index = ordered.findIndex((existing) => compareCandidates(candidate, existing) < 0)
    if (index === -1) {
      ordered.push(candidate)
    } else {
      ordered.splice(index, 0, candidate)
    }
  }
  return ordered
}

const createSpacingSummaries = (
  utilities: InspectedUtility[],
  options: UtilityInspectionOptions,
  viewportBreakpoints: ReadonlySet<string>,
  viewportParents: ReadonlyMap<string, readonly string[]>,
  hasRawConflict: SemanticConflictGuard,
): { consumed: Set<InspectedUtility>; spacing: SpacingSummary[] } => {
  const consumed = new Set<InspectedUtility>()
  const directSpacingUtilities = new Set<InspectedUtility>()
  const conflictingTokens = new Set<string>()
  const groups = new Map<
    string,
    {
      conditions: string[]
      names: Map<
        "Margin" | "Padding",
        { sides: Map<SpacingSide, SpacingCandidate[]>; sources: InspectedUtility[] }
      >
    }
  >()

  for (const utility of utilities) {
    const sourceValue = sourceSpacingValue(utility.utility)
    if (
      sourceValue === undefined ||
      utility.conditions.length > 1 ||
      (utility.conditions.length === 1 && !viewportBreakpoints.has(utility.conditions[0]!))
    ) {
      continue
    }
    let explicitDirection: "ltr" | "rtl" | undefined
    for (const condition of utility.conditions) {
      if (condition === "ltr" || condition === "rtl") {
        explicitDirection = condition
      }
    }
    const direction = explicitDirection ?? options.direction ?? "ltr"
    let hasDirectSpacing = false
    for (const rule of utility.rules) {
      if (
        rule.parents.some((parent) => !parent.startsWith("@")) ||
        !ruleContextMatchesViewport(rule, utility, viewportParents) ||
        !selectorTargetsSelectedElement(rule.selector, utility.token)
      ) {
        continue
      }
      for (const declaration of rule.declarations) {
        const semantic = spacingDeclaration(declaration, direction, options.writingMode)
        if (semantic === undefined) {
          continue
        }
        hasDirectSpacing = true
        const condition = utility.conditions.length === 0 ? "Default" : utility.conditions.join(":")
        const group = groups.get(condition) ?? {
          conditions: utility.conditions,
          names: new Map(),
        }
        groups.set(condition, group)
        const property = group.names.get(semantic.name) ?? { sides: new Map(), sources: [] }
        group.names.set(semantic.name, property)
        if (!property.sources.includes(utility)) {
          property.sources.push(utility)
        }
        const generatedValues = new Set(Object.values(semantic.sides))
        const sourceIsSingleComponent = splitCssValues(sourceValue).length === 1
        for (const [side, generatedValue] of Object.entries(semantic.sides) as [
          SpacingSide,
          string,
        ][]) {
          const candidates = property.sides.get(side) ?? []
          const important = /\s*!important\s*$/.test(declaration.value)
          candidates.push({
            body: rule.body,
            card: "Dimensions",
            condition,
            currentSelector: rule.currentSelector,
            field: `${semantic.name} ${side}`,
            important,
            order: rule.order,
            property: declaration.property,
            selector: rule.selector,
            sort: rule.sort,
            sourceParent: rule.parents.join(" $$ "),
            sourceOrder: rule.sourceOrder,
            token: utility.token,
            value:
              (generatedValues.size === 1 && sourceIsSingleComponent ? sourceValue : undefined) ??
              withoutImportant(generatedValue),
          })
          property.sides.set(side, candidates)
        }
      }
    }
    if (hasDirectSpacing) {
      directSpacingUtilities.add(utility)
    }
  }

  for (const { names } of groups.values()) {
    for (const { sides } of names.values()) {
      for (const candidate of [...sides.values()].flat()) {
        if (hasRawConflict(candidate)) {
          conflictingTokens.add(candidate.token)
        }
      }
    }
  }

  const spacing: SpacingSummary[] = []
  for (const [condition, group] of groups) {
    for (const name of ["Padding", "Margin"] as const) {
      const property = group.names.get(name)
      if (property === undefined) {
        continue
      }
      const sides: Partial<Record<SpacingSide, SpacingValue>> = {}
      const tokens = new Set<string>()
      for (const side of spacingSides) {
        const candidates = property.sides.get(side)
        if (candidates === undefined) {
          continue
        }
        const safeCandidates = candidates.filter(
          (candidate) => !conflictingTokens.has(candidate.token),
        )
        if (safeCandidates.length === 0) {
          continue
        }
        const orderedCandidates = orderCandidates(safeCandidates)
        const winner = orderedCandidates.at(-1)!
        const evidence = orderedCandidates
          .map(({ token }) => token)
          .filter((token, index, all) => all.indexOf(token) === index)
        evidence.forEach((token) => tokens.add(token))
        sides[side] = { candidates: orderedCandidates, tokens: evidence, value: winner.value }
      }
      if (Object.keys(sides).length > 0) {
        spacing.push({
          condition,
          conditions: group.conditions,
          name,
          sides,
          sources: property.sources,
          tokens: [...tokens],
        })
      }
    }
  }
  for (const utility of directSpacingUtilities) {
    if (!conflictingTokens.has(utility.token)) {
      consumed.add(utility)
    }
  }
  return { consumed, spacing }
}

interface SemanticDeclaration {
  card: SemanticCardName
  colorProperty?: string
  field: string
  value: string
}

const sourceTokenValue = (value: string): string => {
  const source =
    value.startsWith("[") && value.endsWith("]")
      ? decodeArbitrarySourceValue(value.slice(1, -1))
      : value
  return source.startsWith("--") ? `var(${source})` : source
}

const semanticSourceValue = (
  utility: string,
  semantic: SemanticDeclaration,
): string | undefined => {
  const normalized = utility.replace(/^!/, "").replace(/!$/, "")
  const suffix = (pattern: RegExp): string | undefined => {
    const match = pattern.exec(normalized)
    if (match?.[1] === undefined) {
      return undefined
    }
    const source = sourceTokenValue(match[1])
    return splitCssValues(source).length === 1 ? source : undefined
  }

  switch (semantic.card) {
    case "Typography":
      switch (semantic.field) {
        case "Color":
        case "Size":
          return suffix(/^text-(.+)$/)
        case "Family":
        case "Weight":
          return suffix(/^font-(.+)$/)
        case "Letter spacing":
          return suffix(/^tracking-(.+)$/)
        case "Line height":
          return suffix(/^leading-(.+)$/)
        default:
          return undefined
      }
    case "Dimensions": {
      const prefixes: Record<string, string> = {
        "Aspect ratio": "aspect",
        Height: "h",
        "Max height": "max-h",
        "Max width": "max-w",
        "Min height": "min-h",
        "Min width": "min-w",
        Width: "w",
      }
      const prefix = prefixes[semantic.field]
      if (prefix !== undefined) {
        const value = suffix(new RegExp(`^${prefix}-(.+)$`))
        if (value !== undefined) {
          return value
        }
      }
      if (semantic.field === "Height" || semantic.field === "Width") {
        return suffix(/^size-(.+)$/)
      }
      return undefined
    }
    case "Auto Layout":
      if (semantic.field === "Row gap") {
        return suffix(/^gap(?:-y)?-(.+)$/)
      }
      if (semantic.field === "Column gap") {
        return suffix(/^gap(?:-x)?-(.+)$/)
      }
      return undefined
    case "Fill":
      return semantic.field === "Fill" ? suffix(/^fill-(.+)$/) : suffix(/^bg-(.+)$/)
    case "Stroke": {
      const source = suffix(/^border(?:-(?:x|y|t|r|b|l|s|e|bs|be))?-(.+)$/)
      return ["color", "style", "width"].includes(semantic.field.split(" ").at(-1) ?? "")
        ? source
        : undefined
    }
    case "Corners":
      return suffix(/^rounded(?:-(?:t|r|b|l|tl|tr|br|bl|s|e|ss|se|es|ee))?-(.+)$/)
    case "Opacity":
      return suffix(/^opacity-(.+)$/)
    case "Effects":
      return undefined
  }
}

const readableDeclarationValue = (value: string): string => {
  const plain = withoutImportant(value)
  const spacing = /^calc\(var\(--spacing\) \* (-?[\d.]+)\)$/.exec(plain)
  return spacing?.[1] ?? plain
}

const physicalSidesForSuffix = (
  suffix: string | undefined,
  direction: "ltr" | "rtl",
  writingMode: string | undefined,
): SpacingSide[] | undefined => {
  const axes = logicalAxes(writingMode, direction)
  const sides: Record<string, SpacingSide[]> = {
    ...(axes === undefined
      ? {}
      : {
          "block-end": [axes.blockEnd],
          "block-start": [axes.blockStart],
          block: [axes.blockStart, axes.blockEnd],
          inline: [axes.inlineStart, axes.inlineEnd],
          "inline-end": [axes.inlineEnd],
          "inline-start": [axes.inlineStart],
        }),
    bottom: ["Bottom"],
    left: ["Left"],
    right: ["Right"],
    top: ["Top"],
    x: ["Left", "Right"],
    y: ["Top", "Bottom"],
  }
  return suffix === undefined ? [...spacingSides] : sides[suffix]
}

const expandPhysicalProperty = (
  value: string,
  suffix: string | undefined,
  direction: "ltr" | "rtl",
  writingMode: string | undefined,
): Partial<Record<SpacingSide, string>> | undefined => {
  const affected = physicalSidesForSuffix(suffix, direction, writingMode)
  if (affected === undefined) {
    return undefined
  }
  if (suffix !== undefined) {
    return Object.fromEntries(affected.map((side) => [side, withoutImportant(value)]))
  }
  const box = expandBoxValues(withoutImportant(value))
  if (box === undefined) {
    return undefined
  }
  return Object.fromEntries(affected.map((side) => [side, box[side]]))
}

const semanticDeclarations = (
  declaration: UtilityDeclaration,
  direction: "ltr" | "rtl",
  writingMode: string | undefined,
): SemanticDeclaration[] | undefined => {
  const { property } = declaration
  const value = readableDeclarationValue(declaration.value)
  const typography: Record<string, string> = {
    color: "Color",
    "font-family": "Family",
    "font-size": "Size",
    "font-weight": "Weight",
    "letter-spacing": "Letter spacing",
    "line-height": "Line height",
    "text-align": "Alignment",
    "text-transform": "Transform",
    "white-space": "Whitespace",
  }
  if (typography[property] !== undefined) {
    return [
      {
        card: "Typography",
        ...(property === "color" ? { colorProperty: property } : {}),
        field: typography[property],
        value,
      },
    ]
  }

  const dimensions: Record<string, string> = {
    "aspect-ratio": "Aspect ratio",
    height: "Height",
    "max-height": "Max height",
    "max-width": "Max width",
    "min-height": "Min height",
    "min-width": "Min width",
    width: "Width",
  }
  if (dimensions[property] !== undefined) {
    return [{ card: "Dimensions", field: dimensions[property], value }]
  }

  const autoLayout: Record<string, string> = {
    "align-content": "Align content",
    "align-items": "Align",
    "column-gap": "Column gap",
    display: "Mode",
    "flex-direction": "Direction",
    "flex-wrap": "Wrap",
    "justify-content": "Justify",
    "row-gap": "Row gap",
  }
  if (autoLayout[property] !== undefined) {
    return [{ card: "Auto Layout", field: autoLayout[property], value }]
  }
  if (property === "gap") {
    const parts = splitCssValues(value)
    if (parts.length === 0 || parts.length > 2) {
      return undefined
    }
    return [
      { card: "Auto Layout", field: "Row gap", value: parts[0]! },
      { card: "Auto Layout", field: "Column gap", value: parts[1] ?? parts[0]! },
    ]
  }

  if (property === "background-color" || property === "fill") {
    return value === "none" || /gradient\(/.test(value)
      ? undefined
      : [
          {
            card: "Fill",
            colorProperty: property,
            field: property === "fill" ? "Fill" : "Background",
            value,
          },
        ]
  }

  const border =
    /^border(?:-(top|right|bottom|left|inline|inline-start|inline-end|block-start|block-end))?-(width|style|color)$/.exec(
      property,
    )
  if (border !== null) {
    const sides = expandPhysicalProperty(declaration.value, border[1], direction, writingMode)
    return sides === undefined
      ? undefined
      : Object.entries(sides).map(([side, sideValue]) => ({
          card: "Stroke" as const,
          colorProperty: border[2] === "color" ? `border-${side.toLowerCase()}-color` : undefined,
          field: `${side} ${border[2]}`,
          value: readableDeclarationValue(sideValue),
        }))
  }

  if (property === "border-radius") {
    const [horizontalValue, verticalValue, ...extraAxes] = splitOutsideBrackets(
      withoutImportant(declaration.value),
      "/",
    )
    const horizontal = expandBoxValues(horizontalValue ?? "")
    const vertical = verticalValue === undefined ? horizontal : expandBoxValues(verticalValue)
    return horizontal === undefined || vertical === undefined || extraAxes.length > 0
      ? undefined
      : [
          {
            card: "Corners",
            field: "Top left",
            value: readableDeclarationValue(
              horizontal.Top === vertical.Top
                ? horizontal.Top
                : `${horizontal.Top} / ${vertical.Top}`,
            ),
          },
          {
            card: "Corners",
            field: "Top right",
            value: readableDeclarationValue(
              horizontal.Right === vertical.Right
                ? horizontal.Right
                : `${horizontal.Right} / ${vertical.Right}`,
            ),
          },
          {
            card: "Corners",
            field: "Bottom right",
            value: readableDeclarationValue(
              horizontal.Bottom === vertical.Bottom
                ? horizontal.Bottom
                : `${horizontal.Bottom} / ${vertical.Bottom}`,
            ),
          },
          {
            card: "Corners",
            field: "Bottom left",
            value: readableDeclarationValue(
              horizontal.Left === vertical.Left
                ? horizontal.Left
                : `${horizontal.Left} / ${vertical.Left}`,
            ),
          },
        ]
  }
  const radius = /^border-(top-left|top-right|bottom-right|bottom-left)-radius$/.exec(property)
  if (radius !== null) {
    const labels: Record<string, string> = {
      "bottom-left": "Bottom left",
      "bottom-right": "Bottom right",
      "top-left": "Top left",
      "top-right": "Top right",
    }
    return [{ card: "Corners", field: labels[radius[1]!]!, value }]
  }
  const logicalRadius = /^border-(start|end)-(start|end)-radius$/.exec(property)
  if (logicalRadius !== null) {
    const axes = logicalAxes(writingMode, direction)
    if (axes === undefined) {
      return undefined
    }
    const blockSide = logicalRadius[1] === "start" ? axes.blockStart : axes.blockEnd
    const inlineSide = logicalRadius[2] === "start" ? axes.inlineStart : axes.inlineEnd
    const vertical = [blockSide, inlineSide].find((side) => side === "Top" || side === "Bottom")
    const horizontal = [blockSide, inlineSide].find((side) => side === "Left" || side === "Right")
    if (vertical === undefined || horizontal === undefined) {
      return undefined
    }
    return [{ card: "Corners", field: `${vertical} ${horizontal.toLowerCase()}`, value }]
  }

  if (property === "opacity") {
    return [{ card: "Opacity", field: "Opacity", value }]
  }
  const effects: Record<string, string> = {
    isolation: "Isolation",
    "mix-blend-mode": "Blend mode",
  }
  return effects[property] === undefined
    ? undefined
    : [{ card: "Effects", field: effects[property], value }]
}

const semanticFieldKey = (card: SemanticCardName | "Spacing", field: string): string =>
  `${card}\0${field}`

const allSemanticFieldKeys = new Set<string>([
  ...[
    "Alignment",
    "Color",
    "Family",
    "Letter spacing",
    "Line height",
    "Size",
    "Transform",
    "Weight",
    "Whitespace",
  ].map((field) => semanticFieldKey("Typography", field)),
  ...["Aspect ratio", "Height", "Max height", "Max width", "Min height", "Min width", "Width"].map(
    (field) => semanticFieldKey("Dimensions", field),
  ),
  ...[
    "Align",
    "Align content",
    "Column gap",
    "Direction",
    "Mode",
    "Justify",
    "Row gap",
    "Wrap",
  ].map((field) => semanticFieldKey("Auto Layout", field)),
  semanticFieldKey("Fill", "Background"),
  semanticFieldKey("Fill", "Fill"),
  ...spacingSides.flatMap((side) =>
    ["color", "style", "width"].map((field) => semanticFieldKey("Stroke", `${side} ${field}`)),
  ),
  ...["Bottom left", "Bottom right", "Top left", "Top right"].map((field) =>
    semanticFieldKey("Corners", field),
  ),
  semanticFieldKey("Opacity", "Opacity"),
  semanticFieldKey("Effects", "Blend mode"),
  semanticFieldKey("Effects", "Isolation"),
  ...["Margin", "Padding"].flatMap((name) =>
    spacingSides.map((side) => semanticFieldKey("Spacing", `${name} ${side}`)),
  ),
])

const sideFieldKeys = (
  card: "Stroke",
  suffix: string | undefined,
  fields: readonly string[],
  direction: "ltr" | "rtl",
  writingMode: string | undefined,
): Set<string> => {
  const sides = physicalSidesForSuffix(suffix, direction, writingMode)
  return new Set(
    (sides ?? spacingSides).flatMap((side) =>
      fields.map((field) => semanticFieldKey(card, `${side} ${field}`)),
    ),
  )
}

const declarationSemanticFootprint = (
  declaration: UtilityDeclaration,
  direction: "ltr" | "rtl",
  writingMode: string | undefined,
): Set<string> => {
  const property = declaration.property.toLowerCase()
  if (property.startsWith("--")) {
    return new Set()
  }
  if (property === "all") {
    return new Set(allSemanticFieldKeys)
  }

  const fields = new Set(
    (semanticDeclarations(declaration, direction, writingMode) ?? []).map(({ card, field }) =>
      semanticFieldKey(card, field),
    ),
  )
  const spacing = spacingDeclaration(declaration, direction, writingMode)
  if (spacing !== undefined) {
    for (const side of Object.keys(spacing.sides)) {
      fields.add(semanticFieldKey("Spacing", `${spacing.name} ${side}`))
    }
  }

  if (property === "font") {
    for (const field of ["Family", "Line height", "Size", "Weight"]) {
      fields.add(semanticFieldKey("Typography", field))
    }
  }
  if (property === "background") {
    fields.add(semanticFieldKey("Fill", "Background"))
  }

  const spacingShorthand = /^(margin|padding)(?:-(.+))?$/.exec(property)
  if (spacingShorthand !== null && spacing === undefined) {
    const name = spacingShorthand[1] === "margin" ? "Margin" : "Padding"
    const sides = physicalSidesForSuffix(spacingShorthand[2], direction, writingMode)
    for (const side of sides ?? spacingSides) {
      fields.add(semanticFieldKey("Spacing", `${name} ${side}`))
    }
  }

  const borderShorthand =
    /^border(?:-(top|right|bottom|left|inline|inline-start|inline-end|block|block-start|block-end))?(?:-(width|style|color))?$/.exec(
      property,
    )
  if (borderShorthand !== null) {
    const affected = sideFieldKeys(
      "Stroke",
      borderShorthand[1],
      borderShorthand[2] === undefined ? ["color", "style", "width"] : [borderShorthand[2]],
      direction,
      writingMode,
    )
    affected.forEach((field) => fields.add(field))
  }
  if (property === "border-radius") {
    for (const field of ["Bottom left", "Bottom right", "Top left", "Top right"]) {
      fields.add(semanticFieldKey("Corners", field))
    }
  }
  if (/^border-(?:start|end)-(?:start|end)-radius$/.test(property) && fields.size === 0) {
    for (const field of ["Bottom left", "Bottom right", "Top left", "Top right"]) {
      fields.add(semanticFieldKey("Corners", field))
    }
  }

  const logicalSize = /^(min-|max-)?(inline|block)-size$/.exec(property)
  if (logicalSize !== null) {
    const vertical = writingMode !== undefined && writingMode !== "horizontal-tb"
    const dimension =
      logicalSize[2] === "inline" ? (vertical ? "Height" : "Width") : vertical ? "Width" : "Height"
    const qualifier = logicalSize[1] === "min-" ? "Min " : logicalSize[1] === "max-" ? "Max " : ""
    fields.add(semanticFieldKey("Dimensions", `${qualifier}${dimension}`))
  }

  if (property === "flex-flow") {
    fields.add(semanticFieldKey("Auto Layout", "Direction"))
    fields.add(semanticFieldKey("Auto Layout", "Wrap"))
  }
  if (property === "place-content") {
    fields.add(semanticFieldKey("Auto Layout", "Align content"))
    fields.add(semanticFieldKey("Auto Layout", "Justify"))
  }
  if (property === "place-items") {
    fields.add(semanticFieldKey("Auto Layout", "Align"))
  }
  if (property === "gap") {
    fields.add(semanticFieldKey("Auto Layout", "Row gap"))
    fields.add(semanticFieldKey("Auto Layout", "Column gap"))
  }
  return fields
}

const isUnconditionalSelfVariant = (condition: string): boolean => /^\[&+\]$/.test(condition)

const normalizedViewportConditions = (utility: InspectedUtility): string[] =>
  utility.conditions.filter((condition) => !isUnconditionalSelfVariant(condition))

const rawRuleMatchesActiveViewport = (
  rule: UtilityRule,
  utility: InspectedUtility,
  viewportParents: ReadonlyMap<string, readonly string[]>,
  viewportOptions: readonly ViewportOption[],
  activeViewportIndex: number,
): { condition: string } | undefined => {
  const conditions = normalizedViewportConditions(utility)
  if (conditions.length > 1) {
    return undefined
  }
  const condition = conditions[0] ?? "Default"
  const conditionIndex = viewportOptions.findIndex((option) => option.condition === condition)
  if (conditionIndex < 0 || conditionIndex > activeViewportIndex) {
    return undefined
  }
  const expectedParents = condition === "Default" ? [] : viewportParents.get(condition)
  if (expectedParents === undefined) {
    return undefined
  }
  const hasExpectedViewport = expectedParents.every(
    (parent, index) => rule.parents[index] === parent,
  )
  const remainingParents = rule.parents.slice(expectedParents.length)
  return hasExpectedViewport &&
    remainingParents.every((parent) => parent.startsWith("@supports")) &&
    selectorTargetsSelectedElement(rule.selector, utility.token)
    ? { condition }
    : undefined
}

const createRawConflictGuard = (
  utilities: readonly InspectedUtility[],
  options: UtilityInspectionOptions,
  viewportBreakpoints: ReadonlySet<string>,
  viewportParents: ReadonlyMap<string, readonly string[]>,
  viewportOptions: readonly ViewportOption[],
): SemanticConflictGuard => {
  const activeViewportIndex = Math.max(
    0,
    viewportOptions.findIndex(({ condition }) => condition === (options.viewport ?? "Default")),
  )
  const direction = options.direction ?? "ltr"
  const rawUtilities = utilities.filter((utility) => {
    const ordinaryCondition =
      utility.conditions.length <= 1 &&
      (utility.conditions.length === 0 || viewportBreakpoints.has(utility.conditions[0]!))
    if (!ordinaryCondition) {
      return true
    }
    const directRules = utility.rules.filter(
      (rule) =>
        ruleContextMatchesViewport(rule, utility, viewportParents) &&
        selectorTargetsSelectedElement(rule.selector, utility.token),
    )
    return (
      directRules.length === 0 ||
      directRules.length !== utility.rules.length ||
      directRules.some((rule) => {
        const declarations = rule.declarations.filter(({ property }) => !property.startsWith("--"))
        return (
          declarations.length === 0 ||
          declarations.some(
            (declaration) =>
              semanticDeclarations(declaration, direction, options.writingMode) === undefined &&
              (spacingDeclaration(declaration, direction, options.writingMode) === undefined ||
                sourceSpacingValue(utility.utility) === undefined),
          )
        )
      })
    )
  })

  const competitors = rawUtilities.flatMap((utility) =>
    utility.rules.flatMap((rule) => {
      const context = rawRuleMatchesActiveViewport(
        rule,
        utility,
        viewportParents,
        viewportOptions,
        activeViewportIndex,
      )
      if (context === undefined) {
        return []
      }
      return rule.declarations.flatMap((declaration) =>
        [...declarationSemanticFootprint(declaration, direction, options.writingMode)].map(
          (field) => ({
            body: rule.body,
            card: "Dimensions" as const,
            condition: context.condition,
            currentSelector: rule.currentSelector,
            field,
            important: /\s*!important\s*$/.test(declaration.value),
            order: rule.order,
            property: declaration.property,
            selector: rule.selector,
            sort: rule.sort,
            sourceParent: rule.parents.join(" $$ "),
            sourceOrder: rule.sourceOrder,
            token: utility.token,
            value: declaration.value,
          }),
        ),
      )
    }),
  )

  return (candidate) => {
    const field =
      candidate.card === "Dimensions" && /^(Margin|Padding) /.test(candidate.field)
        ? semanticFieldKey("Spacing", candidate.field)
        : semanticFieldKey(candidate.card, candidate.field)
    return competitors.some((competitor) => {
      if (competitor.field !== field) {
        return false
      }
      if (competitor.important !== candidate.important) {
        return competitor.important
      }
      return compareCandidates(competitor, candidate) >= 0
    })
  }
}

const recognizedLayoutDisplays = new Set([
  "block",
  "flex",
  "grid",
  "inline-block",
  "inline-flex",
  "inline-grid",
])

const createSemanticCandidates = (
  utilities: readonly InspectedUtility[],
  options: UtilityInspectionOptions,
  viewportBreakpoints: ReadonlySet<string>,
  viewportParents: ReadonlyMap<string, readonly string[]>,
  viewportOptions: readonly ViewportOption[],
  hasRawConflict: SemanticConflictGuard,
): { candidates: SemanticCandidate[]; consumed: Set<InspectedUtility> } => {
  const candidates: SemanticCandidate[] = []
  const consumed = new Set<InspectedUtility>()
  const activeViewport = options.viewport ?? "Default"
  const activeViewportIndex = viewportOptions.findIndex(
    ({ condition }) => condition === activeViewport,
  )
  const displayCandidates = utilities.flatMap((utility) => {
    const condition = utility.conditions[0] ?? "Default"
    const conditionIndex = viewportOptions.findIndex((option) => option.condition === condition)
    if (
      utility.conditions.length > 1 ||
      conditionIndex < 0 ||
      conditionIndex > activeViewportIndex
    ) {
      return []
    }
    return utility.rules.flatMap((rule) => {
      if (
        !ruleContextMatchesViewport(rule, utility, viewportParents) ||
        !selectorTargetsSelectedElement(rule.selector, utility.token)
      ) {
        return []
      }
      return rule.declarations.flatMap((declaration) =>
        declaration.property === "display"
          ? [
              {
                body: rule.body,
                card: "Auto Layout" as const,
                condition,
                currentSelector: rule.currentSelector,
                field: "Mode",
                important: /\s*!important\s*$/.test(declaration.value),
                order: rule.order,
                property: declaration.property,
                selector: rule.selector,
                sort: rule.sort,
                sourceParent: rule.parents.join(" $$ "),
                sourceOrder: rule.sourceOrder,
                token: utility.token,
                value: withoutImportant(declaration.value),
              },
            ]
          : [],
      )
    })
  })
  const activeDisplay = orderCandidates(displayCandidates).at(-1)?.value
  const hasLayoutDisplay =
    activeDisplay !== undefined && recognizedLayoutDisplays.has(activeDisplay)

  const analyses = utilities.map((utility) => {
    const condition = utility.conditions[0] ?? "Default"
    const conditionIsApplicable =
      utility.conditions.length <= 1 &&
      (utility.conditions.length === 0 || viewportBreakpoints.has(condition))
    const directRules = conditionIsApplicable
      ? utility.rules.filter(
          (rule) =>
            ruleContextMatchesViewport(rule, utility, viewportParents) &&
            selectorTargetsSelectedElement(rule.selector, utility.token),
        )
      : []
    const mappedRules = directRules.map((rule) => {
      const publicDeclarations = rule.declarations.filter(
        ({ property }) => !property.startsWith("--"),
      )
      const declarationMappings = publicDeclarations.map((declaration) => ({
        declaration,
        mappings: semanticDeclarations(
          declaration,
          options.direction ?? "ltr",
          options.writingMode,
        ),
      }))
      const mapped = declarationMappings.flatMap(({ declaration, mappings }) =>
        (mappings ?? []).map((mapping) =>
          Object.assign({ property: declaration.property }, mapping),
        ),
      )
      return {
        allMapped: declarationMappings.every(({ mappings }) => mappings !== undefined),
        mapped,
        publicCount: publicDeclarations.length,
        rule,
      }
    })
    const eligible =
      directRules.length > 0 &&
      directRules.length === utility.rules.length &&
      mappedRules.every(
        ({ allMapped, mapped, publicCount }) =>
          allMapped &&
          publicCount > 0 &&
          mapped.length > 0 &&
          (hasLayoutDisplay || mapped.every(({ card }) => card !== "Auto Layout")),
      )
    return { condition, directRules, eligible, mappedRules, utility }
  })

  for (const { condition, eligible, mappedRules, utility } of analyses) {
    if (
      !eligible ||
      mappedRules.some(({ mapped, rule }) =>
        mapped.some(({ card, field, property }) =>
          hasRawConflict({
            body: rule.body,
            card,
            condition,
            currentSelector: rule.currentSelector,
            field,
            important: rule.declarations.some(({ value }) => /\s*!important\s*$/.test(value)),
            order: rule.order,
            property,
            selector: rule.selector,
            sort: rule.sort,
            sourceParent: rule.parents.join(" $$ "),
            sourceOrder: rule.sourceOrder,
            token: utility.token,
            value: "",
          }),
        ),
      )
    ) {
      continue
    }
    for (const { mapped, rule } of mappedRules) {
      for (const semantic of mapped) {
        const sourceValue = semanticSourceValue(utility.utility, semantic)
        candidates.push({
          ...semantic,
          body: rule.body,
          condition,
          currentSelector: rule.currentSelector,
          important: rule.declarations.some(({ value }) => /\s*!important\s*$/.test(value)),
          order: rule.order,
          property: semantic.property,
          selector: rule.selector,
          sort: rule.sort,
          sourceParent: rule.parents.join(" $$ "),
          sourceOrder: rule.sourceOrder,
          token: utility.token,
          ...(sourceValue === undefined || sourceValue === semantic.value
            ? {}
            : { generatedValue: semantic.value }),
          value: sourceValue ?? semantic.value,
        })
      }
    }
    consumed.add(utility)
  }
  return { candidates, consumed }
}

const semanticSection = (card: SemanticCardName): InspectorSectionName => {
  switch (card) {
    case "Auto Layout":
      return "Layout"
    case "Dimensions":
      return "Size"
    case "Typography":
      return "Typography"
    case "Fill":
      return "Fill"
    case "Corners":
    case "Stroke":
      return "Border"
    case "Effects":
    case "Opacity":
      return "Effects"
  }
}

export const createUtilityInspector = (generator: UtilityGenerator) => {
  const tokenCacheLimit = 256
  const cache = new Map<string, InspectedUtility>()
  const inFlight = new Map<string, Promise<InspectedUtility>>()
  const viewportParents = new Map(
    Object.entries(generator.config?.theme?.breakpoint ?? {}).map(([condition, width]) => [
      condition,
      [`@media (min-width: ${width})`],
    ]),
  )
  const viewportBreakpoints = new Set(
    resolveGeneratorViewportOptions(generator)
      .slice(1)
      .map(({ condition }) => condition),
  )

  const inspectToken = (token: string): Promise<InspectedUtility> => {
    const cached = cache.get(token)
    if (cached !== undefined) {
      cache.delete(token)
      cache.set(token, cached)
      return Promise.resolve(cached)
    }
    const pending = inFlight.get(token)
    if (pending !== undefined) {
      return pending
    }

    const inspection = (async (): Promise<InspectedUtility> => {
      try {
        const generated = await generator.generate([token], {
          extendedInfo: true,
          preflights: false,
        })
        const data = generated.matched.get(token)?.data ?? []
        const rules = data.flatMap(([order, selector, body, parent, meta, context]) => {
          if (selector === undefined || selector.startsWith("@")) {
            return []
          }
          const declarations = parseDeclarations(body)
          return declarations.length === 0
            ? []
            : [
                {
                  body,
                  ...(context?.currentSelector === undefined
                    ? {}
                    : { currentSelector: context.currentSelector }),
                  declarations,
                  order,
                  parents: parent === undefined ? [] : parent.split(" $$ "),
                  selector,
                  sort: typeof meta?.sort === "number" ? meta.sort : 0,
                  ...(generator.parentOrders?.get(parent ?? "") === undefined
                    ? {}
                    : { sourceOrder: generator.parentOrders.get(parent ?? "") }),
                },
              ]
        })
        const declarations = rules.flatMap((rule) => rule.declarations)
        const tokenParts = parseTokenParts(token)
        const inspected: InspectedUtility = {
          conditions: tokenParts.conditions,
          known: rules.length > 0,
          rules,
          section: sectionForDeclarations(declarations),
          token,
          utility: tokenParts.utility,
        }
        cache.set(token, inspected)
        if (cache.size > tokenCacheLimit) {
          cache.delete(cache.keys().next().value!)
        }
        return inspected
      } finally {
        inFlight.delete(token)
      }
    })()
    inFlight.set(token, inspection)
    return inspection
  }

  return async (
    className: string,
    options: UtilityInspectionOptions = {},
  ): Promise<UtilitySection[]> => {
    const tokens = className.trim() === "" ? [] : className.trim().split(/\s+/)
    const utilities = await Promise.all(tokens.map(inspectToken))
    const viewportOptions = resolveGeneratorViewportOptions(generator)
    const hasRawConflict = createRawConflictGuard(
      utilities,
      options,
      viewportBreakpoints,
      viewportParents,
      viewportOptions,
    )
    const spacingModel = createSpacingSummaries(
      utilities,
      options,
      viewportBreakpoints,
      viewportParents,
      hasRawConflict,
    )
    const semanticModel = createSemanticCandidates(
      utilities,
      options,
      viewportBreakpoints,
      viewportParents,
      viewportOptions,
      hasRawConflict,
    )
    const consumed = new Set([...spacingModel.consumed, ...semanticModel.consumed])
    return inspectorSectionNames.flatMap((name) => {
      const sectionUtilities = utilities.filter(
        (utility) => utility.section === name && !consumed.has(utility),
      )
      const sectionSpacing = name === "Spacing" ? spacingModel.spacing : []
      const sectionSemantic = semanticModel.candidates.filter(
        ({ card }) => semanticSection(card) === name,
      )
      return sectionUtilities.length === 0 &&
        sectionSpacing.length === 0 &&
        sectionSemantic.length === 0
        ? []
        : [
            {
              name,
              semantic: sectionSemantic,
              spacing: sectionSpacing,
              utilities: sectionUtilities,
            },
          ]
    })
  }
}

const wind4Generator = createGenerator({ configFile: false, presets: [presetWind4()] })
const wind4Inspector = wind4Generator.then(createUtilityInspector)

export const getWind4ViewportOptions = async (): Promise<ViewportOption[]> =>
  resolveGeneratorViewportOptions(await wind4Generator)

export const inspectWind4ClassName = async (
  className: string,
  options: UtilityInspectionOptions = {},
): Promise<UtilitySection[]> => {
  const inspect = await wind4Inspector
  return inspect(className, options)
}
