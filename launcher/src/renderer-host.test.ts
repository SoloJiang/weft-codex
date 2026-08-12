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
    sidebarMounted: false,
    workspaceMounted: false,
    modalMounted: false,
    sidebarReady: false,
    workspaceReady: false,
    modalReady: false,
    nativeModeSwitcher: false,
    ...partial,
  }
}

const MOUNTED = { sidebarMounted: true, workspaceMounted: true, modalMounted: true }
const READY = { ...MOUNTED, sidebarReady: true, workspaceReady: true, modalReady: true }

/** A poller that yields each scripted status in turn, then repeats the last. */
function scripted(steps: RendererAgentStatus[]): () => Promise<RendererAgentStatus | null> {
  let index = 0
  return async () => steps[Math.min(index++, steps.length - 1)] ?? null
}

// The roots can only attach after Codex renders its own shell. Sharing one
// budget with the handshake let a slow host shell consume the whole window and
// the run was then reported as a handshake failure.
test("host hydration does not spend the handshake budget", async () => {
  // Nothing mounts until the sixth poll — longer than the handshake budget.
  const steps = [...Array(6)].map(() => status()).concat([status(MOUNTED), status(READY)])
  const result = await waitForSurfaces(scripted(steps), { mountMs: 4000, handshakeMs: 200 })
  assert.equal(result?.sidebarReady, true)
})

test("a mounted but silent surface still gives up", async () => {
  const result = await waitForSurfaces(scripted([status(MOUNTED)]), { mountMs: 4000, handshakeMs: 200 })
  assert.equal(result?.sidebarReady, false)
  assert.equal(result?.sidebarMounted, true, "mounted state must survive so the caller can name the phase")
})

test("a host that never renders its shell gives up on the mount budget", async () => {
  const result = await waitForSurfaces(scripted([status()]), { mountMs: 200, handshakeMs: 200 })
  assert.equal(result?.sidebarMounted, false)
})

// A reload leaves no execution context for a moment; that must not be mistaken
// for a surface that went away.
test("a transient poll failure keeps the last status", async () => {
  let call = 0
  const result = await waitForSurfaces(async () => {
    call += 1
    if (call === 1) return status(MOUNTED)
    if (call < 4) throw new Error("no execution context")
    return status(READY)
  }, { mountMs: 1000, handshakeMs: 1000 })
  assert.equal(result?.sidebarReady, true)
})

test("surfaces already ready return without waiting out the mount budget", async () => {
  const started = Date.now()
  const result = await waitForSurfaces(scripted([status(READY)]), { mountMs: 5000, handshakeMs: 5000 })
  assert.equal(result?.sidebarReady, true)
  assert.ok(Date.now() - started < 500, "must not sleep once the surfaces are ready")
})

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
