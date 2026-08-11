import assert from "node:assert/strict"
import test from "node:test"

import { ensureManagedSkills } from "./skills.js"

function memoryFs(seed: Record<string, string> = {}) {
  const files = new Map(Object.entries(seed))
  const dirs = new Set<string>()
  for (const filePath of files.keys()) {
    let current = filePath
    while (current.includes("/")) {
      current = current.slice(0, current.lastIndexOf("/"))
      if (!current) break
      dirs.add(current)
    }
  }

  return {
    files,
    async readFile(filePath: string) {
      const value = files.get(filePath)
      if (value === undefined) throw new Error(`ENOENT: ${filePath}`)
      return value
    },
    async writeFile(filePath: string, contents: string) {
      files.set(filePath, contents)
      let current = filePath
      while (current.includes("/")) {
        current = current.slice(0, current.lastIndexOf("/"))
        if (!current) break
        dirs.add(current)
      }
    },
    async copyFile(from: string, to: string) {
      const value = files.get(from)
      if (value === undefined) throw new Error(`ENOENT: ${from}`)
      files.set(to, value)
      let current = to
      while (current.includes("/")) {
        current = current.slice(0, current.lastIndexOf("/"))
        if (!current) break
        dirs.add(current)
      }
    },
    async mkdir(dirPath: string) {
      dirs.add(dirPath)
    },
    async readdir(dirPath: string) {
      const prefix = dirPath.endsWith("/") ? dirPath : `${dirPath}/`
      const names = new Set<string>()
      for (const filePath of files.keys()) {
        if (!filePath.startsWith(prefix)) continue
        const rest = filePath.slice(prefix.length)
        names.add(rest.split("/")[0] ?? rest)
      }
      for (const candidate of dirs) {
        if (!candidate.startsWith(prefix)) continue
        const rest = candidate.slice(prefix.length)
        if (!rest || rest.includes("/")) continue
        names.add(rest)
      }
      return [...names].sort()
    },
    async access(filePath: string) {
      if (files.has(filePath) || dirs.has(filePath)) return
      throw new Error(`ENOENT: ${filePath}`)
    },
    async rm(filePath: string) {
      files.delete(filePath)
    },
  }
}

test("installs missing managed skills", async () => {
  const fs = memoryFs({
    "/runtime/skills/weft-derive-test-cases/SKILL.md": "# skill v1\n",
  })
  const result = await ensureManagedSkills({
    sourceDir: "/runtime/skills",
    targetDir: "/home/.codex/skills",
    ...fs,
  })
  assert.deepEqual(result.installed, ["weft-derive-test-cases"])
  assert.equal(fs.files.get("/home/.codex/skills/weft-derive-test-cases/SKILL.md"), "# skill v1\n")
  assert.match(fs.files.get("/home/.codex/skills/weft-derive-test-cases/.weft-managed") ?? "", /^[a-f0-9]{64}\n$/)
})

test("updates a weft-managed skill when the runtime package changes", async () => {
  const fs = memoryFs({
    "/runtime/skills/weft-derive-test-cases/SKILL.md": "# skill v2\n",
    "/home/.codex/skills/weft-derive-test-cases/SKILL.md": "# skill v1\n",
    "/home/.codex/skills/weft-derive-test-cases/.weft-managed": "old\n",
    "/home/.codex/skills/weft-derive-test-cases/stale-notes.md": "keep me? no\n",
  })
  const result = await ensureManagedSkills({
    sourceDir: "/runtime/skills",
    targetDir: "/home/.codex/skills",
    ...fs,
  })
  assert.deepEqual(result.updated, ["weft-derive-test-cases"])
  assert.equal(fs.files.get("/home/.codex/skills/weft-derive-test-cases/SKILL.md"), "# skill v2\n")
  assert.equal(fs.files.has("/home/.codex/skills/weft-derive-test-cases/stale-notes.md"), false)
})

test("leaves an unmarked local skill alone unless forced", async () => {
  const fs = memoryFs({
    "/runtime/skills/weft-derive-test-cases/SKILL.md": "# skill v2\n",
    "/home/.codex/skills/weft-derive-test-cases/SKILL.md": "# local fork\n",
  })
  const skipped = await ensureManagedSkills({
    sourceDir: "/runtime/skills",
    targetDir: "/home/.codex/skills",
    ...fs,
  })
  assert.equal(skipped.skipped.length, 1)
  assert.equal(fs.files.get("/home/.codex/skills/weft-derive-test-cases/SKILL.md"), "# local fork\n")

  const forced = await ensureManagedSkills({
    sourceDir: "/runtime/skills",
    targetDir: "/home/.codex/skills",
    force: true,
    ...fs,
  })
  assert.deepEqual(forced.updated, ["weft-derive-test-cases"])
  assert.equal(fs.files.get("/home/.codex/skills/weft-derive-test-cases/SKILL.md"), "# skill v2\n")
})

test("identical content is a no-op refresh of the managed marker", async () => {
  const fs = memoryFs({
    "/runtime/skills/weft-derive-test-cases/SKILL.md": "# skill v1\n",
    "/home/.codex/skills/weft-derive-test-cases/SKILL.md": "# skill v1\n",
  })
  const result = await ensureManagedSkills({
    sourceDir: "/runtime/skills",
    targetDir: "/home/.codex/skills",
    ...fs,
  })
  assert.deepEqual(result.unchanged, ["weft-derive-test-cases"])
  assert.match(fs.files.get("/home/.codex/skills/weft-derive-test-cases/.weft-managed") ?? "", /^[a-f0-9]{64}\n$/)
})
