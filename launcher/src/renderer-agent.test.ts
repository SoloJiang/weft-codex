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
