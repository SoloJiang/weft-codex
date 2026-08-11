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

// The native search and activity buttons sit *inside* the mode row, not beside
// it, so the original markModeHeader loop — which only walked the header's other
// children — never reached them and both survived into Weft mode.
test("the native header actions inside the mode row are marked for hiding", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /function actionSlot\(button\)/)
  assert.match(source, /const slot = actionSlot\(button\);[\s\S]{0,400}weftCodexNativeHeaderAction = ""/)
  // Ours live in the same slot; marking them would hide what we just injected.
  assert.match(source, /if \(child\.hasAttribute\(HEADER_ACTION_ATTR\)\) continue/)
})

// The slot is located by shape because these buttons carry no data-app-action-*
// attribute and their only label is locale text (build 6321: "Search" /
// "View activity, needs attention" under an en-GB host).
test("the action slot is located structurally, never by locale text", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /siblings\.length === 1 \? siblings\[0\] : null/)
  assert.doesNotMatch(source, /aria-label[^\n]*[Ss]earch/)
  assert.doesNotMatch(source, /View activity/)
})

test("the injected Weft entries are gated on both tier and mode", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(
    source,
    /html:not\(\[data-weft-codex-tier="weft-mode"\]\) \[data-weft-codex-header-action\],\s*html:not\(\[data-weft-codex-mode="weft"\]\) \[data-weft-codex-header-action\]/,
  )
})

// Losing the slot must cost the placement, not the capability: the sidebar
// draws the same two entries in its own header when this says "fallback".
test("a missing action slot falls back instead of dropping the entries", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /headerActions: state\.headerActionsMounted \? "native" : "fallback"/)
  assert.match(source, /removeHeaderActions\(\);\s*state\.headerActionsMounted = false;/)
})

test("dispose removes the injected header entries", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /restoreModeButton\(\);\s*removeHeaderActions\(\);/)
})

// The badge is Weft's own count. Accepting it from the workspace frame would
// give the number two authors racing to set it.
test("the inbox count is only accepted from the sidebar frame", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /if \(frame !== state\.sidebarFrame\)[\s\S]{0,120}"inbox-count-not-from-sidebar"/)
  assert.match(source, /"invalid-inbox-count"/)
})

// The host states radii in rem and rem resolves against the *consuming*
// document's root font size — 16px in Codex, 13px in the Weft surfaces — so
// forwarding the raw string shrank every corner by 19%.
test("rem-bearing radius tokens are resolved to pixels before forwarding", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /function usedLength\(value, rootFontSize\)/)
  assert.match(source, /token\.startsWith\("--radius"\) \? usedLength\(value, rootFontSize\) : value/)
  // Percentages resolve against the box, so a zero-sized probe would say 0px.
  assert.match(source, /value\.includes\("%"\)\) return value/)
  // Context is published on every mutation and the probe forces layout.
  assert.match(source, /state\.usedLengths\.set\(key, used\)/)
  assert.match(source, /const key = rootFontSize \+ "\|" \+ value/)
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
