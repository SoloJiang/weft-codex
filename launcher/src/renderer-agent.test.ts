import assert from "node:assert/strict"
import test from "node:test"

import { buildRendererAgentSource, validateRendererAgentConfig } from "./renderer-agent.js"

const baseConfig = {
  webBaseUrl: "http://127.0.0.1:47810/",
  bridgeId: "bridge-123",
  bindingName: "weftCodexHost",
  initialMode: "weft" as const,
  compatibilityTier: "weft-mode" as const,
  cspBypass: false,
}

test("accepts a loopback renderer URL and normalizes it", () => {
  const config = validateRendererAgentConfig({ ...baseConfig, webBaseUrl: "http://localhost:47810" })
  assert.equal(config.webBaseUrl, "http://localhost:47810/")
})

test("rejects a non-loopback renderer URL", () => {
  assert.throws(
    () => validateRendererAgentConfig({ ...baseConfig, webBaseUrl: "https://example.com" }),
    /loopback HTTP/,
  )
})

test("rejects malformed bridge and binding identifiers", () => {
  assert.throws(() => validateRendererAgentConfig({ ...baseConfig, bridgeId: "bad bridge" }), /bridge id/)
  assert.throws(() => validateRendererAgentConfig({ ...baseConfig, bindingName: "bad-name" }), /binding name/)
})

test("builds an idempotent document-start script without raw tag injection", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /__weftCodexAgentV1/)
  assert.match(source, /weft:host-context/)
  assert.match(source, /view: state\.view/)
  assert.match(source, /const mainRoute = visibleMainRoute\(\)/)
  assert.match(source, /closest\('\[inert\], \[aria-hidden="true"\], \[hidden\]'\)/)
  assert.match(source, /"inert", "aria-hidden", "hidden"/)
  assert.match(source, /THREAD_OPEN_RETRY_DELAYS = \[0, 80, 160, 320, 640, 1000, 1800\]/)
  assert.match(source, /async function openNativeThread\(threadId\)/)
  assert.match(source, /actionResult\(frame, message\.requestId, opened/)
  assert.doesNotMatch(source, /const mainRoute = document\.querySelector\("main"\)/)
  assert.doesNotMatch(source, /<\/script>/i)
})

