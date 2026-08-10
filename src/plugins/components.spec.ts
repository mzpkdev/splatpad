import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { Liquid } from "liquidjs"
import { registerComponentDialect } from "./components"

describe("component dialect", () => {
  let componentsRoot: string
  let partialsRoot: string
  let siteRoot: string
  let engine: Liquid

  beforeEach(async () => {
    siteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "splatpad-components-"))
    componentsRoot = path.join(siteRoot, "components")
    partialsRoot = path.join(siteRoot, "partials")
    await Promise.all([fs.mkdir(componentsRoot), fs.mkdir(partialsRoot)])

    const options = {
      cache: false,
      extname: ".liquid",
      partials: partialsRoot,
      strictFilters: true,
      strictVariables: true,
    }
    engine = new Liquid(options)
    const componentEngine = new Liquid({ ...options, root: componentsRoot })
    registerComponentDialect(engine, componentEngine)
  })

  afterEach(async () => {
    await fs.rm(siteRoot, { recursive: true })
  })

  const component = async (name: string, source: string): Promise<void> => {
    await fs.writeFile(path.join(componentsRoot, `${name}.liquid`), source)
  }

  it("renders props and caller-scoped default and named slots", async () => {
    await component(
      "card",
      `[{{ tone }}|{{ global_value }}|{% yield "header" %}|{% yield %}|{% yield "missing" %}]`,
    )

    await expect(
      engine.parseAndRender(
        `{% component "card", tone: tone %}<i>{{ caller }}</i>{% slot "header" %}<b>{{ caller }}</b>{% endslot %}{% endcomponent %}`,
        { caller: "trusted", tone: "quiet" },
        { globals: { global_value: "global" } },
      ),
    ).resolves.toBe("[quiet|global|<b>trusted</b>|<i>trusted</i>|]")
  })

  it("isolates the component template from caller variables", async () => {
    await component("private", "{{ caller_only }}")

    await expect(
      engine.parseAndRender(`{% component "private" %}{% endcomponent %}`, {
        caller_only: "secret",
      }),
    ).rejects.toThrow(/caller_only/)
  })

  it("renders nested components and evaluates their slots in their caller scope", async () => {
    await component("outer", "O({% yield %})")
    await component("inner", "I({{ color }}:{% yield %})")

    await expect(
      engine.parseAndRender(
        `{% component "outer" %}{% component "inner", color: color %}{{ mark }}{% endcomponent %}{% endcomponent %}`,
        { color: "red", mark: "!" },
      ),
    ).resolves.toBe("O(I(red:!))")
  })

  it("renders components and lazily cached slots synchronously", async () => {
    await component(
      "outer",
      `O({{ title }}|{% yield "header" %}|{% yield %}|{% yield "cached" %}|{% yield "cached" %}|{% yield "missing" %})`,
    )
    await component("inner", "I({{ color }}:{% yield %})")

    expect(
      engine.parseAndRenderSync(
        `{% component "outer", title: title %}{% component "inner", color: color %}{{ mark }}{% endcomponent %}{% slot "header" %}<b>{{ caller }}</b>{% endslot %}{% slot "cached" %}{% increment count %}{% endslot %}{% slot "unused" %}{{ missing }}{% endslot %}{% endcomponent %}|{% increment count %}`,
        { caller: "trusted", color: "red", mark: "!", title: "Welcome" },
      ),
    ).toBe("O(Welcome|<b>trusted</b>|I(red:!)|0|0|)|1")
  })

  it("does not evaluate unused slots", async () => {
    await component("plain", "plain")

    await expect(
      engine.parseAndRender(
        `{% component "plain" %}{% slot "unused" %}{{ missing }}{% endslot %}{% endcomponent %}`,
      ),
    ).resolves.toBe("plain")
  })

  it("renders each yielded slot once and caches its HTML", async () => {
    await component("twice", `{% yield "item" %}|{% yield "item" %}`)

    await expect(
      engine.parseAndRender(
        `{% component "twice" %}{% slot "item" %}{% increment count %}{% endslot %}{% endcomponent %}|{% increment count %}`,
      ),
    ).resolves.toBe("0|0|1")
  })

  it("includes component templates and caller slots in static analysis", async () => {
    await component("analyzed", "{{ component_only }} {{ label }}")
    const templates = engine.parse(
      `{% component "analyzed", label: caller_label %}{{ body_only }}{% slot "header" %}{{ named_only }}{% endslot %}{% endcomponent %}`,
    )

    const analysis = await engine.analyze(templates, { partials: true })
    expect(Object.keys(analysis.variables)).toEqual(
      expect.arrayContaining([
        "caller_label",
        "body_only",
        "named_only",
        "component_only",
        "label",
      ]),
    )

    const shallowAnalysis = await engine.analyze(templates, { partials: false })
    expect(shallowAnalysis.variables).not.toHaveProperty("component_only")
    expect(shallowAnalysis.variables).toHaveProperty("body_only")
    expect(shallowAnalysis.variables).toHaveProperty("named_only")
  })

  it("rejects the reserved default slot name", async () => {
    await component("card", "{% yield %}")

    await expect(
      engine.parseAndRender(
        `{% component "card" %}{% slot "default" %}named{% endslot %}{% endcomponent %}`,
      ),
    ).rejects.toThrow(/slot "default" is reserved/)
  })

  it("keeps partial lookup separate from preferential component lookup", async () => {
    await fs.writeFile(path.join(partialsRoot, "card.liquid"), "partial")
    await component("card", "component")

    await expect(
      engine.parseAndRender(`{% render "card" %}|{% component "card" %}{% endcomponent %}`),
    ).resolves.toBe("partial|component")
  })

  it("confines component paths to the components root", async () => {
    await fs.writeFile(path.join(partialsRoot, "outside.liquid"), "outside")

    await expect(
      engine.parseAndRender(`{% component "../partials/outside" %}{% endcomponent %}`),
    ).rejects.toThrow(/Failed to lookup/)
  })

  it.each([
    ["dynamic component name", `{% component component_name %}{% endcomponent %}`],
    [
      "dynamic slot name",
      `{% component "card" %}{% slot slot_name %}{% endslot %}{% endcomponent %}`,
    ],
    ["slot outside component", `{% slot "header" %}{% endslot %}`],
    [
      "indirect slot",
      `{% component "card" %}{% if true %}{% slot "header" %}{% endslot %}{% endif %}{% endcomponent %}`,
    ],
    [
      "duplicate slot",
      `{% component "card" %}{% slot "header" %}{% endslot %}{% slot "header" %}{% endslot %}{% endcomponent %}`,
    ],
    ["component end arguments", `{% component "card" %}{% endcomponent "card" %}`],
    [
      "slot end arguments",
      `{% component "card" %}{% slot "header" %}{% endslot "header" %}{% endcomponent %}`,
    ],
    ["missing component end", `{% component "card" %}`],
    ["missing slot end", `{% component "card" %}{% slot "header" %}{% endcomponent %}`],
    ["yield outside component", `{% yield %}`],
    ["dynamic yield name", `{% yield slot_name %}`],
  ])("rejects %s", async (_case, source) => {
    await component("card", "{% yield %}")

    await expect(engine.parseAndRender(source, { component_name: "card" })).rejects.toThrow()
  })
})
