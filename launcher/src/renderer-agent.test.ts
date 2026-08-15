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
  /\[data-weft-codex-tier="weft-mode"\]\[data-weft-codex-mode="weft"\] \[data-app-action-sidebar-scroll\] \{/,
  /\[data-weft-codex-tier="weft-mode"\]\[data-weft-codex-mode="weft"\] \[data-weft-codex-native-utility\]/,
  /\[data-weft-codex-tier="weft-mode"\]\[data-weft-codex-mode="weft"\] \[data-weft-codex-native-thread\]/,
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

test("modal visibility sync does not retrigger the host mutation observer", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(
    source,
    /if \(root\.getAttribute\("aria-hidden"\) !== hiddenValue\) \{\s*root\.setAttribute\("aria-hidden", hiddenValue\)/,
  )
  assert.doesNotMatch(source, /root\.setAttribute\("aria-hidden", open \? "false" : "true"\)/)
})

test("an open modal isolates and later restores its host-document background", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /modalBackground: new Map\(\)/)
  assert.match(source, /if \(open\) isolateModalBackground\(root\)/)
  assert.match(source, /if \(!sibling\.inert\) sibling\.inert = true/)
  assert.match(source, /sibling\.setAttribute\("aria-hidden", "true"\)/)
  assert.match(source, /function restoreModalBackground\(\)/)
  assert.match(source, /element\.inert = previous\.inert/)
  assert.match(source, /element\.removeAttribute\("aria-hidden"\)/)
  assert.match(source, /restoreModalBackground\(\);\s*if \(state\.sidebarRoot\)/)
})

test("surface iframe labels come from the localized UI", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /message\.action === "surface\.label"/)
  assert.match(source, /frame\.title = label/)
  assert.doesNotMatch(source, /frame\.title = "Dialog"/)
  assert.doesNotMatch(source, /frame\.title = "Workspace navigation"/)
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

test("conversation popover is a dedicated host-level surface with one state", () => {
  const source = buildRendererAgentSource(baseConfig)
  // The panel and its title-bar button are separate host-owned anchors.
  assert.match(source, /root\.id = POPOVER_ROOT_ID/)
  assert.match(source, /function onWeftChatsClick\(event\)/)
  assert.match(source, /createFrame\("popover"\)/)
  // One discriminated visibility value — never a pile of booleans (spec §3).
  assert.match(source, /popoverState: "closed"/)
  assert.match(source, /function setPopoverState\(next\)/)
  assert.match(source, /next !== "closed" && next !== "open-auto" && next !== "open-pinned"/)
  // The panel occupies the native right-panel slot, same architecture as Diff.
  assert.match(source, /state\.mode === "weft" && state\.view === "thread"/)
  assert.match(source, /data-app-shell-focus-area="right-panel"/)
  assert.match(source, /function syncNativeSidePanelForConversation\(\)/)
})

test("conversation popover opens by default when a sidebar issue opens its lead", () => {
  const source = buildRendererAgentSource(baseConfig)
  // Arriving from the sidebar issue list is the only auto-open context (§2.4).
  assert.match(source, /if \(opened && frame === state\.sidebarFrame && conversationAllowed\(\)\) setPopoverState\("open-auto"\)/)
  // Picking a conversation inside the panel closes it (§3).
  assert.match(source, /if \(opened && frame === state\.popoverFrame\) dismissPopover\(\)/)
  // Leaving the thread view always closes the panel.
  assert.match(source, /if \(nextView !== "thread"\) dismissPopover\(\)/)
  // The UI can close the panel through its own host action.
  assert.match(source, /message\.action === "popover\.dismiss"/)
})

