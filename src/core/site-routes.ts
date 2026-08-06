import * as fs from "node:fs"
import * as path from "node:path"

export interface SiteRoute {
  entry: string
  inputName: string
  route: string
  template: string
  templateName: string
}

export const templateExtensions = [".liquid.html", ".liquid", ".html"] as const
const segmentPattern = /^[a-z0-9][a-z0-9-]*$/

const normalizeRelative = (value: string): string => value.split(path.sep).join("/")

export const templateExtensionFor = (file: string): string | undefined =>
  templateExtensions.find((extension) => file.endsWith(extension))

export const isTemplateFile = (file: string): boolean => templateExtensionFor(file) !== undefined

const collectTemplates = (directory: string): string[] =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = path.resolve(directory, entry.name)

    if (entry.isSymbolicLink()) {
      throw new Error(`Page templates cannot be symbolic links: "${absolutePath}".`)
    }
    if (entry.isDirectory()) {
      return collectTemplates(absolutePath)
    }
    if (entry.isFile() && isTemplateFile(entry.name)) {
      return [absolutePath]
    }
    return []
  })

const routeParts = (templateName: string): string[] => {
  const parts = templateName.split("/")
  return parts.at(-1) === "index" ? parts.slice(0, -1) : parts
}

const toSiteRoute = (siteRoot: string, pagesRoot: string, template: string): SiteRoute => {
  const relativeTemplate = normalizeRelative(path.relative(pagesRoot, template))
  const extension = templateExtensionFor(relativeTemplate)
  if (extension === undefined) {
    throw new Error(`Unsupported page template: "${relativeTemplate}".`)
  }
  const templateName = relativeTemplate.slice(0, -extension.length)
  const sourceParts = templateName.split("/")
  const invalidSegment = sourceParts.find((segment) => !segmentPattern.test(segment))

  if (invalidSegment !== undefined) {
    throw new Error(
      `Invalid page path "${relativeTemplate}": segment "${invalidSegment}" must be lowercase kebab-case.`,
    )
  }

  const parts = routeParts(templateName)
  const route = parts.length === 0 ? "/" : `/${parts.join("/")}/`

  return {
    entry: path.resolve(siteRoot, ...parts, "index.html"),
    inputName: parts.length === 0 ? "index" : parts.join("/"),
    route,
    template,
    templateName,
  }
}

export const discoverSiteRoutes = (root: string): SiteRoute[] => {
  const siteRoot = path.resolve(root)
  const pagesRoot = fs.realpathSync(path.resolve(siteRoot, "pages"))
  const routes = collectTemplates(pagesRoot).map((template) =>
    toSiteRoute(siteRoot, pagesRoot, template),
  )
  const routeOwners = new Map<string, string>()
  const entryOwners = new Map<string, string>()

  for (const route of routes) {
    const routeOwner = routeOwners.get(route.route)
    if (routeOwner !== undefined) {
      throw new Error(
        `Route collision for "${route.route}": both "${routeOwner}" and "${route.template}" map to it.`,
      )
    }
    routeOwners.set(route.route, route.template)

    const entryOwner = entryOwners.get(route.entry)
    if (entryOwner !== undefined) {
      throw new Error(
        `Output collision for "${route.entry}": both "${entryOwner}" and "${route.template}" map to it.`,
      )
    }
    entryOwners.set(route.entry, route.template)
  }

  // oxlint-disable-next-line unicorn/no-array-sort -- Discovery creates this array and does not expose it before sorting.
  return routes.sort((left, right) => {
    if (left.route === "/") {
      return -1
    }
    if (right.route === "/") {
      return 1
    }
    return left.route.localeCompare(right.route)
  })
}

export const routeFromRequestPath = (requestPath: string): string => {
  const pathname = new URL(requestPath, "http://localhost").pathname

  if (pathname === "/index.html") {
    return "/"
  }
  if (pathname.endsWith("/index.html")) {
    return pathname.slice(0, -"index.html".length)
  }
  return pathname !== "/" && !pathname.endsWith("/") ? `${pathname}/` : pathname
}

export const findSiteRoute = (
  routes: readonly SiteRoute[],
  requestPath: string,
): SiteRoute | undefined => {
  const route = routeFromRequestPath(requestPath)
  return routes.find((candidate) => candidate.route === route)
}
