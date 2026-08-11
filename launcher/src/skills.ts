import { createHash } from "node:crypto"
import { constants as fsConstants } from "node:fs"
import {
  access,
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

const MANAGED_MARKER = ".weft-managed"
const SKILL_FILE = "SKILL.md"

export interface SkillSyncOptions {
  sourceDir: string
  targetDir?: string | undefined
  force?: boolean | undefined
  readFile?: ((filePath: string) => Promise<string>) | undefined
  writeFile?: ((filePath: string, contents: string) => Promise<void>) | undefined
  copyFile?: ((from: string, to: string) => Promise<void>) | undefined
  mkdir?: ((dirPath: string, options?: { recursive?: boolean }) => Promise<void>) | undefined
  readdir?: ((dirPath: string) => Promise<string[]>) | undefined
  access?: ((filePath: string) => Promise<void>) | undefined
  rm?: ((filePath: string, options?: { force?: boolean }) => Promise<void>) | undefined
}

export interface SkillSyncEntry {
  name: string
  action: "installed" | "updated" | "unchanged" | "skipped"
  reason?: string
}

export interface SkillSyncResult {
  sourceDir: string
  targetDir: string
  entries: SkillSyncEntry[]
  installed: string[]
  updated: string[]
  unchanged: string[]
  skipped: SkillSyncEntry[]
}

export function defaultCodexSkillsDir(codexHome = process.env.CODEX_HOME): string {
  return path.join(codexHome && codexHome.length > 0 ? codexHome : path.join(homedir(), ".codex"), "skills")
}

function contentHash(contents: string): string {
  return createHash("sha256").update(contents).digest("hex")
}

async function listSkillNames(
  sourceDir: string,
  readdirImpl: (dirPath: string) => Promise<string[]>,
  accessImpl: (filePath: string) => Promise<void>,
): Promise<string[]> {
  let names: string[]
  try {
    names = await readdirImpl(sourceDir)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`skills source is unavailable at ${sourceDir}: ${message}`)
  }

  const skills: string[] = []
  for (const name of names) {
    if (name.startsWith(".")) continue
    try {
      await accessImpl(path.join(sourceDir, name, SKILL_FILE))
      skills.push(name)
    } catch {
      // Only directories with SKILL.md are product skills.
    }
  }
  return skills.sort()
}

/**
 * Install or refresh weft-managed Codex skills.
 *
 * Product skills ship inside the weft-codex runtime. They are copied into the
 * user's Codex home so Desktop can load them, and are refreshed whenever the
 * runtime is upgraded. A `.weft-managed` marker marks ownership; divergent
 * unmarked local copies are left alone unless `force` is set.
 */
export async function ensureManagedSkills(options: SkillSyncOptions): Promise<SkillSyncResult> {
  const sourceDir = path.resolve(options.sourceDir)
  const targetDir = path.resolve(options.targetDir ?? defaultCodexSkillsDir())
  const force = options.force === true
  const readFileImpl = options.readFile ?? ((filePath: string) => readFile(filePath, "utf8"))
  const writeFileImpl = options.writeFile ?? ((filePath: string, contents: string) => writeFile(filePath, contents, "utf8"))
  const copyFileImpl = options.copyFile ?? ((from: string, to: string) => copyFile(from, to))
  const mkdirImpl = options.mkdir ?? (async (dirPath: string) => {
    await mkdir(dirPath, { recursive: true })
  })
  const readdirImpl = options.readdir ?? (async (dirPath: string) => readdir(dirPath))
  const accessImpl = options.access ?? (async (filePath: string) => {
    await access(filePath, fsConstants.R_OK)
  })
  const rmImpl = options.rm ?? (async (filePath: string) => {
    await rm(filePath, { force: true })
  })

  const skillNames = await listSkillNames(sourceDir, readdirImpl, accessImpl)
  await mkdirImpl(targetDir, { recursive: true })

  const entries: SkillSyncEntry[] = []
  for (const name of skillNames) {
    const sourceFile = path.join(sourceDir, name, SKILL_FILE)
    const targetSkillDir = path.join(targetDir, name)
    const targetFile = path.join(targetSkillDir, SKILL_FILE)
    const markerFile = path.join(targetSkillDir, MANAGED_MARKER)
    const sourceContents = await readFileImpl(sourceFile)
    const sourceDigest = contentHash(sourceContents)

    let existingContents: string | null = null
    try {
      existingContents = await readFileImpl(targetFile)
    } catch {
      existingContents = null
    }

    let managed = false
    try {
      await readFileImpl(markerFile)
      managed = true
    } catch {
      managed = false
    }

    if (existingContents === null) {
      await mkdirImpl(targetSkillDir, { recursive: true })
      await copyFileImpl(sourceFile, targetFile)
      await writeFileImpl(markerFile, `${sourceDigest}\n`)
      entries.push({ name, action: "installed" })
      continue
    }

    if (existingContents === sourceContents) {
      // Keep the marker current so upgrades can recognize ownership later.
      await writeFileImpl(markerFile, `${sourceDigest}\n`)
      entries.push({ name, action: "unchanged" })
      continue
    }

    if (!managed && !force) {
      entries.push({
        name,
        action: "skipped",
        reason: "local skill differs and is not weft-managed; re-run with --force to overwrite",
      })
      continue
    }

    await mkdirImpl(targetSkillDir, { recursive: true })
    await copyFileImpl(sourceFile, targetFile)
    await writeFileImpl(markerFile, `${sourceDigest}\n`)
    // Drop stale sidecar files only when we own the directory.
    try {
      const children = await readdirImpl(targetSkillDir)
      for (const child of children) {
        if (child === SKILL_FILE || child === MANAGED_MARKER) continue
        await rmImpl(path.join(targetSkillDir, child), { force: true })
      }
    } catch {
      // Best-effort cleanup; the skill body is already refreshed.
    }
    entries.push({ name, action: "updated" })
  }

  return {
    sourceDir,
    targetDir,
    entries,
    installed: entries.filter((entry) => entry.action === "installed").map((entry) => entry.name),
    updated: entries.filter((entry) => entry.action === "updated").map((entry) => entry.name),
    unchanged: entries.filter((entry) => entry.action === "unchanged").map((entry) => entry.name),
    skipped: entries.filter((entry) => entry.action === "skipped"),
  }
}

export function formatSkillSyncSummary(result: SkillSyncResult): string {
  const parts = [
    `${result.installed.length} installed`,
    `${result.updated.length} updated`,
    `${result.unchanged.length} unchanged`,
    `${result.skipped.length} skipped`,
  ]
  return `skills ${parts.join(", ")} → ${result.targetDir}`
}
