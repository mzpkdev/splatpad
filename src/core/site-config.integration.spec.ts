import * as fs from "node:fs/promises"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { build as viteBuild, createServer, type ViteDevServer } from "vite"
import { createSiteConfig } from "./site-config"

const availablePort = async (): Promise<number> => {
  const portServer = net.createServer()
  await new Promise<void>((resolve) => portServer.listen(0, "127.0.0.1", resolve))
  const address = portServer.address() as net.AddressInfo
  await new Promise<void>((resolve, reject) =>
    portServer.close((error) => (error === undefined ? resolve() : reject(error))),
  )
  return address.port
}

const waitFor = async (assertion: () => Promise<void>, timeout = 3_000): Promise<void> => {
  const deadline = Date.now() + timeout
  const attempt = async (): Promise<void> => {
    try {
      await assertion()
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
      await attempt()
    }
  }
  await attempt()
}

describe("site dev server", () => {
  let baseUrl: string
  let server: ViteDevServer
  let siteRoot: string

  beforeAll(async () => {
    siteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "splatpad-integration-"))
    await fs.cp(path.resolve(process.cwd(), "example"), siteRoot, { recursive: true })
    const port = await availablePort()
    server = await createServer(
      createSiteConfig(siteRoot, {
        design: true,
        server: { host: "127.0.0.1", port, strictPort: true },
      }),
    )
    await server.listen()
    baseUrl = `http://127.0.0.1:${port}`
  })

  afterAll(async () => {
    await server.close()
    await fs.rm(siteRoot, { recursive: true })
  })

  it("serves distinct pages at their canonical routes", async () => {
    const home = await fetch(`${baseUrl}/`)
    const menu = await fetch(`${baseUrl}/menu/`)

    expect(home.status).toBe(200)
    expect(await home.text()).toContain("A little joy, baked daily")
    expect(menu.status).toBe(200)
    expect(await menu.text()).toContain("Today’s bake")
  })

  it("serves the design shell and current route manifest from the reserved path", async () => {
    const shell = await fetch(`${baseUrl}/__splatpad/design/`)
    const manifest = await fetch(`${baseUrl}/__splatpad/design/routes`)
    const stylesheet = await fetch(`${baseUrl}/__splatpad/design/styles.css`)

    expect(shell.status).toBe(200)
    const shellHtml = await shell.text()
    expect(shellHtml).toContain("Splatpad Design")
    expect(shellHtml).not.toContain("/@vite/client")
    expect(manifest.status).toBe(200)
    expect(stylesheet.status).toBe(200)
    expect(await stylesheet.text()).toContain(".react-flow")
    expect(await manifest.json()).toEqual({
      routes: [
        { route: "/" },
        { route: "/journal/" },
        { route: "/journal/seasonal-jam/" },
        { route: "/journal/slow-mornings/" },
        { route: "/menu/" },
        { route: "/story/" },
        { route: "/visit/" },
      ],
      siteName: path.basename(siteRoot),
    })
  })

  it("redirects a discovered slashless route to its canonical route", async () => {
    const response = await fetch(`${baseUrl}/menu?today=true`, { redirect: "manual" })

    expect(response.status).toBe(308)
    expect(response.headers.get("location")).toBe("/menu/?today=true")
  })

  it.each(["/missing/", "/assets/foo.css"])(
    "returns 404 instead of the homepage for %s",
    async (requestPath) => {
      const response = await fetch(`${baseUrl}${requestPath}`, {
        headers: { Accept: "text/html" },
      })
      const body = await response.text()

      expect(response.status).toBe(404)
      expect(body).not.toContain("A little joy, baked daily")
    },
  )

  it("tracks create, break, fix, rename, and delete without restarting", async () => {
    const pageFile = path.join(siteRoot, "pages", "journal", "post.html")
    await fs.mkdir(path.dirname(pageFile), { recursive: true })
    await fs.writeFile(pageFile, '<h1 class="text-fuchsia-700">New post</h1>')
    await waitFor(async () => {
      expect((await fetch(`${baseUrl}/journal/post/`)).status).toBe(200)
    })
    await waitFor(async () => {
      expect(await (await fetch(`${baseUrl}/__uno.css`)).text()).toContain("text-fuchsia-700")
    })

    await fs.writeFile(pageFile, "{% if %}")
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/journal/post/`)
      expect(response.status).toBe(500)
      expect(await response.text()).toContain("ErrorOverlay")
    })

    await fs.writeFile(pageFile, "<h1>Recovered</h1>")
    await waitFor(async () => {
      expect(await (await fetch(`${baseUrl}/journal/post/`)).text()).toContain("Recovered")
    })

    const renamedFile = path.join(siteRoot, "pages", "journal", "news.liquid.html")
    await fs.rename(pageFile, renamedFile)
    await waitFor(async () => {
      expect(
        (
          await fetch(`${baseUrl}/journal/post/`, {
            headers: { Accept: "text/html" },
          })
        ).status,
      ).toBe(404)
      expect((await fetch(`${baseUrl}/journal/news/`)).status).toBe(200)
    })

    await fs.rm(renamedFile)
    const staleMarker = path.join(siteRoot, "journal", "news", "index.html")
    await fs.mkdir(path.dirname(staleMarker), { recursive: true })
    await fs.writeFile(staleMarker, "stale marker")
    await waitFor(async () => {
      const response = await fetch(`${baseUrl}/journal/news/`, {
        headers: { Accept: "text/html" },
      })
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain("stale marker")
    })
  })

  it("builds nested routes from virtual HTML entries", async () => {
    await fs.mkdir(path.join(siteRoot, "pages", "journal"), { recursive: true })
    await fs.writeFile(
      path.join(siteRoot, "pages", "journal", "post.liquid.html"),
      '<h1 class="text-fuchsia-700">Built post</h1><link rel="stylesheet" href="/__uno.css">',
    )

    await viteBuild(createSiteConfig(siteRoot, { outDir: path.join(siteRoot, "dist") }))

    await expect(
      fs.readFile(path.join(siteRoot, "dist", "journal", "post", "index.html"), "utf8"),
    ).resolves.toContain("Built post")
    const assetNames = await fs.readdir(path.join(siteRoot, "dist", "assets"))
    const cssName = assetNames.find((file) => file.endsWith(".css"))
    expect(cssName).toBeDefined()
    const css = await fs.readFile(path.join(siteRoot, "dist", "assets", cssName!), "utf8")
    expect(css).toContain("text-fuchsia-700")
  })
})