test("conversation popover joins the context and teardown lifecycle", () => {
  const source = buildRendererAgentSource(baseConfig)
  // The frame receives host context like every other surface.
  assert.match(source, /postContext\(state\.popoverFrame\)/)
  assert.match(source, /source === state\.popoverFrame\.contentWindow/)
  // Reload and dispose cover the panel and button roots.
  assert.match(source, /state\.popoverFrame\.src = surfaceUrl\("popover"\)/)
  assert.match(source, /if \(state\.popoverRoot\) state\.popoverRoot\.remove\(\)/)
  assert.match(source, /data-weft-codex-chats-bound/)
  // Status reports mount and handshake state for readiness probes.
  assert.match(source, /popoverMounted: Boolean\(state\.popoverRoot/)
  assert.match(source, /popoverReady: state\.readyFrames\.has\("popover"\)/)
})

test("host slot layout owns workspace geometry and a dedicated inspector surface", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /function syncSlotGeometry\(\)/)
  assert.match(source, /function openInspector\(issueId\)/)
  assert.match(source, /function closeInspector\(options\)/)
  assert.match(source, /createFrame\("inspector"\)/)
  assert.match(source, /root\.id = INSPECTOR_ROOT_ID/)
  assert.match(source, /const parent = nativeRightPanelHost\(\)/)
  assert.match(source, /message\.action === "inspector\.open"/)
  assert.match(source, /message\.action === "inspector\.close"/)
  assert.match(source, /weftCodexInspector: state\.inspectorIssueId/)
  assert.doesNotMatch(
    source,
    /#weft-codex-workspace-root\s*\{[\s\S]*?inset-inline:\s*0;[\s\S]*?bottom:\s*0;/s,
  )
  assert.match(source, /data-weft-codex-hide-side-panel/)
  assert.match(source, /postContext\(state\.inspectorFrame\)/)
  assert.match(source, /if \(state\.inspectorRoot\) state\.inspectorRoot\.remove\(\)/)
  assert.match(source, /inspectorMounted: Boolean\(state\.inspectorRoot/)
})

test("opening the inspector closes the conversation layer", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /function conversationAllowed\(\)/)
  assert.match(source, /return conversationAllowed\(\)/)
  assert.match(source, /dismissPopover\(\);/)
  assert.match(source, /state\.lastInspectorIssueId = issueId/)
  assert.match(source, /syncNativeSidePanelForConversation\(\);/)
  assert.match(source, /ensureInspectorRoot\(\);/)
  assert.match(source, /const parent = nativeRightPanelHost\(\);/)
})

test("native side panel yields the inspector slot", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /function onNativeSidePanelClick\(\)/)
  assert.match(source, /function suppressNativeDiffChrome\(\)/)
  assert.match(source, /function weftRightPanelOccupied\(\)/)
  assert.match(source, /weftInspectorOpen\(\) \|\| \(state\.view === "thread" && state\.popoverState !== "closed"\)/)
  assert.match(source, /data-app-shell-focus-area="right-panel"/)
  assert.match(source, /closeInspector\(\{ keepNative: true \}\)/)
})

test("weft mode extends the native sidebar instead of replacing it", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /message\.action === "sidebar\.sync"/)
  assert.match(source, /function syncNativeSidebar\(\)/)
  assert.match(source, /function postSidebarCommand\(payload\)/)
  assert.match(source, /command: "workspace.select"/)
  assert.match(source, /type: "weft:sidebar-command"/)
  assert.match(source, /width: 0;/)
  assert.match(source, /pointer-events: none;/)
  assert.doesNotMatch(
    source,
    /\[data-app-action-sidebar-scroll\] > :not\(#weft-codex-sidebar-root\)/,
  )
  assert.doesNotMatch(
    source,
    /html\[data-weft-codex-tier="weft-mode"\]\[data-weft-codex-mode="weft"\] \[data-weft-codex-native-header-action\]/,
  )
})

test("workspace stage hides leftover native thread title", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /data-weft-codex-hide-thread-title/)
  assert.match(source, /app-shell-header-context-menu-surface/)
  assert.match(
    source,
    /html\[data-weft-codex-tier="weft-mode"\]\[data-weft-codex-mode="weft"\]\[data-weft-codex-view="workspace"\] \[data-weft-codex-hide-thread-title\]/,
  )
})

test("conversation entry lives in the native titlebar action cluster", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /function nativeTitlebarButton\(label\)/)
  assert.match(source, /function nativeRightHeaderSlot\(\)/)
  assert.match(source, /data-test-id="header-shell-slot"/)
  assert.match(source, /function onWeftChatsClick\(event\)/)
  assert.match(source, /dataset.weftCodexChatsBound/)
  assert.doesNotMatch(source, /mode switcher 旁/)
  assert.doesNotMatch(source, /border-radius: 999px/)
  assert.doesNotMatch(source, /weft-codex-popover-button/)
  assert.match(source, /position: absolute;\s*inset: 0 0 0 8px;/s)
})

test("weft right-panel content leaves the native Diff splitter hittable", () => {
  const source = buildRendererAgentSource(baseConfig)
  assert.match(source, /inset: 0 0 0 8px/)
  assert.match(source, /observeRightPanelResize/)
  assert.match(source, /function applyWeftRightPanelWidth/)
  assert.match(source, /function bindNativeRightPanelResize/)
  assert.match(source, /\[data-app-shell-focus-area="right-panel"\] > \[role="separator"\]/)
})
