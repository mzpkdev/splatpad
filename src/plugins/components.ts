import {
  Hash,
  Liquid,
  Tag,
  type Context,
  type Emitter,
  type Parser,
  type PartialScope,
  type TagToken,
  type Template,
  type TopLevelToken,
  type ValueToken,
} from "liquidjs"

const componentSlotsRegister = "splatpad:component-slots"

interface ComponentDialectOptions {
  annotateComponents?: boolean
}

type ComponentSlot = {
  context: Context
  html?: string
  liquid: Liquid
  templates: Template[]
}

type ComponentSlots = Record<string, ComponentSlot>

const assertEndTagHasNoArguments = (token: TagToken): void => {
  if (token.args.trim() !== "") {
    throw new Error(`tag ${token.getText()} does not accept arguments`)
  }
}

const readStaticName = (token: TagToken, label: string): string => {
  const name = token.tokenizer.readQuoted()
  if (name === undefined) {
    throw new Error(`${label} name must be a quoted string`)
  }
  token.tokenizer.skipBlank()
  token.tokenizer.assert(token.tokenizer.end(), `${label} name must be a quoted string`)
  return name.content
}

const parseSlot = (
  token: TagToken,
  remainTokens: TopLevelToken[],
  parser: Parser,
): { name: string; templates: Template[] } => {
  const name = readStaticName(token, "slot")
  const templates: Template[] = []
  let closed = false

  parser
    .parseStream(remainTokens)
    .on<TagToken>("tag:endslot", function (endToken) {
      assertEndTagHasNoArguments(endToken)
      closed = true
      this.stop()
    })
    .on<Template>("template", (template) => templates.push(template))
    .on("end", () => {
      throw new Error(`tag ${token.getText()} not closed`)
    })
    .start()

  if (!closed) {
    throw new Error(`tag ${token.getText()} not closed`)
  }
  if (name === "default") {
    throw new Error('component slot "default" is reserved for body content')
  }
  return { name, templates }
}

class ComponentPartialTemplate implements Template {
  constructor(
    readonly token: TagToken,
    private readonly componentName: string,
    private readonly componentEngine: Liquid,
    private readonly props: string[],
  ) {}

  render(): void {}

  *children(partials: boolean, sync: boolean): Generator<unknown, Template[], unknown> {
    if (!partials) {
      return []
    }
    if (sync) {
      return this.componentEngine.parseFileSync(this.componentName)
    }
    return (yield this.componentEngine.parseFile(this.componentName)) as Template[]
  }

  partialScope(): PartialScope {
    return {
      name: `component:${this.componentName}`,
      isolated: true,
      scope: this.props,
    }
  }
}

class SlotOutsideComponentTag extends Tag {
  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainTokens, liquid)
    throw new Error("slot tags must be direct children of a component tag")
  }

  render(): never {
    throw new Error("slot tags must be direct children of a component tag")
  }
}

class YieldTag extends Tag {
  private readonly slotName: string

  constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(token, remainTokens, liquid)
    token.tokenizer.skipBlank()
    this.slotName = token.tokenizer.end() ? "default" : readStaticName(token, "yield")
  }

  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const slots = ctx.getRegister<ComponentSlots | undefined>(componentSlotsRegister)
    if (slots === undefined) {
      throw new Error("yield tags can only be rendered inside a component")
    }
    const slot = slots[this.slotName]
    if (slot === undefined) {
      return
    }
    if (slot.html === undefined) {
      slot.html = (yield slot.liquid.renderer.renderTemplates(
        slot.templates,
        slot.context,
      )) as string
    }
    emitter.write(slot.html)
  }
}

