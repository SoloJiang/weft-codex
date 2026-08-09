import assert from "node:assert/strict"
import test from "node:test"

import { buildRendererAgentSource } from "./renderer-agent.js"

test("renderer host agent exposes the lifecycle methods used by reconnect and CSP fallback", () => {
  const source = buildRendererAgentSource({
    webBaseUrl: "http://127.0.0.1:47810/",
    bridgeId: "test-bridge",
    bindingName: "weftCodexHost",
    initialMode: "weft",
    compatibilityTier: "weft-mode",
    cspBypass: false,
  })
  for (const method of [
    "status",
    "setMode",
    "setCspBypass",
    "reloadFrames",
    "deliverActionResult",
    "dispose",
  ]) {
    assert.match(source, new RegExp(`\\b${method}\\b`))
  }
})
