import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"
import { defineCommand, effect, terminal } from "cmdore"
import { build as viteBuild } from "vite"
import { siteRoot } from "../arguments/index"
import { createSiteConfig } from "../core/site-config"
import { outDir } from "../options/index"

export const build = async (root = ".", outputDirectory = "dist"): Promise<void> => {
  const absoluteRoot = resolve(process.cwd(), root)
  const absoluteOutDir = resolve(absoluteRoot, outputDirectory)
  const relativeOutDir = relative(absoluteRoot, absoluteOutDir)

  if (
    relativeOutDir === "" ||
    relativeOutDir === ".." ||
    relativeOutDir.startsWith(`..${sep}`) ||
    isAbsolute(relativeOutDir)
  ) {
    throw new Error(
      `Unsafe output directory "${absoluteOutDir}": build output must be inside site root "${absoluteRoot}".`,
    )
  }

  const physicalRoot = await realpath(absoluteRoot)
  let existingOutPath = absoluteOutDir

  while (true) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- Output ancestry must be inspected in order.
      const physicalOutPath = await realpath(existingOutPath)
      const relativePhysicalOutPath = relative(physicalRoot, physicalOutPath)
      const isExistingOutput = existingOutPath === absoluteOutDir

      if (
        (isExistingOutput && relativePhysicalOutPath === "") ||
        relativePhysicalOutPath === ".." ||
        relativePhysicalOutPath.startsWith(`..${sep}`) ||
        isAbsolute(relativePhysicalOutPath)
      ) {
        throw new Error(
          `Unsafe output directory "${absoluteOutDir}": its resolved path must be inside resolved site root "${physicalRoot}".`,
        )
      }

      break
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code

      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error
      }

      try {
        // oxlint-disable-next-line no-await-in-loop -- Output ancestry must be inspected in order.
        const pathStats = await lstat(existingOutPath)

        if (pathStats.isSymbolicLink()) {
          throw new Error(
            `Unsafe output directory "${absoluteOutDir}": path ancestor "${existingOutPath}" is a dangling symbolic link, so build containment cannot be verified.`,
            { cause: error },
          )
        }
      } catch (lstatError) {
        const lstatCode = (lstatError as NodeJS.ErrnoException).code

        if (lstatCode !== "ENOENT" && lstatCode !== "ENOTDIR") {
          throw lstatError
        }
      }

      const parentPath = dirname(existingOutPath)
      if (parentPath === existingOutPath) {
        throw error
      }
      existingOutPath = parentPath
    }
  }

  terminal.log(`Building ${absoluteRoot}`)
  await viteBuild(createSiteConfig(absoluteRoot, { outDir: absoluteOutDir }))
  terminal.log(`Built ${absoluteRoot} to ${absoluteOutDir}`)
  terminal.json({ command: "build", root: absoluteRoot, outDir: absoluteOutDir })
}

export default defineCommand({
  name: "build",
  description: "Build a Liquid site for production.",
  arguments: [siteRoot],
  options: [outDir],
  run: ({ root, "out-dir": outputDirectory }) => effect(() => build(root, outputDirectory)),
})
