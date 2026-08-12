import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  buildProbeExpression,
  classifyCompatibility,
  reportFromSnapshot,
  type CapabilityProbe,
} from "./probes.js"

const SELECTOR_IDS = [
  "renderer.root",
  "renderer.main",
  "sidebar.scroll",
  "sidebar.section",
  "sidebar.heading",
  "sidebar.projectCreate",
  "sidebar.threadRow",
  "sidebar.threadRoute",
  "sidebar.threadActive",
] as const

const TOKEN_VALUES = [
  "--vscode-sideBar-background", "--color-token-main-surface-primary",
  "--color-token-dropdown-background", "--color-token-foreground",
  "--color-token-text-secondary", "--color-token-border",
  "--color-token-border-heavy", "--color-token-primary",
  "--color-token-button-foreground", "--color-token-text-link-foreground",
  "--color-token-input-background", "--color-token-input-border",
  "--color-token-list-hover-background", "--font-sans", "--font-mono",
  "--radius-lg", "--radius-md", "--radius-sm",
]

/** A snapshot in which every probe passes; individual keys get flipped per test. */
function healthySnapshot(missing: string[] = []) {
  return {
    selectors: Object.fromEntries(SELECTOR_IDS.map((id) => [id, !missing.includes(id)])),
    tokens: Object.fromEntries(TOKEN_VALUES.map((token) => [token, "#000"])),
    modeSwitcher: true,
    modeSwitcherId: true,
    threadRowCount: 24,
    titlebarDragRegion: true,
    headerActionSlot: true,
    locale: "en-GB",
  }
}

function probe(
  id: string,
  ok: boolean,
  requiredFor: CapabilityProbe["requiredFor"],
): CapabilityProbe {
  return { id, ok, detail: id, requiredFor }
}

test("base failure enters safe mode", () => {
  const probes = [probe("renderer", false, "base"), probe("mode", true, "subtractive")]
  assert.equal(classifyCompatibility(probes), "safe-mode")
})

test("subtractive failure keeps additive mode", () => {
  const probes = [
    probe("renderer", true, "base"),
    probe("sidebar", true, "additive"),
    probe("mode", false, "subtractive"),
  ]
  assert.equal(classifyCompatibility(probes), "additive")
})

test("all capabilities enable Weft mode", () => {
  const probes = [
    probe("renderer", true, "base"),
    probe("sidebar", true, "additive"),
    probe("mode", true, "subtractive"),
  ]
  assert.equal(classifyCompatibility(probes), "weft-mode")
})

test("renderer probe requires an interactive visible main route", () => {
  const expression = buildProbeExpression()
  assert.match(expression, /visibleMainRoute\(\)/)
  assert.match(expression, /closest\('\[inert\], \[aria-hidden="true"\], \[hidden\]'\)/)
  assert.match(expression, /style\.visibility === "hidden"/)
  assert.match(expression, /style\.pointerEvents === "none"/)
  assert.match(expression, /id === "renderer\.main" \? Boolean\(mainRoute\)/)
})

test("a healthy renderer reaches Weft mode with no failure reasons", () => {
  const report = reportFromSnapshot(healthySnapshot())
  assert.equal(report.tier, "weft-mode")
  assert.ok(report.probes.every((entry) => entry.ok))
  assert.ok(report.probes.every((entry) => entry.reason === undefined))
})

// N0-01: these four used to be `optional`, so losing them changed nothing.
// Each now has to pull the tier down to `additive` (fail-open, not silent).
for (const id of [
  "sidebar.threadRoute",
  "sidebar.threadActive",
  "sidebar.threadRow",
  "sidebar.projectCreate",
] as const) {
  test(`losing ${id} degrades to additive instead of passing silently`, () => {
    const report = reportFromSnapshot(healthySnapshot([id]))
    assert.equal(report.tier, "additive")
    const failed = report.probes.find((entry) => entry.id === id)
    assert.equal(failed?.ok, false)
    assert.equal(failed?.requiredFor, "subtractive")
  })
}

// Regression: the thread anchors are data-dependent. A profile with no
// conversations renders a healthy sidebar that simply has no rows to carry
// them; treating that as a failure pinned every fresh profile to `additive`.
test("a profile with no conversations still reaches Weft mode", () => {
  const snapshot = healthySnapshot([
    "sidebar.threadRow",
    "sidebar.threadRoute",
    "sidebar.threadActive",
  ])
  snapshot.threadRowCount = 0

  const report = reportFromSnapshot(snapshot)
  assert.equal(report.tier, "weft-mode")
  for (const id of ["sidebar.threadRow", "sidebar.threadRoute", "sidebar.threadActive"]) {
    const entry = report.probes.find((probe) => probe.id === id)
    assert.equal(entry?.ok, true, `${id} must not fail when there is nothing to check`)
    assert.match(entry?.detail ?? "", /Not applicable/)
  }
})

