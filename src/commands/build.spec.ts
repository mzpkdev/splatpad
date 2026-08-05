import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, describe as context, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  createSiteConfig: vi.fn(() => ({ config: true })),
  terminal: { json: vi.fn(), log: vi.fn(), quiet: false, jsonMode: false },
  viteBuild: vi.fn(),
}))

vi.mock("cmdore", () => ({
  defineArgument: vi.fn((value) => value),
  defineCommand: vi.fn((value) => value),
  defineOption: vi.fn((value) => value),
  effect: vi.fn((value) => value),
  terminal: mocks.terminal,
}))
vi.mock("vite", () => ({ build: mocks.viteBuild }))
vi.mock("../core/site-config", () => ({
  createSiteConfig: mocks.createSiteConfig,
}))

import { build } from "./build"

describe("build", () => {
  let temporaryDirectory: string
  let siteRoot: string
  let outsideRoot: string

  beforeEach(async () => {
    vi.clearAllMocks()
    temporaryDirectory = await mkdtemp(join(tmpdir(), "splatpad-build-"))
    siteRoot = join(temporaryDirectory, "site")
    outsideRoot = join(temporaryDirectory, "outside")
    await Promise.all([mkdir(siteRoot), mkdir(outsideRoot)])
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(temporaryDirectory, { force: true, recursive: true })
  })

  context("when no output directory is provided", () => {
    it("builds into dist inside the site root", async () => {
      const absoluteOutDir = resolve(siteRoot, "dist")

      await build(siteRoot)

      expect(mocks.createSiteConfig).toHaveBeenCalledWith(siteRoot, {
        outDir: absoluteOutDir,
      })
      expect(mocks.viteBuild).toHaveBeenCalledWith({ config: true })
      expect(mocks.terminal.json).toHaveBeenCalledWith({
        command: "build",
        root: siteRoot,
        outDir: absoluteOutDir,
      })
    })
  })

  context("when a relative output directory is provided", () => {
    context("and it is nested inside the site root", () => {
      it("resolves it from the site root", async () => {
        await build(siteRoot, "public/generated")

        expect(mocks.createSiteConfig).toHaveBeenCalledWith(siteRoot, {
          outDir: resolve(siteRoot, "public/generated"),
        })
      })
    })
  })

  context("when an absolute output directory is provided", () => {
    context("and it is nested inside the site root", () => {
      it("uses it unchanged", async () => {
        const absoluteOutDir = resolve(siteRoot, "public/generated")

        await build(siteRoot, absoluteOutDir)

        expect(mocks.createSiteConfig).toHaveBeenCalledWith(siteRoot, {
          outDir: absoluteOutDir,
        })
      })
    })
  })

  context.each([
    ["the site root itself", "."],
    ["the normalized site root itself", "dist/.."],
    ["the parent directory", ".."],
    ["a sibling directory", "../site-output"],
  ])("when the output directory is %s", (_description, outputDirectory) => {
    it("rejects it before creating or running a Vite build", async () => {
      const absoluteOutDir = resolve(siteRoot, outputDirectory)

      await expect(build(siteRoot, outputDirectory)).rejects.toThrow(
        `Unsafe output directory "${absoluteOutDir}": build output must be inside site root "${siteRoot}".`,
      )
      expect(mocks.createSiteConfig).not.toHaveBeenCalled()
      expect(mocks.viteBuild).not.toHaveBeenCalled()
    })
  })

  context("when an absolute output directory is outside the site root", () => {
    it("rejects it before creating or running a Vite build", async () => {
      await expect(build(siteRoot, outsideRoot)).rejects.toThrow(
        `Unsafe output directory "${outsideRoot}": build output must be inside site root "${siteRoot}".`,
      )
      expect(mocks.createSiteConfig).not.toHaveBeenCalled()
      expect(mocks.viteBuild).not.toHaveBeenCalled()
    })
  })

  context("when the output directory is a symlink outside the site root", () => {
    it("rejects its physically resolved path before creating or running a Vite build", async (testContext) => {
      const absoluteOutDir = join(siteRoot, "dist")

      try {
        await symlink(
          outsideRoot,
          absoluteOutDir,
          process.platform === "win32" ? "junction" : "dir",
        )
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (
          process.platform === "win32" &&
          ["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(code ?? "")
        ) {
          return testContext.skip()
        }
        throw error
      }

      const physicalRoot = await realpath(siteRoot)
      await expect(build(siteRoot)).rejects.toThrow(
        `Unsafe output directory "${absoluteOutDir}": its resolved path must be inside resolved site root "${physicalRoot}".`,
      )
      expect(mocks.createSiteConfig).not.toHaveBeenCalled()
      expect(mocks.viteBuild).not.toHaveBeenCalled()
    })
  })

  context("when a missing output directory has a symlinked ancestor outside the site root", () => {
    it("rejects the physically resolved ancestor before creating or running a Vite build", async (testContext) => {
      const symlinkedAncestor = join(siteRoot, "public")
      const absoluteOutDir = join(symlinkedAncestor, "generated")

      try {
        await symlink(
          outsideRoot,
          symlinkedAncestor,
          process.platform === "win32" ? "junction" : "dir",
        )
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (
          process.platform === "win32" &&
          ["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(code ?? "")
        ) {
          return testContext.skip()
        }
        throw error
      }

      const physicalRoot = await realpath(siteRoot)
      await expect(build(siteRoot, "public/generated")).rejects.toThrow(
        `Unsafe output directory "${absoluteOutDir}": its resolved path must be inside resolved site root "${physicalRoot}".`,
      )
      expect(mocks.createSiteConfig).not.toHaveBeenCalled()
      expect(mocks.viteBuild).not.toHaveBeenCalled()
    })
  })

  context("when a missing output directory has a dangling symlink ancestor", () => {
    it("rejects the unverifiable path before creating or running a Vite build", async (testContext) => {
      const symlinkedAncestor = join(siteRoot, "public")
      const missingTarget = join(outsideRoot, "missing")
      const absoluteOutDir = join(symlinkedAncestor, "generated")

      try {
        await symlink(
          missingTarget,
          symlinkedAncestor,
          process.platform === "win32" ? "junction" : "dir",
        )
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (
          process.platform === "win32" &&
          ["EACCES", "EINVAL", "ENOSYS", "EPERM", "UNKNOWN"].includes(code ?? "")
        ) {
          return testContext.skip()
        }
        throw error
      }

      await expect(build(siteRoot, "public/generated")).rejects.toThrow(
        `Unsafe output directory "${absoluteOutDir}": path ancestor "${symlinkedAncestor}" is a dangling symbolic link, so build containment cannot be verified.`,
      )
      expect(mocks.createSiteConfig).not.toHaveBeenCalled()
      expect(mocks.viteBuild).not.toHaveBeenCalled()
    })
  })
})