// N0-04 (#5): spec §7.5 requires a failed subtractive probe to fail open to
// Tier 1. Before this, `compatibilityTier` was only ever reported, so Weft mode
// hid the native sidebar at every tier.
const SUBTRACTIVE_RULES = [
  /\[data-weft-codex-tier="weft-mode"\]\[data-weft-codex-mode="weft"\] \[data-app-action-sidebar-scroll\] > :not\(#weft-codex-sidebar-root\)/,
  /\[data-weft-codex-tier="weft-mode"\]\[data-weft-codex-mode="weft"\] \[data-app-action-sidebar-scroll\] \{/,
  /\[data-weft-codex-tier="weft-mode"\]\[data-weft-codex-mode="weft"\] \[data-weft-codex-native-header-action\]/,
]

test("the agent publishes its compatibility tier on the document", () => {
  for (const tier of ["weft-mode", "additive"] as const) {
    const source = buildRendererAgentSource({ ...baseConfig, compatibilityTier: tier })
    assert.match(source, /weftCodexTier: config\.compatibilityTier/)
    assert.match(source, new RegExp(`"compatibilityTier":"${tier}"`))
  }
})

test("every subtractive rule is gated on the weft-mode tier", () => {
  const source = buildRendererAgentSource(baseConfig)
  for (const rule of SUBTRACTIVE_RULES) assert.match(source, rule)
  // No rule may hide native chrome on mode alone — that is the fail-open bug.
  assert.doesNotMatch(source, /html\[data-weft-codex-mode="weft"\] \[data-app-action-sidebar-scroll\] > :not\(/)
  assert.doesNotMatch(source, /html\[data-weft-codex-mode="weft"\] \[data-weft-codex-native-header-action\]/)
})

test("the additive tier appends a workspace entry instead of taking the sidebar", () => {
  const source = buildRendererAgentSource({ ...baseConfig, compatibilityTier: "additive" })
  assert.match(source, /\[data-weft-codex-tier="additive"\]\[data-weft-codex-mode="weft"\] #weft-codex-sidebar-root/)
  assert.match(source, /\[data-weft-codex-tier="additive"\]\[data-weft-codex-mode="weft"\] \.weft-codex-fallback-button/)
  // The workspace overlay stays reachable in Tier 1 — it is not tier-scoped.
  assert.match(source, /html\[data-weft-codex-mode="weft"\]\[data-weft-codex-view="workspace"\] #weft-codex-workspace-root/)
})

test("disposing clears the tier attribute it set", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /delete root\.dataset\.weftCodexTier/)
})

// N0-05 (#6): exit must restore the host. Rather than spot-checking known
// attributes, derive both sets from the source — every document attribute the
// agent writes has to be deleted on dispose. A new attribute without matching
// cleanup fails here automatically.
test("every document attribute the agent sets is removed on dispose", () => {
  const source = buildRendererAgentSource(baseConfig)
  const valuesBlock = /const values = \{([\s\S]*?)\};/.exec(source)
  assert.ok(valuesBlock, "could not locate the setDocumentState values block")
  const written = new Set(
    [...(valuesBlock[1] ?? "").matchAll(/^\s*(weftCodex[A-Za-z]+):/gm)].map((m) => m[1]),
  )
  const deleted = new Set(
    [...source.matchAll(/delete root\.dataset\.(weftCodex[A-Za-z]+)/g)].map((m) => m[1]),
  )
  assert.ok(written.size >= 4, `expected several document attributes, saw ${written.size}`)
  const leaked = [...written].filter((name) => !deleted.has(name))
  assert.deepEqual(leaked, [], "document attributes written but never deleted on dispose")
})

test("dispose also removes the injected roots and stylesheet", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /if \(state\.sidebarRoot\) state\.sidebarRoot\.remove\(\)/)
  assert.match(source, /if \(state\.workspaceRoot\) state\.workspaceRoot\.remove\(\)/)
  assert.match(source, /if \(state\.modalRoot\) state\.modalRoot\.remove\(\)/)
  assert.match(source, /getElementById\(STYLE_ID\)[\s\S]{0,60}style\.remove\(\)/)
})

// N0-05 (#6): re-attaching must not leave two mounted agents behind.
test("installing twice disposes the previous agent first", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(
    source,
    /const previous = window\[GLOBAL_KEY\];[\s\S]{0,160}previous\.dispose\(\)/,
  )
})

test("dialog actions use a dedicated host-level modal surface", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /message\.action === "dialog\.present"/)
  assert.match(source, /message\.action === "dialog\.mounted"/)
  assert.match(source, /message\.action === "dialog\.dismiss"/)
  assert.match(source, /root\.id = MODAL_ROOT_ID/)
  assert.match(source, /createFrame\("modal"\)/)
  assert.match(source, /#weft-codex-modal-root \{[\s\S]*?position: fixed;[\s\S]*?inset: 0;/)
  assert.match(source, /#weft-codex-modal-root\[data-open="true"\]/)
  assert.match(source, /#weft-codex-modal-root > iframe/)
  assert.match(source, /background: transparent !important/)
  assert.match(source, /frame === state\.modalFrame && mountDialog\(\)/)
  assert.match(source, /if \(frame === state\.modalFrame\) postDialogState\(\)/)
})

test("dialog presentation never reparents or restyles the workspace surface", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.doesNotMatch(source, /data-weft-codex-dialog/)
  assert.doesNotMatch(source, /function setDialogOpen/)
  assert.doesNotMatch(source, /weft-codex-dialog-main-fill/)
  assert.doesNotMatch(
    source,
    /#weft-codex-workspace-root\s*\{[^}]*position:\s*fixed/s,
  )
})