test("once conversations exist a missing thread anchor still degrades", () => {
  const snapshot = healthySnapshot(["sidebar.threadActive"])
  snapshot.threadRowCount = 24
  const report = reportFromSnapshot(snapshot)
  assert.equal(report.tier, "additive")
  assert.equal(
    report.probes.find((probe) => probe.id === "sidebar.threadActive")?.ok,
    false,
  )
})

// N0-01: a trigger without an id used to report ok while ensureNativeCodexMode
// still forced safe mode — probe and behaviour disagreed.
test("a mode trigger without an id fails the probe instead of reporting ok", () => {
  const report = reportFromSnapshot({ ...healthySnapshot(), modeSwitcherId: false })
  assert.equal(report.tier, "additive")
  const entry = report.probes.find((probe) => probe.id === "mode.switcher")
  assert.equal(entry?.ok, false)
  assert.match(entry?.detail ?? "", /no id/)
  assert.ok(entry?.reason)
})

test("a missing mode trigger is reported distinctly from a trigger without an id", () => {
  const report = reportFromSnapshot({ ...healthySnapshot(), modeSwitcher: false, modeSwitcherId: false })
  const entry = report.probes.find((probe) => probe.id === "mode.switcher")
  assert.equal(entry?.ok, false)
  assert.match(entry?.detail ?? "", /Missing one semantic/)
})

test("failure reasons are user-facing and never leak a selector", () => {
  const report = reportFromSnapshot(healthySnapshot([...SELECTOR_IDS]))
  const failures = report.probes.filter((entry) => !entry.ok)
  assert.equal(failures.length, SELECTOR_IDS.length)
  for (const failure of failures) {
    assert.ok(failure.reason, `${failure.id} has no user-facing reason`)
    assert.doesNotMatch(failure.reason ?? "", /\[data-|#root|querySelector/)
  }
})

// N0-05 (#6): one fixture per requiredFor level, so every level's user-visible
// consequence is pinned. `base` and `additive` both mean safe-mode — a failed
// additive probe is NOT a lesser degradation, and that is easy to misread.
test("a base anchor failure enters safe mode", () => {
  const report = reportFromSnapshot(healthySnapshot(["sidebar.scroll"]))
  assert.equal(report.tier, "safe-mode")
})

test("an additive token failure also enters safe mode, not a lesser tier", () => {
  const snapshot = healthySnapshot()
  snapshot.tokens["--color-token-foreground"] = ""
  assert.equal(reportFromSnapshot(snapshot).tier, "safe-mode")
})

test("an optional probe failure changes nothing", () => {
  const snapshot = { ...healthySnapshot(), titlebarDragRegion: false }
  const report = reportFromSnapshot(snapshot)
  assert.equal(report.tier, "weft-mode")
  assert.equal(report.probes.find((entry) => entry.id === "titlebar.dragRegion")?.ok, false)
})

// N0-05 (#6): the compatibility matrix is the upgrade regression signal, so it
// has to stay mechanically in sync with the probes. Adding a probe without
// documenting it, or changing a classification without updating the matrix,
// must fail here rather than silently drift.
function matrixRows(): { build: number; anchor: string; requiredFor: string }[] {
  const here = dirname(fileURLToPath(import.meta.url))
  const matrix = readFileSync(join(here, "..", "..", "docs", "compat", "codex-builds.md"), "utf8")
  const rows: { build: number; anchor: string; requiredFor: string }[] = []
  for (const line of matrix.split("\n")) {
    const match = /^\|\s*(\d{4,})\s*\|\s*`([^`]+)`\s*\|\s*(base|additive|subtractive|optional)\s*\|/.exec(line)
    if (!match) continue
    const [, build, anchor, requiredFor] = match
    if (!build || !anchor || !requiredFor) continue
    rows.push({ build: Number(build), anchor, requiredFor })
  }
  return rows
}

test("the compatibility matrix documents every probe of the newest build", () => {
  const rows = matrixRows()
  assert.ok(rows.length > 0, "no anchor rows parsed from docs/compat/codex-builds.md")
  const newest = Math.max(...rows.map((row) => row.build))
  const documented = new Map(
    rows.filter((row) => row.build === newest).map((row) => [row.anchor, row.requiredFor]),
  )
  const probes = reportFromSnapshot(healthySnapshot()).probes

  const undocumented = probes.filter((probe) => !documented.has(probe.id)).map((probe) => probe.id)
  assert.deepEqual(undocumented, [], `probes missing from the matrix for build ${newest}`)

  const stale = [...documented.keys()].filter((id) => !probes.some((probe) => probe.id === id))
  assert.deepEqual(stale, [], `matrix rows for build ${newest} with no matching probe`)

  const mismatched = probes
    .filter((probe) => documented.get(probe.id) !== probe.requiredFor)
    .map((probe) => `${probe.id}: code=${probe.requiredFor} matrix=${documented.get(probe.id)}`)
  assert.deepEqual(mismatched, [], "requiredFor disagrees between code and matrix")
})
