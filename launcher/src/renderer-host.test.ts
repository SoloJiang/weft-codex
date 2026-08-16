import assert from "node:assert/strict"
import test from "node:test"

import { buildRendererAgentSource } from "./renderer-agent.js"
import { waitForSurfaces, type RendererAgentStatus } from "./renderer-host.js"

function status(partial: Partial<RendererAgentStatus> = {}): RendererAgentStatus {
  return {
    version: 1,
    mode: "weft",
    view: "workspace",
    tier: "weft-mode",
    cspBypass: false,
    uiMounted: false,
    uiReady: false,
    nativeModeSwitcher: false,
    ...partial,
  }
}

const MOUNTED = { uiMounted: true }
const READY = { uiMounted: true, uiReady: true }

function scripted(steps: RendererAgentStatus[]): () => Promise<RendererAgentStatus | null> {
  let index = 0
  return async () => steps[Math.min(index++, steps.length - 1)] ?? null
}

test("host hydration does not spend the handshake budget", async () => {
  const steps = [...Array(6)].map(() => status()).concat([status(MOUNTED), status(READY)])
  const result = await waitForSurfaces(scripted(steps), { mountMs: 4000, handshakeMs: 200 })
  assert.equal(result?.uiReady, true)
})

test("a mounted but silent surface still gives up", async () => {
  const result = await waitForSurfaces(scripted([status(MOUNTED)]), { mountMs: 4000, handshakeMs: 200 })
  assert.equal(result?.uiReady, false)
  assert.equal(result?.uiMounted, true, "mounted state must survive so the caller can name the phase")
})

test("a host that never renders its shell gives up on the mount budget", async () => {
  const result = await waitForSurfaces(scripted([status()]), { mountMs: 200, handshakeMs: 200 })
  assert.equal(result?.uiMounted, false)
})

test("a transient poll failure keeps the last status", async () => {
  let call = 0
  const result = await waitForSurfaces(async () => {
    call += 1
    if (call === 1) return status(MOUNTED)
    if (call < 4) throw new Error("no execution context")
    return status(READY)
  }, { mountMs: 1000, handshakeMs: 1000 })
  assert.equal(result?.uiReady, true)
})

test("surfaces already ready return without waiting out the mount budget", async () => {
  const started = Date.now()
  const result = await waitForSurfaces(scripted([status(READY)]), { mountMs: 5000, handshakeMs: 5000 })
  assert.equal(result?.uiReady, true)
  assert.ok(Date.now() - started < 500, "must not sleep once the surfaces are ready")
})

test("renderer host agent exposes the lifecycle methods used by reconnect and CSP fallback", () => {
  const source = buildRendererAgentSource({
    webBaseUrl: "http://127.0.0.1:47810/",
    bindingName: "weftCodexHost",
    initialMode: "weft",
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
