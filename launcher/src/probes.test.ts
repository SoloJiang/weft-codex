import assert from "node:assert/strict"
import test from "node:test"

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
    titlebarDragRegion: true,
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
