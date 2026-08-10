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
