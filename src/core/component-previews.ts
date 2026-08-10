import * as fs from "node:fs"
import * as path from "node:path"

export const componentPreviewRootPath = "/__splatpad/design/components/"

export interface ComponentPreview {
  component: string
  name: string
  preview?: string
  route: string
}

const componentExtension = ".liquid"
const previewExtension = ".design.liquid"
const segmentPattern = /^[a-z0-9][a-z0-9-]*$/

const normalizeRelative = (value: string): string => value.split(path.sep).join("/")

const collectTemplates = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.resolve(directory, entry.name)

    if (entry.isSymbolicLink()) {
      throw new Error(`Component templates cannot be symbolic links: "${absolutePath}".`)
    }
    if (entry.isDirectory()) {
      return collectTemplates(absolutePath)
    }
    return entry.isFile() && entry.name.endsWith(componentExtension) ? [absolutePath] : []
  })

const validateName = (name: string, template: string): void => {
  const invalidSegment = name.split("/").find((segment) => !segmentPattern.test(segment))
  if (invalidSegment !== undefined) {
    throw new Error(
      `Invalid component path "${template}": segment "${invalidSegment}" must be lowercase kebab-case.`,
    )
  }
}

export const discoverComponentPreviews = (root: string): ComponentPreview[] => {
  const componentsRoot = path.resolve(root, "components")
  if (!fs.existsSync(componentsRoot)) {
    return []
  }

  const realComponentsRoot = fs.realpathSync(componentsRoot)
  const templates = collectTemplates(realComponentsRoot)
  const previews = new Map<string, string>()
  const components = new Map<string, string>()

  for (const template of templates) {
    const relativeTemplate = normalizeRelative(path.relative(realComponentsRoot, template))
    const isPreview = relativeTemplate.endsWith(previewExtension)
    const name = relativeTemplate.slice(
      0,
      -(isPreview ? previewExtension.length : componentExtension.length),
    )
    validateName(name, relativeTemplate)
    ;(isPreview ? previews : components).set(name, template)
  }

  for (const [name, preview] of previews) {
    if (!components.has(name)) {
      throw new Error(
        `Component preview "${preview}" has no matching "${name}${componentExtension}" component.`,
      )
    }
  }

  const catalog = [...components].map(([name, component]) => ({
    component,
    name,
    preview: previews.get(name),
    route: `${componentPreviewRootPath}${name}/`,
  }))
  // oxlint-disable-next-line unicorn/no-array-sort -- Discovery owns this new array until it returns.
  return catalog.sort((left, right) => left.name.localeCompare(right.name))
}

export const findComponentPreview = (
  previews: readonly ComponentPreview[],
  requestPath: string,
): ComponentPreview | undefined => {
  const pathname = new URL(requestPath, "http://localhost").pathname
  const route = pathname.endsWith("/") ? pathname : `${pathname}/`
  return previews.find((preview) => preview.route === route)
}