const createComponentTag = (
  componentEngine: Liquid,
  { annotateComponents = false }: ComponentDialectOptions,
) =>
  class ComponentTag extends Tag {
    private readonly componentName: string
    private readonly hash: Hash
    private readonly defaultTemplates: Template[] = []
    private readonly namedTemplates = new Map<string, Template[]>()
    private readonly componentPartial: ComponentPartialTemplate

    constructor(token: TagToken, remainTokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
      super(token, remainTokens, liquid)

      const name = token.tokenizer.readQuoted()
      if (name === undefined) {
        throw new Error("component name must be a quoted string")
      }
      this.componentName = name.content
      token.tokenizer.skipBlank()
      if (!token.tokenizer.end()) {
        token.tokenizer.assert(token.tokenizer.read() === ",", "expected comma before props")
        token.tokenizer.skipBlank()
        token.tokenizer.assert(!token.tokenizer.end(), "expected props after comma")
      }
      this.hash = new Hash(token.tokenizer, liquid.options.keyValueSeparator)
      token.tokenizer.skipBlank()
      token.tokenizer.assert(token.tokenizer.end(), "invalid component props")
      for (const [prop, value] of Object.entries(this.hash.hash)) {
        token.tokenizer.assert(value !== undefined, `component prop ${prop} requires a value`)
      }
      this.componentPartial = new ComponentPartialTemplate(
        token,
        this.componentName,
        componentEngine,
        Object.keys(this.hash.hash),
      )

      let closed = false
      parser
        .parseStream(remainTokens)
        .on<TagToken>("tag:slot", (slotToken) => {
          const slot = parseSlot(slotToken, remainTokens, parser)
          if (this.namedTemplates.has(slot.name)) {
            throw new Error(`duplicate component slot "${slot.name}"`)
          }
          this.namedTemplates.set(slot.name, slot.templates)
        })
        .on<TagToken>("tag:endcomponent", function (endToken) {
          assertEndTagHasNoArguments(endToken)
          closed = true
          this.stop()
        })
        .on<Template>("template", (template) => this.defaultTemplates.push(template))
        .on("end", () => {
          throw new Error(`tag ${token.getText()} not closed`)
        })
        .start()

      if (!closed) {
        throw new Error(`tag ${token.getText()} not closed`)
      }
    }

    *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
      const props = (yield this.hash.render(ctx)) as Record<string, unknown>
      const slots: ComponentSlots = Object.create(null) as ComponentSlots
      slots.default = {
        context: ctx,
        liquid: this.liquid,
        templates: this.defaultTemplates,
      }

      for (const [name, templates] of this.namedTemplates) {
        slots[name] = { context: ctx, liquid: this.liquid, templates }
      }

      const childCtx = ctx.spawn(props)
      childCtx.setRegister(componentSlotsRegister, slots)
      const templates = ctx.sync
        ? componentEngine.parseFileSync(this.componentName)
        : ((yield componentEngine.parseFile(this.componentName)) as Template[])
      if (annotateComponents) {
        emitter.write(`<!--splatpad-component:start:${encodeURIComponent(this.componentName)}-->`)
      }
      yield componentEngine.renderer.renderTemplates(templates, childCtx, emitter)
      if (annotateComponents) {
        emitter.write(`<!--splatpad-component:end:${encodeURIComponent(this.componentName)}-->`)
      }
    }

    *children(partials: boolean): Generator<unknown, Template[]> {
      yield undefined
      const callerTemplates = [this.defaultTemplates, ...this.namedTemplates.values()].flat()
      return partials ? [...callerTemplates, this.componentPartial] : callerTemplates
    }

    *arguments(): Generator<ValueToken, void, unknown> {
      for (const value of Object.values(this.hash.hash)) {
        if (value !== undefined) {
          yield value as ValueToken
        }
      }
    }
  }

export const registerComponentDialect = (
  engine: Liquid,
  componentEngine: Liquid,
  options: ComponentDialectOptions = {},
): void => {
  engine.registerTag("component", createComponentTag(componentEngine, options))
  engine.registerTag("slot", SlotOutsideComponentTag)
  engine.registerTag("yield", YieldTag)

  if (componentEngine !== engine) {
    componentEngine.registerTag("component", createComponentTag(componentEngine, options))
    componentEngine.registerTag("slot", SlotOutsideComponentTag)
    componentEngine.registerTag("yield", YieldTag)
  }
}
