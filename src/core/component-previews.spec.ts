import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverComponentPreviews, findComponentPreview } from "./component-previews"

describe("component previews", () => {
  let siteRoot: string

  beforeEach(async () => {
    siteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "splatpad-components-"))
    await fs.mkdir(path.join(siteRoot, "components"))
  })

  afterEach(async () => {
    await fs.rm(siteRoot, { recursive: true })
  })

  it("discovers components and their optional design templates", async () => {
    await fs.mkdir(path.join(siteRoot, "components", "forms"))
    await Promise.all([
      fs.writeFile(path.join(siteRoot, "components", "button.liquid"), "Button"),
      fs.writeFile(path.join(siteRoot, "components", "button.design.liquid"), "Preview"),
      fs.writeFile(path.join(siteRoot, "components", "forms", "input.liquid"), "Input"),
    ])

    expect(discoverComponentPreviews(siteRoot)).toEqual([
      {
        component: path.join(siteRoot, "components", "button.liquid"),
        name: "button",
        preview: path.join(siteRoot, "components", "button.design.liquid"),
        route: "/__splatpad/design/components/button/",
      },
      {
        component: path.join(siteRoot, "components", "forms", "input.liquid"),
        name: "forms/input",
        route: "/__splatpad/design/components/forms/input/",
      },
    ])
  })

  it("returns an empty catalog when the site has no components directory", async () => {
    await fs.rm(path.join(siteRoot, "components"), { recursive: true })

    expect(discoverComponentPreviews(siteRoot)).toEqual([])
  })

  it("rejects an orphaned design template", async () => {
    await fs.writeFile(path.join(siteRoot, "components", "missing.design.liquid"), "Preview")

    expect(() => discoverComponentPreviews(siteRoot)).toThrow("has no matching")
  })

  it("rejects symbolic links and invalid component names", async () => {
    const outside = path.join(siteRoot, "outside.liquid")
    await fs.writeFile(outside, "Outside")
    await fs.symlink(outside, path.join(siteRoot, "components", "linked.liquid"))
    expect(() => discoverComponentPreviews(siteRoot)).toThrow(
      "Component templates cannot be symbolic links",
    )

    await fs.rm(path.join(siteRoot, "components", "linked.liquid"))
    await fs.writeFile(path.join(siteRoot, "components", "Bad Name.liquid"), "Bad")
    expect(() => discoverComponentPreviews(siteRoot)).toThrow("must be lowercase kebab-case")
  })

  it("finds a preview from canonical and slashless request paths", async () => {
    await fs.writeFile(path.join(siteRoot, "components", "button.liquid"), "Button")
    const previews = discoverComponentPreviews(siteRoot)

    expect(findComponentPreview(previews, "/__splatpad/design/components/button")?.name).toBe(
      "button",
    )
    expect(findComponentPreview(previews, "/missing/")).toBeUndefined()
  })
})
