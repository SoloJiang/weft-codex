import { ALLOWED_CODEX_TOKENS, VISIBLE_MAIN_HELPERS_SOURCE } from "./probes.js"

export type HostMode = "work" | "codex" | "weft"

const SIDEBAR_ROOT_ID = "weft-codex-sidebar-root"
const WORKSPACE_ROOT_ID = "weft-codex-workspace-root"
const MODAL_ROOT_ID = "weft-codex-modal-root"
const POPOVER_ROOT_ID = "weft-codex-popover-root"
const INSPECTOR_ROOT_ID = "weft-codex-inspector-root"
const NATIVE_CHECK_ATTR = "data-weft-codex-native-mode-check"
const HEADER_ACTION_ATTR = "data-weft-codex-header-action"
const HEADER_BADGE_ATTR = "data-weft-codex-header-badge"

export interface RendererAgentConfig {
  webBaseUrl: string
  bridgeId: string
  bindingName: string
  initialMode: HostMode
  compatibilityTier: "additive" | "weft-mode"
  cspBypass: boolean
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
}

export function validateRendererAgentConfig(config: RendererAgentConfig): RendererAgentConfig {
  const webUrl = new URL(config.webBaseUrl)
  if (webUrl.protocol !== "http:" || !isLoopback(webUrl.hostname)) {
    throw new Error("Renderer web URL must use loopback HTTP")
  }
  if (webUrl.username || webUrl.password) throw new Error("Renderer web URL cannot contain credentials")
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(config.bridgeId)) {
    throw new Error("Renderer bridge id is invalid")
  }
  if (!/^[a-zA-Z_$][a-zA-Z0-9_$]{0,63}$/.test(config.bindingName)) {
    throw new Error("Renderer binding name is invalid")
  }
  return {
    ...config,
    webBaseUrl: webUrl.href,
  }
}

function serializeForScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")
}

/**
 * Build the document-start renderer agent. The script intentionally has no
 * imports and no dependency on Codex's React tree. It only uses semantic DOM
 * anchors verified by the capability probe.
 */
export function buildRendererAgentSource(input: RendererAgentConfig): string {
  const config = validateRendererAgentConfig(input)
  const serializedConfig = serializeForScript(config)
  const serializedTokens = serializeForScript(ALLOWED_CODEX_TOKENS)

  return `;(() => {
    "use strict";

    const GLOBAL_KEY = "__weftCodexAgentV1";
    const config = ${serializedConfig};
    const allowedTokens = ${serializedTokens};
    const SIDEBAR_ROOT_ID = "weft-codex-sidebar-root";
    const WORKSPACE_ROOT_ID = "weft-codex-workspace-root";
    const MODAL_ROOT_ID = "weft-codex-modal-root";
    const POPOVER_ROOT_ID = "weft-codex-popover-root";
    const INSPECTOR_ROOT_ID = "weft-codex-inspector-root";
    const STYLE_ID = "weft-codex-host-style";
    const MODE_ITEM_ATTR = "data-weft-codex-mode-item";
    const NATIVE_CHECK_ATTR = "data-weft-codex-native-mode-check";
    const HEADER_ACTION_ATTR = "data-weft-codex-header-action";
    const HEADER_BADGE_ATTR = "data-weft-codex-header-badge";
    const THREAD_OPEN_RETRY_DELAYS = [0, 80, 160, 320, 640, 1000, 1800];
    const childOrigin = new URL(config.webBaseUrl).origin;
    const previous = window[GLOBAL_KEY];
    if (previous && typeof previous.dispose === "function") previous.dispose();

    const state = {
      mode: config.initialMode,
      nativeMode: "codex",
      view: "workspace",
      cspBypass: Boolean(config.cspBypass),
      sidebarRoot: null,
      workspaceRoot: null,
      sidebarFrame: null,
      workspaceFrame: null,
      modalRoot: null,
      modalFrame: null,
      dialogState: null,
      modalVisible: false,
      modalBackground: new Map(),
      popoverRoot: null,
      popoverFrame: null,
      popoverButton: null,
      popoverState: "closed",
      pendingThreadTitle: "",
      focusIssueId: null,
      sidePanelProgrammatic: false,
      inspectorRoot: null,
      inspectorFrame: null,
      inspectorIssueId: null,
      lastInspectorIssueId: null,
      lastRightPanelWidth: 0,
      nativeAdapter: null,
      sidebarModel: null,
      modeButton: null,
      savedModeButton: null,
      headerActionsMounted: false,
      inboxCount: 0,
      usedLengths: new Map(),
      mutationObserver: null,
      resizeObserver: null,
      mediaQuery: null,
      readyFrames: new Set(),
      pendingActions: new Map(),
      mountTimer: 0,
      contextTimer: 0,
      disposed: false,
      started: false,
      messageListener: null,
      clickListener: null,
      mediaListener: null,
    };

    function notifyHost(type, payload = {}) {
      const binding = window[config.bindingName];
      if (typeof binding !== "function") return;
      try {
        binding(JSON.stringify({ version: 1, type, ...payload }));
      } catch {
        // The launcher may be reconnecting. DOM integration remains usable.
      }
    }

    function modeButton() {
      const sidebar = document.querySelector("[data-app-action-sidebar-scroll]");
      const navigation = sidebar && sidebar.closest("nav");
      if (!navigation) return null;
      const candidates = [...navigation.querySelectorAll('button[aria-haspopup="menu"][aria-expanded][data-state]')]
        .filter((button) => !sidebar.contains(button));
      return candidates.length === 1 ? candidates[0] : null;
    }

    function modeLabelNode(button) {
      if (!(button instanceof HTMLElement)) return null;
      return button.querySelector("span");
    }

    function inferNativeMode(button) {
      if (!(button instanceof HTMLElement)) return "work";
      const saved = state.savedModeButton;
      const label = saved && saved.button === button
        ? saved.text
        : (button.textContent || button.getAttribute("aria-label") || "");
      return /codex/i.test(label) ? "codex" : "work";
    }

    function saveModeButton(button) {
      if (!(button instanceof HTMLElement)) return;
      if (state.savedModeButton && state.savedModeButton.button === button) return;
      const label = modeLabelNode(button);
      state.savedModeButton = {
        button,
        label,
        text: label ? label.textContent || "" : "",
        ariaLabel: button.getAttribute("aria-label"),
      };
      state.nativeMode = inferNativeMode(button);
    }

    function restoreModeButton() {
      const saved = state.savedModeButton;
      if (!saved) return;
      if (saved.button.isConnected) {
        if (saved.label && saved.label.isConnected) saved.label.textContent = saved.text;
        if (saved.ariaLabel === null) saved.button.removeAttribute("aria-label");
        else saved.button.setAttribute("aria-label", saved.ariaLabel);
      }
      state.savedModeButton = null;
    }

    function applyNativeModeButtonLabel(labelText) {
      const button = state.modeButton;
      if (!(button instanceof HTMLElement) || !labelText) return;
      const label = modeLabelNode(button);
      const previousText = label ? label.textContent || "" : "";
      if (label) label.textContent = labelText;
      const aria = button.getAttribute("aria-label");
      if (aria && previousText && aria.includes(previousText)) {
        button.setAttribute("aria-label", aria.replace(previousText, labelText));
      }
    }

    function applyWeftModeButton(button) {
      if (!(button instanceof HTMLElement)) return;
      saveModeButton(button);
      const label = modeLabelNode(button);
      if (label && label.textContent !== "Weft") label.textContent = "Weft";
      const locale = document.documentElement.lang || navigator.language || "en";
      const aria = locale.toLowerCase().startsWith("zh")
        ? "切换模式，当前模式：Weft"
        : "Switch mode, current mode: Weft";
      if (button.getAttribute("aria-label") !== aria) button.setAttribute("aria-label", aria);
    }

    /**
     * The container the native header actions (search, activity) live in.
     *
     * Located structurally, on purpose. Those buttons carry no
     * data-app-action-* attribute of their own, and their only distinguishing
     * mark is aria-label — which is locale text, so anchoring on it would break
     * on any host language but the one we happened to probe. What is stable is
     * the shape: the mode row holds the switcher plus exactly one sibling
     * container, and that container carries the ms-auto alignment that keeps
     * these controls flush right. Requiring exactly one sibling fails closed if
     * that shape ever changes.
     */
    function actionSlot(button) {
      if (!(button instanceof HTMLElement)) return null;
      const modeRow = button.parentElement;
      if (!(modeRow instanceof HTMLElement)) return null;
      const siblings = [...modeRow.children]
        .filter((child) => child instanceof HTMLElement && child !== button);
      return siblings.length === 1 ? siblings[0] : null;
    }

    function markModeHeader(button) {
      if (!(button instanceof HTMLElement)) return;
      const modeRow = button.parentElement;
      const header = modeRow && modeRow.parentElement;
      if (!(modeRow instanceof HTMLElement) || !(header instanceof HTMLElement)) return;
      modeRow.dataset.weftCodexModeHeader = "";
      for (const child of header.children) {
        if (!(child instanceof HTMLElement) || child === modeRow) continue;
        if (/new chat/i.test(child.textContent || "")) continue;
        child.dataset.weftCodexNativeHeaderAction = "";
      }
      // The action slot lives *inside* the mode row, so the loop above never
      // reaches it. Mark its children rather than the slot itself: the slot
      // carries the alignment our own entries inherit by sitting in it.
      const slot = actionSlot(button);
      if (!(slot instanceof HTMLElement)) return;
      for (const child of slot.children) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.hasAttribute(HEADER_ACTION_ATTR)) continue;
        child.dataset.weftCodexNativeHeaderAction = "";
      }
    }

    function localeIsChinese() {
      const locale = document.documentElement.lang || navigator.language || "en";
      return locale.toLowerCase().startsWith("zh");
    }

    /**
     * Weft's two header entries, in the slot the native ones vacated.
     *
     * They are triggers and a number, nothing more: the panels render inside
     * the sidebar iframe where React, i18n and the design tokens already live.
     * Spec §7.6 keeps the renderer a thin surface agent, so it must not grow a
     * second place that knows how to draw a list of Weft data.
     */
    const HEADER_ACTIONS = [
      {
        key: "search",
        command: "search.open",
        path: "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM21 21l-4.35-4.35",
        label: { zh: "搜索 workspace", en: "Search workspace" },
      },
      {
        key: "inbox",
        command: "inbox.open",
        path: "M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z",
        label: { zh: "收件箱", en: "Inbox" },
      },
    ];

    function headerActionIcon(path) {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "17");
      svg.setAttribute("height", "17");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      svg.setAttribute("stroke-linecap", "round");
      svg.setAttribute("stroke-linejoin", "round");
      svg.setAttribute("aria-hidden", "true");
      svg.classList.add("icon-xs", "shrink-0");
      const node = document.createElementNS("http://www.w3.org/2000/svg", "path");
      node.setAttribute("d", path);
      svg.append(node);
      return svg;
    }

    /**
     * Clone a native control so ours inherit the host's sizing, hover, focus
     * ring and theme without us restating any of it — the same trick
     * createWeftMenuItem uses for the mode menu. The native actions are hidden,
     * not removed, so they stay available as templates; the mode switcher is
     * the fallback because it carries the identical class string.
     */
    function headerActionTemplate(slot, button) {
      const native = [...slot.querySelectorAll("button")]
        .find((candidate) => !candidate.hasAttribute(HEADER_ACTION_ATTR));
      if (native instanceof HTMLElement) return native;
      return button instanceof HTMLElement ? button : null;
    }

    function inboxLabel(base, count) {
      if (count <= 0) return base;
      if (localeIsChinese()) return base + "，" + count + " 项待处理";
      return base + ", " + count + " needing attention";
    }

    function applyInboxBadge() {
      const button = document.querySelector('[' + HEADER_ACTION_ATTR + '="inbox"]');
      if (!(button instanceof HTMLElement)) return;
      const action = HEADER_ACTIONS.find((candidate) => candidate.key === "inbox");
      const base = localeIsChinese() ? action.label.zh : action.label.en;
      button.setAttribute("aria-label", inboxLabel(base, state.inboxCount));
      let badge = button.querySelector("[" + HEADER_BADGE_ATTR + "]");
      if (state.inboxCount <= 0) {
        if (badge) badge.remove();
        return;
      }
      if (!(badge instanceof HTMLElement)) {
        badge = document.createElement("span");
        badge.setAttribute(HEADER_BADGE_ATTR, "");
        badge.setAttribute("aria-hidden", "true");
        button.append(badge);
      }
      const text = state.inboxCount > 99 ? "99+" : String(state.inboxCount);
      if (badge.textContent !== text) badge.textContent = text;
    }

    function createHeaderAction(template, action) {
      const clone = template.cloneNode(true);
      if (!(clone instanceof HTMLElement)) return null;
      clone.setAttribute(HEADER_ACTION_ATTR, action.key);
      clone.removeAttribute("data-weft-codex-native-header-action");
      clone.removeAttribute("aria-haspopup");
      clone.removeAttribute("aria-expanded");
      clone.removeAttribute("data-state");
      clone.removeAttribute("id");
      for (const identified of clone.querySelectorAll("[id]")) identified.removeAttribute("id");
      for (const svg of clone.querySelectorAll("svg")) svg.remove();
      for (const text of [...clone.childNodes]) {
        if (text.nodeType === Node.TEXT_NODE) text.remove();
      }
      for (const span of [...clone.querySelectorAll("span")]) {
        if (!span.hasAttribute(HEADER_BADGE_ATTR)) span.remove();
      }
      clone.setAttribute("type", "button");
      clone.setAttribute("aria-label", localeIsChinese() ? action.label.zh : action.label.en);
      clone.append(headerActionIcon(action.path));
      clone.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        postSurfaceCommand(action.command);
      });
      return clone;
    }

    /**
     * Idempotent: React re-renders the header, so this runs on every mount pass
     * and must converge rather than accumulate.
     */
    function ensureHeaderActions(button) {
      const slot = actionSlot(button);
      if (!(slot instanceof HTMLElement)) {
        removeHeaderActions();
        state.headerActionsMounted = false;
        return;
      }
      const template = headerActionTemplate(slot, button);
      if (!(template instanceof HTMLElement)) {
        removeHeaderActions();
        state.headerActionsMounted = false;
        return;
      }
      for (const action of HEADER_ACTIONS) {
        const selector = '[' + HEADER_ACTION_ATTR + '="' + action.key + '"]';
        const existing = slot.querySelector(":scope > " + selector);
        if (existing instanceof HTMLElement) continue;
        // A stale copy can survive a re-render that moved the slot; drop it
        // before appending so the pair never doubles up.
        for (const orphan of document.querySelectorAll(selector)) orphan.remove();
        const created = createHeaderAction(template, action);
        if (created) slot.append(created);
      }
      state.headerActionsMounted = true;
      applyInboxBadge();
    }

    function removeHeaderActions() {
      for (const node of document.querySelectorAll("[" + HEADER_ACTION_ATTR + "]")) node.remove();
    }

    function setInboxCount(value) {
      const count = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
      if (state.inboxCount === count) return;
      state.inboxCount = count;
      applyInboxBadge();
    }

    function setDocumentState() {
      const root = document.documentElement;
      const values = {
        weftCodexMode: state.mode,
        weftCodexView: state.view,
        weftCodexInspector: state.inspectorIssueId ? String(state.inspectorIssueId) : "closed",
        weftCodexRight: weftRightPanelOccupied() ? "weft" : "native",
        // Spec §7.5 splits mounting into Tier 1 (additive, native UI untouched)
        // and Tier 2 (weft-mode, subtractive). Publishing the tier here is what
        // lets the stylesheet fail open: every subtractive rule is scoped to
        // tier="weft-mode", so a failed subtractive probe cannot hide native UI.
        weftCodexTier: config.compatibilityTier,
        weftCodexModeCapability: state.modeButton ? "native" : "fallback",
        // Deliberately not part of the tier. Losing the action slot must only
        // move where the two Weft entries render — the sidebar draws its own
        // pair instead — never cost the whole Weft sidebar (compat §5.8).
        weftCodexHeaderActions: state.headerActionsMounted ? "native" : "fallback",
        weftCodexCspBypass: state.cspBypass ? "true" : "false",
      };
      for (const [key, value] of Object.entries(values)) {
        if (root.dataset[key] !== value) root.dataset[key] = value;
      }
    }

    function setMode(nextMode, persist = true) {
      if (nextMode !== "work" && nextMode !== "codex" && nextMode !== "weft") return;
      const changed = state.mode !== nextMode;
      if (nextMode === "weft") {
        state.view = "workspace";
        state.mode = "weft";
        if (state.modeButton) applyWeftModeButton(state.modeButton);
        syncPopoverRoot();
        syncPopoverButton();
        syncInspectorRoot();
        syncNativeChrome();
      } else {
        dismissDialog();
        dismissPopover();
        closeInspector();
        state.mode = nextMode;
        state.nativeMode = nextMode;
        state.view = "workspace";
        restoreModeButton();
        restoreNativeSidebar();
      }
      setDocumentState();
      syncModeMenus();
      syncSlotGeometry();
      publishContextSoon();
      if (changed && persist) notifyHost("mode.changed", { mode: nextMode });
    }

    function setView(nextView) {
      if (nextView !== "workspace" && nextView !== "thread") return;
      if (state.view === nextView) return;
      state.view = nextView;
      if (nextView !== "thread") dismissPopover();
      else {
        ensurePopoverRoot();
        ensurePopoverButton();
      }
      /* Leaving the thread view must hide Weft chats immediately, not on the
         next MutationObserver pass. */
      syncPopoverRoot();
      syncPopoverButton();
      syncNativeChrome();
      syncSlotGeometry();
      setDocumentState();
      publishContextSoon();
    }

    function surfaceUrl(surface) {
      const url = new URL(config.webBaseUrl);
      url.searchParams.set("surface", surface);
      url.searchParams.set("bridge_id", config.bridgeId);
      url.searchParams.set("host_origin", location.origin);
      url.searchParams.set("host_version", "1");
      if (state.cspBypass) url.searchParams.set("csp_bypass", "1");
      return url.href;
    }

    function createFrame(surface) {
      const frame = document.createElement("iframe");
      frame.dataset.weftCodexSurface = surface;
      // The child publishes its localized accessible name after receiving the
      // host locale. Use the product name only during the short handshake so
      // no user-facing locale string is duplicated in the launcher bundle.
      frame.title = "Weft";
      frame.src = surfaceUrl(surface);
      frame.referrerPolicy = "no-referrer";
      frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms");
      frame.setAttribute("allow", "clipboard-read; clipboard-write");
      frame.addEventListener("load", () => {
        if (surface === "modal") {
          state.modalVisible = false;
          syncModalRoot();
        }
        publishContextSoon();
      });
      return frame;
    }

    function isDialogState(value) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return false;
      if (value.type === "workspace" || value.type === "issue" || value.type === "repositories") {
        return true;
      }
      if (value.type !== "message") return false;
      if (value.target !== "lead" && value.target !== "task") return false;
      if (value.intent !== "message" && value.intent !== "continue") return false;
      return Number.isInteger(value.id) && value.id > 0;
    }

    function syncModalRoot() {
      const root = state.modalRoot;
      if (!(root instanceof HTMLElement)) return;
      const open = Boolean(state.modalVisible && state.dialogState);
      const openValue = open ? "true" : "false";
      const hiddenValue = open ? "false" : "true";
      if (root.dataset.open !== openValue) root.dataset.open = openValue;
      if (root.getAttribute("aria-hidden") !== hiddenValue) {
        root.setAttribute("aria-hidden", hiddenValue);
      }
      if (open) isolateModalBackground(root);
      else restoreModalBackground();
    }

    function isolateModalBackground(root) {
      const parent = root.parentElement;
      if (!parent) return;
      for (const sibling of parent.children) {
        if (!(sibling instanceof HTMLElement) || sibling === root) continue;
        if (!state.modalBackground.has(sibling)) {
          state.modalBackground.set(sibling, {
            inert: sibling.inert,
            ariaHidden: sibling.getAttribute("aria-hidden"),
          });
        }
        if (!sibling.inert) sibling.inert = true;
        if (sibling.getAttribute("aria-hidden") !== "true") {
          sibling.setAttribute("aria-hidden", "true");
        }
      }
    }

    function restoreModalBackground() {
      for (const [element, previous] of state.modalBackground) {
        if (!element.isConnected) continue;
        if (element.inert !== previous.inert) element.inert = previous.inert;
        if (previous.ariaHidden === null) {
          if (element.hasAttribute("aria-hidden")) element.removeAttribute("aria-hidden");
        } else if (element.getAttribute("aria-hidden") !== previous.ariaHidden) {
          element.setAttribute("aria-hidden", previous.ariaHidden);
        }
      }
      state.modalBackground.clear();
    }

    function ensureModalRoot() {
      let root = state.modalRoot;
      if (!(root instanceof HTMLElement)) {
        root = document.createElement("div");
        root.id = MODAL_ROOT_ID;
        root.dataset.weftCodexHostSurface = "modal";
        root.dataset.open = "false";
        root.setAttribute("aria-hidden", "true");
        const frame = createFrame("modal");
        root.append(frame);
        state.modalRoot = root;
        state.modalFrame = frame;
      }
      const parent = document.body || document.documentElement;
      if (root.parentElement !== parent) parent.append(root);
      syncModalRoot();
      return true;
    }

    function postDialogState() {
      const frame = state.modalFrame;
      if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) return;
      frame.contentWindow.postMessage({
        source: "weft-codex-host",
        type: "weft:dialog-state",
        payload: state.dialogState,
      }, childOrigin);
    }

    function presentDialog(dialog) {
      if (!isDialogState(dialog)) return false;
      ensureModalRoot();
      state.dialogState = dialog;
      state.modalVisible = false;
      syncModalRoot();
      postDialogState();
      return true;
    }

    function mountDialog() {
      if (!state.dialogState) return false;
      state.modalVisible = true;
      syncModalRoot();
      return true;
    }

    function dismissDialog() {
      state.modalVisible = false;
      state.dialogState = null;
      syncModalRoot();
      postDialogState();
    }

    /* ── conversation popover (spec 2026-08-13-lead-chat-conversation-popover)
       One discriminated state drives the panel; every transition is explicit. */

    function isWeftThreadContext() {
      return conversationAllowed();
    }

    function syncPopoverRoot() {
      const root = state.popoverRoot;
      if (!(root instanceof HTMLElement)) return;
      const open = state.popoverState !== "closed" && isWeftThreadContext();
      const openValue = open ? "true" : "false";
      if (root.dataset.open !== openValue) root.dataset.open = openValue;
    }

    function syncPopoverButton() {
      const button = nativeSidePanelButton();
      if (!(button instanceof HTMLElement)) return;
      state.popoverButton = button;
      const expanded = state.popoverState !== "closed" ? "true" : "false";
      if (button.getAttribute("aria-expanded") !== expanded) {
        button.setAttribute("aria-expanded", expanded);
      }
    }

    function setPopoverState(next) {
      if (next !== "closed" && next !== "open-auto" && next !== "open-pinned") return;
      if (state.popoverState === next) return;
      state.popoverState = next;
      syncPopoverRoot();
      syncPopoverButton();
      if (next !== "closed") ensurePopoverRoot();
      else {
        syncNativeRightPanelContent();
      }
      syncNativeSidePanelForConversation();
      syncSlotGeometry();
      publishContextSoon();
    }

    function ensurePopoverRoot() {
      let root = state.popoverRoot;
      if (!(root instanceof HTMLElement)) {
        root = document.createElement("div");
        root.id = POPOVER_ROOT_ID;
        root.dataset.weftCodexHostSurface = "popover";
        root.dataset.open = "false";
        const frame = createFrame("popover");
        root.append(frame);
        state.popoverRoot = root;
        state.popoverFrame = frame;
      }
      const parent = nativeRightPanelHost();
      if (parent && root.parentElement !== parent) parent.append(root);
      syncPopoverRoot();
      syncNativeRightPanelContent();
      return true;
    }

    function onWeftChatsClick(event) {
      if (state.mode !== "weft") return;
      if (state.sidePanelProgrammatic) return;
      /* Let the native toggle finish. onNativeSidePanelClick syncs Weft
         content afterwards so a user click cannot double-toggle Diff. */
    }

    function ensurePopoverButton() {
      const side = nativeSidePanelButton();
      if (!(side instanceof HTMLElement)) return false;
      state.popoverButton = side;
      if (side.dataset.weftCodexChatsBound !== "true") {
        side.dataset.weftCodexChatsBound = "true";
        side.addEventListener("click", onWeftChatsClick, true);
      }
      syncPopoverButton();
      return true;
    }

    function dismissPopover() {
      setPopoverState("closed");
    }

    function nativeRightPanel() {
      return document.querySelector('[data-app-shell-focus-area="right-panel"]');
    }

    function nativeRightPanelHost() {
      const panel = nativeRightPanel();
      if (!(panel instanceof HTMLElement)) return null;
      return panel.querySelector(":scope > .absolute.inset-0") || panel;
    }

    function syncNativeRightPanelContent() {
      const panel = nativeRightPanel();
      if (!(panel instanceof HTMLElement)) return;
      if (weftRightPanelOccupied()) bindNativeRightPanelResize();
      const occupy = weftRightPanelOccupied();
      const host = nativeRightPanelHost();
      if (!(host instanceof HTMLElement)) return;
      for (const child of host.children) {
        if (!(child instanceof HTMLElement)) continue;
        if (child.id === POPOVER_ROOT_ID || child.id === INSPECTOR_ROOT_ID) continue;
        /* Keep the native width skeleton visible so the Diff splitter can
           still size the panel. Only hide the inner Diff chrome. */
        if (occupy) {
          child.setAttribute("data-weft-codex-native-diff-shell", "");
          child.removeAttribute("data-weft-codex-hide-native-diff");
          for (const inner of child.querySelectorAll(":scope > *")) {
            if (inner instanceof HTMLElement) inner.setAttribute("data-weft-codex-hide-native-diff", "");
          }
        } else {
          child.removeAttribute("data-weft-codex-native-diff-shell");
          child.removeAttribute("data-weft-codex-hide-native-diff");
          for (const inner of child.querySelectorAll("[data-weft-codex-hide-native-diff]")) {
            inner.removeAttribute("data-weft-codex-hide-native-diff");
          }
        }
      }
      syncNativeDiffWebview();
    }

    function syncNativeDiffWebview() {
      const occupy = weftRightPanelOccupied();
      for (const webview of document.querySelectorAll("webview")) {
        if (!(webview instanceof HTMLElement)) continue;
        if (webview.closest("#" + POPOVER_ROOT_ID + ", #" + INSPECTOR_ROOT_ID + ", #" + WORKSPACE_ROOT_ID)) continue;
        if (occupy) webview.setAttribute("data-weft-codex-hide-native-diff", "");
        else webview.removeAttribute("data-weft-codex-hide-native-diff");
      }
    }

    function suppressNativeDiffChrome() {
      if (!weftRightPanelOccupied()) return;
      syncNativeDiffWebview();
      const dock = nativeBottomPanelButton();
      if (dock instanceof HTMLElement && dock.getAttribute("aria-pressed") === "true") {
        dock.click();
      }
    }

    function syncNativeSidePanelForConversation() {
      setDocumentState();
      const wantOpen = state.mode === "weft" && weftRightPanelOccupied();
      if (wantOpen === nativeInspectorOpen()) {
        if (wantOpen) {
          ensurePopoverRoot();
          ensureInspectorRoot();
          syncNativeRightPanelContent();
          suppressNativeDiffChrome();
        }
        return;
      }
      const button = nativeSidePanelButton();
      if (!(button instanceof HTMLElement)) return;
      state.sidePanelProgrammatic = true;
      button.click();
      const finish = (attempt) => {
        if (state.disposed) return;
        const host = nativeRightPanelHost();
        if (!host && attempt < 12) {
          window.setTimeout(() => finish(attempt + 1), 32);
          return;
        }
        state.sidePanelProgrammatic = false;
        if (wantOpen) {
          ensurePopoverRoot();
          ensureInspectorRoot();
          suppressNativeDiffChrome();
        }
        syncNativeRightPanelContent();
        syncSlotGeometry();
      };
      window.setTimeout(() => finish(0), 0);
    }

    function validIssueId(value) {
      return Number.isInteger(value) && value > 0;
    }

    function nativeRightHeaderSlot() {
      const slots = [...document.querySelectorAll('[data-test-id="header-shell-slot"]')];
      return slots.length ? slots[slots.length - 1] : null;
    }

    function nativeTitlebarButton(label) {
      const slot = nativeRightHeaderSlot();
      const scope = slot instanceof HTMLElement ? slot : document;
      const matches = [...scope.querySelectorAll("button")].filter((button) => {
        return (button.getAttribute("aria-label") || "") === label;
      });
      return matches.find((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.x > 200;
      }) || null;
    }

    function nativeSidePanelButton() {
      return nativeTitlebarButton("Toggle side panel");
    }

    function nativeBottomPanelButton() {
      return nativeTitlebarButton("Toggle bottom panel");
    }

    function nativeInspectorOpen() {
      const button = nativeSidePanelButton();
      if (button && button.getAttribute("aria-pressed") === "true") return true;
      const panel = nativeRightPanel();
      if (!(panel instanceof HTMLElement)) return false;
      const rect = panel.getBoundingClientRect();
      return rect.width > 40;
    }

    function nativeDockOpen() {
      const button = nativeBottomPanelButton();
      return Boolean(button && button.getAttribute("aria-pressed") === "true");
    }

    function closeNativeInspector() {
      const button = nativeSidePanelButton();
      if (button instanceof HTMLElement && button.getAttribute("aria-pressed") === "true") {
        button.click();
      }
    }

    function weftInspectorOpen() {
      return state.mode === "weft" && validIssueId(state.inspectorIssueId);
    }

    function weftRightPanelOccupied() {
      if (state.mode !== "weft") return false;
      return weftInspectorOpen() || (state.view === "thread" && state.popoverState !== "closed");
    }

    function conversationAllowed() {
      return state.mode === "weft" && state.view === "thread";
    }

    function syncInspectorRoot() {
      const root = state.inspectorRoot;
      if (!(root instanceof HTMLElement)) return;
      const open = weftInspectorOpen();
      const openValue = open ? "true" : "false";
      if (root.dataset.open !== openValue) root.dataset.open = openValue;
      const hiddenValue = open ? "false" : "true";
      if (root.getAttribute("aria-hidden") !== hiddenValue) {
        root.setAttribute("aria-hidden", hiddenValue);
      }
    }

    function ensureInspectorRoot() {
      let root = state.inspectorRoot;
      if (!(root instanceof HTMLElement)) {
        root = document.createElement("div");
        root.id = INSPECTOR_ROOT_ID;
        root.dataset.weftCodexHostSurface = "inspector";
        root.dataset.open = "false";
        root.setAttribute("aria-hidden", "true");
        const frame = createFrame("inspector");
        root.append(frame);
        state.inspectorRoot = root;
        state.inspectorFrame = frame;
      }
      const parent = nativeRightPanelHost();
      if (parent && root.parentElement !== parent) parent.append(root);
      syncInspectorRoot();
      syncNativeRightPanelContent();
      return Boolean(parent);
    }

    function openInspector(issueId) {
      if (!validIssueId(issueId) || state.mode !== "weft") return false;
      const changed = state.inspectorIssueId !== issueId;
      state.inspectorIssueId = issueId;
      state.lastInspectorIssueId = issueId;
      dismissPopover();
      ensureInspectorRoot();
      syncInspectorRoot();
      syncNativeSidePanelForConversation();
      syncNativeChrome();
      syncSlotGeometry();
      setDocumentState();
      if (changed) publishContextSoon();
      return true;
    }

    function closeInspector(options) {
      const keepNative = Boolean(options && options.keepNative);
      if (state.inspectorIssueId == null) {
        syncInspectorRoot();
        return;
      }
      state.inspectorIssueId = null;
      syncInspectorRoot();
      syncNativeRightPanelContent();
      if (!keepNative) syncNativeSidePanelForConversation();
      syncNativeChrome();
      syncSlotGeometry();
      setDocumentState();
      publishContextSoon();
    }

    function measureDockHeight(mainRoute) {
      const button = nativeBottomPanelButton();
      if (!(button instanceof HTMLElement) || button.getAttribute("aria-pressed") !== "true") return 0;
      const mainRect = mainRoute.getBoundingClientRect();
      let height = 0;
      for (const candidate of document.querySelectorAll("aside, section, div")) {
        if (!(candidate instanceof HTMLElement)) continue;
        if (state.workspaceRoot && (candidate === state.workspaceRoot || state.workspaceRoot.contains(candidate))) continue;
        if (state.inspectorRoot && (candidate === state.inspectorRoot || state.inspectorRoot.contains(candidate))) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.width < 120 || rect.height < 72 || rect.height > mainRect.height * 0.55) continue;
        if (rect.bottom < mainRect.bottom - 8 || rect.top < mainRect.top + 80) continue;
        if (rect.left > mainRect.left + 40) continue;
        height = Math.max(height, Math.round(mainRect.bottom - rect.top));
      }
      return height;
    }

    function rememberRightPanelWidth(width) {
      if (!Number.isFinite(width) || width < 240) return;
      state.lastRightPanelWidth = Math.round(width);
    }

    function applyWeftRightPanelWidth(width) {
      const panel = nativeRightPanel();
      if (!(panel instanceof HTMLElement)) return 0;
      const next = Math.max(280, Math.min(720, Math.round(width)));
      rememberRightPanelWidth(next);
      const sized = next + "px";
      if (panel.style.width !== sized) panel.style.width = sized;
      if (panel.style.flexBasis !== sized) panel.style.flexBasis = sized;
      if (panel.style.flexGrow !== "0") panel.style.flexGrow = "0";
      if (panel.style.flexShrink !== "0") panel.style.flexShrink = "0";
      const shell = panel.querySelector("[data-weft-codex-native-diff-shell]");
      if (shell instanceof HTMLElement) {
        shell.style.width = sized;
        shell.style.minWidth = sized;
      }
      return next;
    }

    function bindNativeRightPanelResize() {
      const handle = document.querySelector('[data-app-shell-focus-area="right-panel"] > [role="separator"]');
      if (!(handle instanceof HTMLElement) || handle.dataset.weftCodexResizeBound === "true") return;
      handle.dataset.weftCodexResizeBound = "true";
      let dragging = false;
      const onMove = (event) => {
        if (!dragging || !weftRightPanelOccupied()) return;
        const mainRoute = visibleMainRoute();
        if (!(mainRoute instanceof HTMLElement)) return;
        const right = mainRoute.getBoundingClientRect().right;
        applyWeftRightPanelWidth(right - event.clientX);
        syncSlotGeometry();
      };
      const onUp = () => {
        if (!dragging) return;
        dragging = false;
        window.removeEventListener("pointermove", onMove, true);
        window.removeEventListener("pointerup", onUp, true);
      };
      handle.addEventListener("pointerdown", (event) => {
        if (!weftRightPanelOccupied()) return;
        dragging = true;
        event.preventDefault();
        event.stopPropagation();
        window.addEventListener("pointermove", onMove, true);
        window.addEventListener("pointerup", onUp, true);
      }, true);
    }

    function measureNativeInspectorWidth(mainRoute) {
      if (!nativeInspectorOpen()) return 0;
      if (weftRightPanelOccupied()) {
        const preferred = state.lastRightPanelWidth || 420;
        return applyWeftRightPanelWidth(preferred);
      }
      const mainRect = mainRoute.getBoundingClientRect();
      const panel = nativeRightPanel();
      if (panel instanceof HTMLElement) {
        const rect = panel.getBoundingClientRect();
        if (rect.width > 80 && rect.right > mainRect.right - 24) {
          return Math.round(mainRect.right - rect.left);
        }
      }
      let width = 0;
      for (const candidate of document.querySelectorAll("aside")) {
        if (!(candidate instanceof HTMLElement)) continue;
        if (state.inspectorRoot && (candidate === state.inspectorRoot || state.inspectorRoot.contains(candidate))) continue;
        const rect = candidate.getBoundingClientRect();
        if (rect.width < 220 || rect.height < mainRect.height * 0.5) continue;
        if (rect.right < mainRect.right - 16 || rect.left < mainRect.left + 80) continue;
        width = Math.max(width, Math.round(mainRect.right - rect.left));
      }
      return width;
    }

    function applySlotBox(element, box) {
      if (!(element instanceof HTMLElement)) return;
      const next = {
        top: box.top + "px",
        right: box.right + "px",
        bottom: box.bottom + "px",
        left: box.left + "px",
      };
      for (const [key, value] of Object.entries(next)) {
        if (element.style[key] !== value) element.style[key] = value;
      }
    }

    function observeRightPanelResize() {
      const panel = nativeRightPanel();
      if (!(panel instanceof HTMLElement) || !state.resizeObserver) return;
      if (panel.dataset.weftCodexResizeObserved === "true") return;
      panel.dataset.weftCodexResizeObserved = "true";
      state.resizeObserver.observe(panel);
    }

    function syncSlotGeometry() {
      observeRightPanelResize();
      const mainRoute = visibleMainRoute();
      if (!(mainRoute instanceof HTMLElement)) return;
      const mainRect = mainRoute.getBoundingClientRect();
      const dragRegions = [...mainRoute.querySelectorAll("header, header *")].filter((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region") === "drag"
      );
      let top = 0;
      for (const region of dragRegions) {
        const rect = region.getBoundingClientRect();
        top = Math.max(top, rect.bottom - mainRect.top);
      }
      top = Math.max(0, Math.round(top));
      const dock = measureDockHeight(mainRoute);
      const nativeRight = measureNativeInspectorWidth(mainRoute);
      if (state.workspaceRoot) {
        applySlotBox(state.workspaceRoot, {
          top: state.mode === "weft" && state.view === "workspace" ? 0 : top,
          right: nativeRight,
          bottom: dock,
          left: 0,
        });
      }

    }

    function releaseWeftRightPanel() {
      if (state.popoverState !== "closed") dismissPopover();
      if (!weftInspectorOpen()) {
        setDocumentState();
        return;
      }
      state.inspectorIssueId = null;
      syncInspectorRoot();
      setDocumentState();
      publishContextSoon();
    }

    function onNativeSidePanelClick() {
      if (state.sidePanelProgrammatic) return;
      const wasOpen = nativeInspectorOpen();
      const settle = (attempt) => {
        if (state.disposed) return;
        const pressed = (() => {
          const button = nativeSidePanelButton();
          return Boolean(button && button.getAttribute("aria-pressed") === "true");
        })();
        const visible = (() => {
          const panel = nativeRightPanel();
          if (!(panel instanceof HTMLElement)) return false;
          return panel.getBoundingClientRect().width > 40;
        })();
        const open = pressed || visible;
        if (state.sidePanelProgrammatic) {
          if (open) suppressNativeDiffChrome();
          syncSlotGeometry();
          return;
        }
        if (wasOpen) {
          if (open && attempt < 20) {
            window.setTimeout(() => settle(attempt + 1), 16);
            return;
          }
          releaseWeftRightPanel();
          syncSlotGeometry();
          return;
        }
        if (!open && attempt < 20) {
          window.setTimeout(() => settle(attempt + 1), 16);
          return;
        }
        if (!open) {
          releaseWeftRightPanel();
          syncSlotGeometry();
          return;
        }
        suppressNativeDiffChrome();
        if (weftInspectorOpen()) ensureInspectorRoot();
        else if (state.view === "thread") {
          if (state.popoverState === "closed") setPopoverState("open-pinned");
          else ensurePopoverRoot();
        } else if (validIssueId(state.lastInspectorIssueId)) {
          openInspector(state.lastInspectorIssueId);
        } else {
          closeNativeInspector();
        }
        syncNativeRightPanelContent();
        syncSlotGeometry();
      };
      window.setTimeout(() => settle(0), 0);
    }

    function syncNativeChrome() {
      const side = nativeSidePanelButton();
      if (side instanceof HTMLElement) {
        side.removeAttribute("data-weft-codex-hide-side-panel");
        if (side.getAttribute("data-weft-codex-side-panel-bound") !== "true") {
          side.setAttribute("data-weft-codex-side-panel-bound", "true");
          side.addEventListener("click", onNativeSidePanelClick, true);
        }
      }
      const title = document.querySelector("[data-testid='app-shell-header-context-menu-surface']");
      if (title instanceof HTMLElement) {
        const hideTitle = state.mode === "weft" && state.view === "workspace";
        if (hideTitle) title.setAttribute("data-weft-codex-hide-thread-title", "");
        else title.removeAttribute("data-weft-codex-hide-thread-title");
      }
    }

    function createFallbackButton() {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "weft-codex-fallback-button";
      button.dataset.weftCodexFallback = "";
      button.textContent = "Weft";
      button.addEventListener("click", () => setMode("weft"));
      return button;
    }

    function ensureSidebarRoot() {
      const sidebar = document.querySelector("[data-app-action-sidebar-scroll]");
      if (!(sidebar instanceof HTMLElement)) return false;
      let root = state.sidebarRoot;
      if (!(root instanceof HTMLElement)) {
        root = document.createElement("div");
        root.id = SIDEBAR_ROOT_ID;
        root.dataset.weftCodexHostSurface = "sidebar";
        root.append(createFallbackButton());
        const frame = createFrame("sidebar");
        root.append(frame);
        state.sidebarRoot = root;
        state.sidebarFrame = frame;
      }
      if (root.parentElement !== sidebar) sidebar.append(root);
      syncNativeSidebar();
      return true;
    }

    function sidebarLocale() {
      const locale = (document.documentElement.lang || navigator.language || "en").toLowerCase();
      return locale.startsWith("zh") ? "zh" : "en";
    }

    function postSidebarCommand(payload) {
      if (!state.sidebarFrame || !state.sidebarFrame.contentWindow || !payload) return;
      state.sidebarFrame.contentWindow.postMessage({
        source: "weft-codex-host",
        type: "weft:sidebar-command",
        payload,
      }, childOrigin);
    }

    function isSidebarItem(value) {
      if (!value || typeof value !== "object") return false;
      if (typeof value.key !== "string" || !value.key || value.key.length > 160) return false;
      if (typeof value.title !== "string" || !value.title || value.title.length > 200) return false;
      if (value.kind === "kanban" || value.kind === "repos") return true;
      if (value.kind === "workspace") {
        return Number.isInteger(value.workspaceId) && value.workspaceId > 0;
      }
      if (value.kind !== "issue") return false;
      if (!Number.isInteger(value.issueId) || value.issueId <= 0) return false;
      if (value.threadId !== undefined && (typeof value.threadId !== "string" || !value.threadId)) return false;
      return true;
    }

    function normalizeSidebarModel(value) {
      if (!value || typeof value !== "object" || !Array.isArray(value.items)) return null;
      const items = value.items.filter(isSidebarItem).slice(0, 80);
      return {
        workspaceLabel: typeof value.workspaceLabel === "string" ? value.workspaceLabel.slice(0, 80) : "",
        issuesLabel: typeof value.issuesLabel === "string" ? value.issuesLabel.slice(0, 80) : "",
        createLabel: typeof value.createLabel === "string" ? value.createLabel.slice(0, 80) : "",
        workspaceId: Number.isInteger(value.workspaceId) && value.workspaceId > 0 ? value.workspaceId : null,
        items,
      };
    }

    function sectionBody(section) {
      if (!(section instanceof HTMLElement)) return section;
      const overflow = section.querySelector(":scope > div > .overflow-hidden")
        || section.querySelector(".overflow-hidden");
      if (!(overflow instanceof HTMLElement)) return section;
      const list = overflow.querySelector(":scope > div") || overflow.firstElementChild;
      return list instanceof HTMLElement ? list : overflow;
    }

    function setSectionLabel(section, label) {
      if (!(section instanceof HTMLElement) || !label) return;
      section.setAttribute("data-app-action-sidebar-section-heading", label);
      const toggle = section.querySelector("[data-app-action-sidebar-section-toggle] span.min-w-0.truncate")
        || section.querySelector("[data-app-action-sidebar-section-toggle] span.min-w-0")
        || section.querySelector("[data-app-action-sidebar-section-toggle] span");
      if (!(toggle instanceof HTMLElement)) return;
      if (!toggle.dataset.weftCodexSavedLabel) toggle.dataset.weftCodexSavedLabel = toggle.textContent || "";
      if (toggle.textContent !== label) toggle.textContent = label;
    }

    function setNativeRowTitle(row, title) {
      if (!(row instanceof HTMLElement) || !title) return;
      row.setAttribute("data-app-action-sidebar-thread-title", title);
      if (row.getAttribute("aria-label") !== title) row.setAttribute("aria-label", title);
      const label = [...row.querySelectorAll("span, p, div")].find((node) => {
        if (!(node instanceof HTMLElement) || node.children.length) return false;
        const text = (node.textContent || "").trim();
        return Boolean(text) && text.length < 160;
      });
      if (label && label.textContent !== title) label.textContent = title;
    }

    function bindNativeRow(row, item) {
      if (!(row instanceof HTMLElement) || !item) return;
      row.dataset.weftCodexNativeRow = item.kind;
      row.dataset.weftCodexNativeKey = item.key;
      row.removeAttribute("data-app-action-sidebar-thread-id");
      row.removeAttribute("data-app-action-sidebar-thread-host-id");
      if (Number.isInteger(item.issueId)) row.dataset.weftCodexIssueId = String(item.issueId);
      else delete row.dataset.weftCodexIssueId;
      setNativeRowTitle(row, item.title);
      const selected = Boolean(item.selected);
      row.setAttribute("data-app-action-sidebar-thread-selected", selected ? "true" : "false");
      row.setAttribute("data-app-action-sidebar-thread-active", selected ? "true" : "false");
      stripNativeRowChrome(row);
    }

    function stripNativeRowChrome(row) {
      if (!(row instanceof HTMLElement)) return;
      for (const extra of [...row.querySelectorAll("button, [role='button'], [data-hover-card-open-immediately], svg, [data-state]")]) {
        extra.remove();
      }
      for (const extra of [...row.children]) {
        if (!(extra instanceof HTMLElement)) continue;
        const cls = extra.className || "";
        if (extra.classList.contains("contents")) extra.remove();
        else if (/absolute/.test(cls) && /end-0|justify-end|min-w-/.test(cls)) extra.remove();
        else if (/shrink-0/.test(cls) && /absolute|end-0|justify-end|min-w-|w-\[52px\]/.test(cls)) extra.remove();
      }
    }

    function cloneNativeRow(source, item) {
      if (!(source instanceof HTMLElement)) return null;
      const row = source.cloneNode(true);
      if (!(row instanceof HTMLElement)) return null;
      row.removeAttribute("data-weft-codex-native-bound");
      row.removeAttribute("data-weft-codex-native-thread");
      row.removeAttribute("data-app-action-sidebar-thread-id");
      stripNativeRowChrome(row);
      bindNativeRow(row, item);
      return row;
    }

    function relabelNewChat(model) {
      const locale = sidebarLocale();
      const label = model && typeof model.createLabel === "string" && model.createLabel
        ? model.createLabel
        : (locale === "zh" ? "新建 issue" : "Create issue");
      const wrap = document.querySelector("[data-weft-codex-native-header-action]")
        || [...document.querySelectorAll("button")].find((button) => /new chat|新对话|新聊天/i.test(button.textContent || ""));
      const button = wrap instanceof HTMLElement
        ? (wrap.matches("button") ? wrap : wrap.querySelector("button"))
        : wrap;
      if (!(button instanceof HTMLElement)) return;
      const title = [...button.querySelectorAll("span, div")].find((node) => {
        const text = (node.textContent || "").trim();
        return /new chat|新对话|新聊天|create issue|新建 issue/i.test(text) && !node.querySelector("span, div");
      });
      const labelNode = title instanceof HTMLElement ? title : null;
      if (labelNode && !labelNode.dataset.weftCodexSavedLabel) {
        labelNode.dataset.weftCodexSavedLabel = labelNode.textContent || "";
      }
      if (labelNode && labelNode.textContent !== label) labelNode.textContent = label;
      else if (/new chat|新对话|新聊天/i.test(button.textContent || "") && button.childElementCount === 0) {
        if (!button.dataset.weftCodexSavedLabel) button.dataset.weftCodexSavedLabel = button.textContent || "";
        button.textContent = label;
      }
    }

    function hideNativeUtilityRows(scroll) {
      for (const button of scroll.querySelectorAll("button, [role='button']")) {
        if (!(button instanceof HTMLElement)) continue;
        if (button.closest("#" + SIDEBAR_ROOT_ID)) continue;
        if (button.hasAttribute("data-app-action-sidebar-thread-row")) continue;
        if (button.hasAttribute("data-app-action-sidebar-section-toggle")) continue;
        const text = (button.textContent || button.getAttribute("aria-label") || "").trim();
        if (/^(Pull requests|Sites|Scheduled|Plugins|拉取请求|站点|定时|插件)$/i.test(text)) {
          const row = button.closest("div");
          if (row instanceof HTMLElement) row.dataset.weftCodexNativeUtility = "";
        }
        if (/project sidebar options|add new project|chat sidebar options|^new chat$|start new chat/i.test(text)) {
          button.dataset.weftCodexNativeUtility = "";
        }
      }
      for (const child of scroll.children) {
        if (!(child instanceof HTMLElement) || child.id === SIDEBAR_ROOT_ID) continue;
        if (child.hasAttribute("data-app-action-sidebar-section")) continue;
        if (child.querySelector("[data-app-action-sidebar-section]")) continue;
        child.dataset.weftCodexNativeUtility = "";
      }
    }

    function syncNativeSidebar() {
      const scroll = document.querySelector("[data-app-action-sidebar-scroll]");
      if (!(scroll instanceof HTMLElement) || state.mode !== "weft") return;
      const model = state.sidebarModel;
      const items = model && Array.isArray(model.items) ? model.items : [];
      const sections = [...scroll.querySelectorAll("[data-app-action-sidebar-section]")];
      const templates = [...scroll.querySelectorAll("[data-app-action-sidebar-thread-row]")];
      const template = templates.find((row) => !row.closest("#" + SIDEBAR_ROOT_ID)) || templates[0];
      hideNativeUtilityRows(scroll);
      relabelNewChat(model);

      if (sections[0] && model && model.workspaceLabel) setSectionLabel(sections[0], model.workspaceLabel);
      if (sections[1] && model && model.issuesLabel) setSectionLabel(sections[1], model.issuesLabel);

      const workspaceItems = items.filter((item) => item && (item.kind === "workspace" || item.kind === "kanban" || item.kind === "repos"));
      const issueItems = items.filter((item) => item && item.kind === "issue");
      if (template && sections[0]) {
        const body = sectionBody(sections[0]);
        const existing = [...body.querySelectorAll("[data-weft-codex-native-row]")];
        workspaceItems.forEach((item, index) => {
          let row = existing[index];
          if (!(row instanceof HTMLElement)) {
            row = cloneNativeRow(template, item);
            if (row) body.append(row);
          } else {
            bindNativeRow(row, item);
          }
        });
        existing.slice(workspaceItems.length).forEach((row) => row.remove());
      }
      if (template && sections[1]) {
        const body = sectionBody(sections[1]);
        const existing = [...body.querySelectorAll("[data-weft-codex-native-row]")];
        issueItems.forEach((item, index) => {
          let row = existing[index];
          if (!(row instanceof HTMLElement)) {
            row = cloneNativeRow(template, item);
            if (row) body.append(row);
          } else {
            bindNativeRow(row, item);
          }
        });
        existing.slice(issueItems.length).forEach((row) => row.remove());
      }

      for (const section of sections) {
        const body = sectionBody(section);
        if (!(body instanceof HTMLElement)) continue;
        for (const child of body.children) {
          if (!(child instanceof HTMLElement) || child.dataset.weftCodexNativeRow) continue;
          child.dataset.weftCodexNativeThread = "";
        }
      }
    }

    function restoreNativeSidebar() {
      for (const element of document.querySelectorAll("[data-weft-codex-saved-label]")) {
        if (!(element instanceof HTMLElement)) continue;
        const saved = element.dataset.weftCodexSavedLabel;
        if (saved !== undefined && element.textContent !== saved) element.textContent = saved;
        delete element.dataset.weftCodexSavedLabel;
      }
      for (const section of document.querySelectorAll("[data-app-action-sidebar-section]")) {
        const toggle = section.querySelector("[data-app-action-sidebar-section-toggle] span.min-w-0.truncate")
          || section.querySelector("[data-app-action-sidebar-section-toggle] span.min-w-0");
        if (toggle instanceof HTMLElement && toggle.textContent) {
          section.setAttribute("data-app-action-sidebar-section-heading", toggle.textContent);
        }
      }
      for (const element of document.querySelectorAll("[data-weft-codex-native-row],[data-weft-codex-native-thread],[data-weft-codex-native-utility]")) {
        if (!(element instanceof HTMLElement)) continue;
        if (element.hasAttribute("data-weft-codex-native-row")) element.remove();
        else {
          element.removeAttribute("data-weft-codex-native-thread");
          element.removeAttribute("data-weft-codex-native-utility");
        }
      }
    }

    ${VISIBLE_MAIN_HELPERS_SOURCE}

    function ensureWorkspaceRoot() {
      const mainRoute = visibleMainRoute();
      if (!(mainRoute instanceof HTMLElement)) return false;
      let root = state.workspaceRoot;
      if (!(root instanceof HTMLElement)) {
        root = document.createElement("div");
        root.id = WORKSPACE_ROOT_ID;
        root.dataset.weftCodexHostSurface = "workspace";
        const frame = createFrame("workspace");
        root.append(frame);
        state.workspaceRoot = root;
        state.workspaceFrame = frame;
      }
      if (root.parentElement !== mainRoute) mainRoute.append(root);
      syncSlotGeometry();
      return true;
    }

    function installStyles() {
      if (document.getElementById(STYLE_ID)) return;
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = \`
        #${SIDEBAR_ROOT_ID} {
          display: none;
          min-width: 0;
          min-height: 0;
          width: 100%;
        }
        #${SIDEBAR_ROOT_ID} > iframe,
        #${WORKSPACE_ROOT_ID} > iframe,
        #${MODAL_ROOT_ID} > iframe,
        #${INSPECTOR_ROOT_ID} > iframe {
          width: 100%;
          height: 100%;
          min-width: 0;
          min-height: 0;
          border: 0;
          background: transparent;
          color-scheme: inherit;
        }
        #${SIDEBAR_ROOT_ID} > iframe { display: none; }
        #${WORKSPACE_ROOT_ID} {
          position: absolute;
          z-index: 20;
          display: none;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          background: var(--color-token-main-surface-primary);
        }
        #${INSPECTOR_ROOT_ID} {
          position: absolute;
          inset: 0 0 0 8px;
          z-index: 3;
          display: none;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          background: var(--color-token-main-surface-primary);
          pointer-events: auto;
        }
        #${INSPECTOR_ROOT_ID}[data-open="true"] {
          display: block;
        }
        html[data-weft-codex-mode="weft"][data-weft-codex-view="workspace"] [data-weft-codex-hide-side-panel] {
          display: none !important;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"][data-weft-codex-view="workspace"] [data-weft-codex-hide-thread-title] {
          visibility: hidden !important;
        }
        /* Dialogs live in a third host-level surface. Sidebar and workspace
           never move or change opacity, so the scrim covers the real complete
           window without replacing either underlying surface. */
        #${MODAL_ROOT_ID} {
          position: fixed;
          inset: 0;
          z-index: var(--weft-layer-modal, 10000);
          visibility: hidden;
          pointer-events: none;
        }
        #${MODAL_ROOT_ID}[data-open="true"] {
          visibility: visible;
          pointer-events: auto;
        }
        #${MODAL_ROOT_ID} > iframe {
          display: block;
          background: transparent !important;
          color-scheme: normal !important;
        }
        /* Tier 2 only. Every rule that hides or reflows native chrome is gated
        /* Conversation popover: host-level panel anchored under the title
           bar, top-right of the thread view (spec §2.3). */
        #${POPOVER_ROOT_ID} {
          position: absolute;
          inset: 0 0 0 8px;
          z-index: 2;
          width: auto;
          height: auto;
          visibility: hidden;
          pointer-events: none;
        }
        #${POPOVER_ROOT_ID}[data-open="true"] {
          visibility: visible;
          pointer-events: auto;
        }
        #${POPOVER_ROOT_ID} > iframe {
          width: 100%;
          height: 100%;
          min-width: 0;
          min-height: 0;
          border: 0;
          background: transparent;
          color-scheme: inherit;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] [data-app-shell-focus-area="right-panel"] > [role="separator"] {
          pointer-events: auto !important;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] [data-weft-codex-native-diff-shell] {
          background: transparent !important;
          border-color: transparent !important;
          pointer-events: none !important;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] [data-weft-codex-hide-native-diff] {
          visibility: hidden !important;
          pointer-events: none !important;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"][data-weft-codex-right="weft"] webview,
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"][data-weft-codex-right="weft"] [data-app-shell-focus-area="bottom-panel"] {
          display: none !important;
        }
           on tier="weft-mode"; a failed subtractive probe leaves the host UI
           untouched instead of hiding it (spec §7.5 fail-open). */
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] [data-app-action-sidebar-scroll] {
          background: transparent !important;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] #${SIDEBAR_ROOT_ID} {
          position: absolute;
          width: 0;
          height: 0;
          overflow: hidden;
          pointer-events: none;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] [data-weft-codex-native-utility],
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] [data-weft-codex-native-thread] {
          display: none !important;
        }
        /* Tier 1: native sidebar keeps every row; Weft only appends an entry
           that opens the workspace overlay. */
        html[data-weft-codex-tier="additive"][data-weft-codex-mode="weft"] #${SIDEBAR_ROOT_ID} {
          display: block;
          flex: 0 0 auto;
          height: 30px;
          padding: 0 var(--padding-row-x, 8px);
        }
        html[data-weft-codex-tier="additive"][data-weft-codex-mode="weft"] .weft-codex-fallback-button {
          display: block;
        }
        html[data-weft-codex-mode="weft"][data-weft-codex-view="workspace"] #${WORKSPACE_ROOT_ID} {
          display: block;
        }
        html[data-weft-codex-mode-capability="fallback"]:not([data-weft-codex-mode="weft"]) #${SIDEBAR_ROOT_ID} {
          display: block;
          flex: 0 0 auto;
          height: 30px;
          padding: 0 var(--padding-row-x, 8px);
        }
        .weft-codex-fallback-button {
          display: none;
          width: 100%;
          height: 30px;
          padding: 0 var(--padding-row-cell-x, 8px);
          border: 0;
          border-radius: var(--radius-token-row, 10px);
          background: transparent;
          color: var(--color-token-foreground);
          font: inherit;
          text-align: start;
          cursor: pointer;
        }
        .weft-codex-fallback-button:hover,
        .weft-codex-fallback-button:focus-visible {
          background: var(--color-token-list-hover-background);
          outline: none;
        }
        html[data-weft-codex-mode-capability="fallback"]:not([data-weft-codex-mode="weft"]) .weft-codex-fallback-button {
          display: block;
        }
        html[data-weft-codex-mode="weft"] [${NATIVE_CHECK_ATTR}] {
          display: none !important;
        }
        /* Ours are the mirror image of the native actions: shown only where the
           natives are hidden. Both halves are gated on tier="weft-mode", so a
           failed subtractive probe leaves the header entirely native. */
        html:not([data-weft-codex-tier="weft-mode"]) [${HEADER_ACTION_ATTR}],
        html:not([data-weft-codex-mode="weft"]) [${HEADER_ACTION_ATTR}] {
          display: none !important;
        }
        [${HEADER_ACTION_ATTR}] {
          position: relative;
        }
        [${HEADER_BADGE_ATTR}] {
          position: absolute;
          top: -1px;
          inset-inline-end: -1px;
          min-width: 14px;
          height: 14px;
          padding: 0 3px;
          border-radius: 7px;
          background: var(--color-token-primary);
          color: var(--color-token-button-foreground);
          font-size: 9px;
          font-weight: 600;
          line-height: 14px;
          text-align: center;
          pointer-events: none;
        }
      \`;
      (document.head || document.documentElement).append(style);
    }

    function checkIcon() {
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.dataset.weftCodexCheck = "";
      svg.setAttribute("width", "17");
      svg.setAttribute("height", "17");
      svg.setAttribute("viewBox", "0 0 17 17");
      svg.setAttribute("fill", "none");
      svg.setAttribute("aria-hidden", "true");
      svg.classList.add("icon-xs", "shrink-0", "opacity-75");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M13.7 4.1a.7.7 0 0 1 .2 1l-6.2 8a.7.7 0 0 1-1 .1L3 9.8a.7.7 0 1 1 1-1l3.1 2.8 5.6-7.3a.7.7 0 0 1 1-.2Z");
      path.setAttribute("fill", "currentColor");
      svg.append(path);
      return svg;
    }

    function associatedModeMenu(menu) {
      if (!(menu instanceof HTMLElement) || menu.getAttribute("role") !== "menu") return false;
      const button = state.modeButton;
      if (!(button instanceof HTMLElement)) return false;
      return Boolean(button.id) && menu.getAttribute("aria-labelledby") === button.id;
    }

    function activateWeftMenuItem(event) {
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      const menu = event.currentTarget instanceof Element
        ? event.currentTarget.closest('[role="menu"]')
        : null;
      const nativeCodex = menu
        ? [...menu.querySelectorAll('[role="menuitem"]:not([' + MODE_ITEM_ATTR + '])')]
            .find((item) => /^Codex/i.test(item.textContent || ""))
        : null;
      if (nativeCodex instanceof HTMLElement && state.nativeMode !== "codex") nativeCodex.click();
      state.nativeMode = "codex";
      setMode("weft");
      if (state.modeButton instanceof HTMLElement) state.modeButton.focus();
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    }

    function prepareMenuKeyboard(menu, item) {
      if (menu.dataset.weftCodexKeyboard === "true") return;
      menu.dataset.weftCodexKeyboard = "true";
      menu.addEventListener("keydown", (event) => {
        const nativeItems = [...menu.querySelectorAll('[role="menuitem"]:not([' + MODE_ITEM_ATTR + '])')];
        const lastNative = nativeItems[nativeItems.length - 1];
        if (event.key === "ArrowDown" && document.activeElement === lastNative) {
          event.preventDefault();
          item.focus();
          return;
        }
        if (event.key === "ArrowUp" && document.activeElement === item && lastNative instanceof HTMLElement) {
          event.preventDefault();
          lastNative.focus();
          return;
        }
        if ((event.key === "Enter" || event.key === " ") && document.activeElement === item) {
          activateWeftMenuItem(event);
        }
      }, true);
    }

    function createWeftMenuItem(menu) {
      const template = menu.querySelector('[role="menuitem"]');
      if (!(template instanceof HTMLElement)) return null;
      const item = template.cloneNode(true);
      if (!(item instanceof HTMLElement)) return null;
      item.setAttribute(MODE_ITEM_ATTR, "");
      item.setAttribute("role", "menuitem");
      item.setAttribute("tabindex", "-1");
      item.removeAttribute("aria-labelledby");
      for (const identified of item.querySelectorAll("[id]")) identified.removeAttribute("id");

      const leafSpans = [...item.querySelectorAll("span")].filter((span) => !span.querySelector("span"));
      if (leafSpans[0]) leafSpans[0].textContent = "Weft";
      const locale = (document.documentElement.lang || navigator.language || "en").toLowerCase();
      if (leafSpans[1]) {
        leafSpans[1].textContent = locale.startsWith("zh")
          ? "跨仓库推进 issue"
          : "Plan and ship across repos";
      }
      for (const svg of item.querySelectorAll("svg")) svg.remove();
      const content = item.firstElementChild;
      if (state.mode === "weft" && content) content.append(checkIcon());
      item.addEventListener("click", activateWeftMenuItem, true);
      item.addEventListener("pointerdown", (event) => event.stopPropagation(), true);
      return item;
    }

    function syncModeMenus() {
      for (const menu of document.querySelectorAll('[role="menu"]')) {
        if (!associatedModeMenu(menu)) continue;
        for (const nativeItem of menu.querySelectorAll('[role="menuitem"]:not([' + MODE_ITEM_ATTR + '])')) {
          const directIcon = nativeItem.firstElementChild && nativeItem.firstElementChild.querySelector(":scope > svg");
          if (directIcon) directIcon.setAttribute(NATIVE_CHECK_ATTR, "");
        }
        let item = menu.querySelector("[" + MODE_ITEM_ATTR + "]");
        if (!(item instanceof HTMLElement)) {
          item = createWeftMenuItem(menu);
          if (item) menu.append(item);
        }
        if (!(item instanceof HTMLElement)) continue;
        const content = item.firstElementChild;
        if (content) {
          const existingCheck = content.querySelector(":scope > svg[data-weft-codex-check]");
          if (state.mode === "weft" && !existingCheck) content.append(checkIcon());
          if (state.mode !== "weft" && existingCheck) existingCheck.remove();
        }
        prepareMenuKeyboard(menu, item);
      }
    }

    function activeThreadId() {
      const active = document.querySelector('[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]')
        || document.querySelector('[data-app-action-sidebar-thread-selected="true"][data-app-action-sidebar-thread-id]');
      const value = active && active.getAttribute("data-app-action-sidebar-thread-id");
      if (!value) return undefined;
      const separator = value.indexOf(":");
      return separator >= 0 ? value.slice(separator + 1) : value;
    }

    function resolvedTheme() {
      const root = document.documentElement;
      if (root.classList.contains("electron-light")) return "light";
      if (root.classList.contains("electron-dark")) return "dark";
      const scheme = getComputedStyle(root).colorScheme.toLowerCase();
      return scheme.includes("light") && !scheme.includes("dark") ? "light" : "dark";
    }

    /**
     * Resolve a token to absolute pixels before forwarding it.
     *
     * The host states its radii in rem (build 6321: calc(.375rem * 1.25)), and
     * rem resolves against the *consuming* document's root font size. The Weft
     * surfaces set 13px where the host uses 16px, so forwarding the string made
     * every corner land 19% tighter than the host draws it — 6.09px against
     * 7.5px. Measuring the used value here is what makes the two agree.
     */
    function usedLength(value, rootFontSize) {
      // Percentages resolve against the box, not the font, so a zero-sized
      // probe would answer 0px. Leave those alone.
      if (!value || value.includes("%")) return value;
      const key = rootFontSize + "|" + value;
      const cached = state.usedLengths.get(key);
      if (cached !== undefined) return cached;
      const probe = document.createElement("div");
      probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
      probe.style.borderTopLeftRadius = value;
      document.documentElement.append(probe);
      const used = getComputedStyle(probe).borderTopLeftRadius || value;
      probe.remove();
      // Keyed by root font size so a zoom change re-measures instead of
      // serving a stale answer; the probe forces a layout, and context is
      // published on every mutation, so this must not run each time.
      state.usedLengths.set(key, used);
      return used;
    }

    function hostContext() {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const tokens = {};
      const rootFontSize = style.fontSize;
      for (const token of allowedTokens) {
        const value = style.getPropertyValue(token).trim();
        if (!value) continue;
        tokens[token] = token.startsWith("--radius") ? usedLength(value, rootFontSize) : value;
      }
      const sidebar = document.querySelector("[data-app-action-sidebar-scroll]");
      const sidebarCollapsed = !(sidebar instanceof HTMLElement) || sidebar.getBoundingClientRect().width < 40;
      const context = {
        version: 1,
        theme: resolvedTheme(),
        locale: root.lang || navigator.language || "en",
        tokens,
        mode: state.mode,
        view: state.view,
        filter: state.mode === "weft" ? "weft" : "off",
        stage: state.view,
        inspector: weftInspectorOpen() ? { issueId: state.inspectorIssueId } : null,
        conversation: conversationAllowed() ? state.popoverState : "closed",
        issueId: validIssueId(state.focusIssueId) ? state.focusIssueId : undefined,
        workspaceId: state.sidebarModel && validIssueId(state.sidebarModel.workspaceId) ? state.sidebarModel.workspaceId : undefined,
        dock: nativeDockOpen() ? "open" : "closed",
        rightOwner: weftInspectorOpen() ? "weft-inspector" : (nativeInspectorOpen() ? "native-inspector" : "none"),
        sidebarCollapsed,
        // "fallback" tells the sidebar to draw the search and inbox entries in
        // its own header: the capability must survive a host that no longer
        // offers a slot to put them in, even if the placement cannot.
        headerActions: state.headerActionsMounted ? "native" : "fallback",
        security: { cspBypass: state.cspBypass },
      };
      const threadId = activeThreadId();
      if (threadId) context.threadId = threadId;
      return context;
    }

    function frameForSource(source) {
      if (state.sidebarFrame && source === state.sidebarFrame.contentWindow) return state.sidebarFrame;
      if (state.workspaceFrame && source === state.workspaceFrame.contentWindow) return state.workspaceFrame;
      if (state.modalFrame && source === state.modalFrame.contentWindow) return state.modalFrame;
      if (state.popoverFrame && source === state.popoverFrame.contentWindow) return state.popoverFrame;
      if (state.inspectorFrame && source === state.inspectorFrame.contentWindow) return state.inspectorFrame;
      return null;
    }

    function postContext(frame, targetOrigin = childOrigin) {
      if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) return;
      frame.contentWindow.postMessage({
        source: "weft-codex-host",
        type: "weft:host-context",
        payload: hostContext(),
      }, targetOrigin);
    }

    function publishContext() {
      if (state.disposed) return;
      postContext(state.sidebarFrame);
      postContext(state.workspaceFrame);
      postContext(state.modalFrame);
      postContext(state.popoverFrame);
      postContext(state.inspectorFrame);
    }

    /**
     * Header entries are triggers only; the sidebar owns the panel. One-way and
     * unacknowledged on purpose — there is nothing for the host to do if the
     * frame is still loading except let the human click again.
     */
    function postSurfaceCommand(command) {
      const frame = state.sidebarFrame;
      if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) return;
      frame.contentWindow.postMessage({
        source: "weft-codex-host",
        type: "weft:host-command",
        version: 1,
        command,
      }, childOrigin);
    }

    function publishContextSoon() {
      if (state.contextTimer) window.clearTimeout(state.contextTimer);
      state.contextTimer = window.setTimeout(() => {
        state.contextTimer = 0;
        publishContext();
      }, 40);
    }

    function actionResult(frame, requestId, ok, error, result) {
      if (!(frame instanceof HTMLIFrameElement) || !frame.contentWindow) return;
      const payload = { source: "weft-codex-host", type: "weft:host-action-result", requestId, ok };
      if (error) payload.error = error;
      if (result !== undefined) payload.result = result;
      frame.contentWindow.postMessage(payload, childOrigin);
    }

    function deliverActionResult(requestId, response) {
      if (typeof requestId !== "string" || !response || typeof response !== "object") return false;
      const frame = state.pendingActions.get(requestId);
      if (!(frame instanceof HTMLIFrameElement)) return false;
      state.pendingActions.delete(requestId);
      const ok = response.ok === true;
      const error = typeof response.error === "string" ? response.error : undefined;
      actionResult(frame, requestId, ok, error, response.result);
      return true;
    }

    function validThreadId(value) {
      return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
    }

    function nativeThreadRow(threadId) {
      const rows = [...document.querySelectorAll("[data-app-action-sidebar-thread-id]")];
      return rows.find((candidate) => {
        if (candidate.hasAttribute("data-weft-codex-native-row")) return false;
        const value = candidate.getAttribute("data-app-action-sidebar-thread-id") || "";
        return value === threadId || value.endsWith(":" + threadId);
      });
    }

    function nativeThreadRowByTitle(title) {
      const needle = typeof title === "string" ? title.trim() : "";
      if (!needle) return null;
      const rows = [...document.querySelectorAll("[data-app-action-sidebar-thread-id]")];
      return rows.find((candidate) => {
        if (candidate.hasAttribute("data-weft-codex-native-row")) return false;
        const value = (candidate.getAttribute("data-app-action-sidebar-thread-title") || candidate.textContent || "").trim();
        if (value === needle) return true;
        return value.includes(needle) || /lead on issue:\s*/i.test(value) && value.includes(needle);
      }) || null;
    }

    async function openNativeThread(threadId) {
      for (const delay of THREAD_OPEN_RETRY_DELAYS) {
        if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (state.disposed) return false;
        const row = nativeThreadRow(threadId) || nativeThreadRowByTitle(state.pendingThreadTitle);
        if (!(row instanceof HTMLElement)) continue;
        const hidden = row.hasAttribute("data-weft-codex-native-thread");
        if (hidden) row.removeAttribute("data-weft-codex-native-thread");
        row.click();
        if (hidden) row.setAttribute("data-weft-codex-native-thread", "");
        setView("thread");
        return true;
      }
      return false;
    }

    function onFrameMessage(event) {
      if (event.origin !== childOrigin || !event.data || typeof event.data !== "object") return;
      const frame = frameForSource(event.source);
      if (!frame) return;
      const message = event.data;
      if (message.source !== "weft-codex-ui" || message.version !== 1) return;
      if (message.type === "weft:host-context-request") {
        state.readyFrames.add(frame.dataset.weftCodexSurface || "unknown");
        postContext(frame, event.origin);
        if (frame === state.modalFrame) postDialogState();
        notifyHost("frame.ready", { surface: frame.dataset.weftCodexSurface || "unknown" });
        return;
      }
      if (message.type !== "weft:host-action" || typeof message.requestId !== "string") return;
      if (message.action === "surface.label") {
        const label = typeof message.label === "string" ? message.label.trim() : "";
        if (!label || label.length > 120) {
          actionResult(frame, message.requestId, false, "invalid-surface-label");
          return;
        }
        frame.title = label;
        actionResult(frame, message.requestId, true);
        return;
      }
      if (message.action === "workspace.show") {
        setView("workspace");
        actionResult(frame, message.requestId, true);
        return;
      }
      if (message.action === "sidebar.sync") {
        const model = normalizeSidebarModel(message.model);
        if (!model) {
          actionResult(frame, message.requestId, false, "invalid-sidebar-model");
          return;
        }
        state.sidebarModel = model;
        syncNativeSidebar();
        actionResult(frame, message.requestId, true);
        return;
      }
      if (message.action === "dialog.present") {
        const accepted = presentDialog(message.dialog);
        actionResult(frame, message.requestId, accepted, accepted ? undefined : "invalid-dialog");
        return;
      }
      if (message.action === "dialog.mounted") {
        const accepted = frame === state.modalFrame && mountDialog();
        actionResult(frame, message.requestId, accepted, accepted ? undefined : "invalid-modal-surface");
        return;
      }
      if (message.action === "dialog.dismiss") {
        dismissDialog();
        actionResult(frame, message.requestId, true);
        return;
      }
      if (message.action === "popover.dismiss") {
        dismissPopover();
        actionResult(frame, message.requestId, true);
        return;
      }
      if (message.action === "inspector.open") {
        const accepted = openInspector(message.issueId);
        actionResult(frame, message.requestId, accepted, accepted ? undefined : "invalid-inspector");
        return;
      }
      if (message.action === "inspector.close") {
        closeInspector();
        actionResult(frame, message.requestId, true);
        return;
      }
      if (message.action === "inspector.mounted") {
        const accepted = frame === state.inspectorFrame && weftInspectorOpen();
        actionResult(frame, message.requestId, accepted, accepted ? undefined : "invalid-inspector-surface");
        return;
      }
      if (message.action === "thread.open") {
        if (!validThreadId(message.threadId)) {
          actionResult(frame, message.requestId, false, "invalid-thread-id");
          return;
        }
        const model = state.sidebarModel;
        const matched = model && Array.isArray(model.items)
          ? model.items.find((item) => item && item.threadId === message.threadId)
          : null;
        if (matched && matched.title) state.pendingThreadTitle = matched.title;
        void openNativeThread(message.threadId).then((opened) => {
          if (state.disposed) return;
          actionResult(frame, message.requestId, opened, opened ? undefined : "thread-not-in-native-sidebar");
          if (!opened) notifyHost("thread.open.missing", { threadId: message.threadId });
          // A conversation picked inside the panel navigates away from the
          // current thread; the panel has done its job (spec §3).
          if (opened && frame === state.popoverFrame) dismissPopover();
          // Arriving at a lead chat from the sidebar issue list is the one
          // context where the panel opens by default (spec §2.4).
          if (opened && frame === state.sidebarFrame && conversationAllowed()) setPopoverState("open-auto");
        }).catch(() => {
          if (!state.disposed) actionResult(frame, message.requestId, false, "thread-open-failed");
        });
        return;
      }
      if (message.action === "inbox.count") {
        // Only the sidebar owns this number; the workspace frame sees the same
        // board and would race it with a second, equally authoritative answer.
        if (frame !== state.sidebarFrame) {
          actionResult(frame, message.requestId, false, "inbox-count-not-from-sidebar");
          return;
        }
        if (typeof message.count !== "number" || !Number.isFinite(message.count)) {
          actionResult(frame, message.requestId, false, "invalid-inbox-count");
          return;
        }
        setInboxCount(message.count);
        actionResult(frame, message.requestId, true);
        return;
      }
      if (message.action === "repositories.pick") {
        state.pendingActions.set(message.requestId, frame);
        notifyHost("repositories.pick", { requestId: message.requestId });
      }
    }

    function onDocumentClick(event) {
      if (state.mode === "weft" && event.target instanceof Element) {
        const createWrap = event.target.closest("[data-weft-codex-native-header-action]");
        const createButton = event.target.closest("button");
        if (
          createWrap instanceof HTMLElement
          && createButton instanceof HTMLElement
          && createWrap.contains(createButton)
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
          setView("workspace");
          postSidebarCommand({ command: "issue.create" });
          return;
        }
        const row = event.target.closest("[data-weft-codex-native-row]");
        if (row instanceof HTMLElement) {
          event.preventDefault();
          event.stopPropagation();
          if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
          const key = row.dataset.weftCodexNativeKey;
          const model = state.sidebarModel;
          const next = model && Array.isArray(model.items)
            ? model.items.find((candidate) => candidate && candidate.key === key)
            : null;
          if (!next) return;
         if (next.kind === "issue") {
            if (weftInspectorOpen()) closeInspector({ keepNative: true });
            if (next.threadId) {
              state.pendingThreadTitle = next.title || "";
              if (validIssueId(next.issueId)) state.focusIssueId = next.issueId;
              void openNativeThread(next.threadId).then((opened) => {
                if (opened && conversationAllowed()) setPopoverState("open-auto");
                else postSidebarCommand({ command: "issue.open", issueId: next.issueId });
              });
              return;
            }
            state.pendingThreadTitle = next.title || "";
            if (validIssueId(next.issueId)) state.focusIssueId = next.issueId;
            postSidebarCommand({ command: "issue.open", issueId: next.issueId });
            return;
          }
          setView("workspace");
          if (next.kind === "workspace") {
            if (validIssueId(next.workspaceId)) {
              state.focusIssueId = null;
              if (weftInspectorOpen()) closeInspector();
              if (state.popoverState !== "closed") dismissPopover();
              setView("workspace");
              postSidebarCommand({ command: "workspace.select", workspaceId: next.workspaceId });
            }
            return;
          }
          postSidebarCommand({ command: next.kind === "kanban" ? "kanban.show" : "repos.show" });
          return;
        }
      }
      const target = event.target instanceof Element ? event.target.closest('[role="menuitem"]') : null;
      if (!(target instanceof HTMLElement) || target.hasAttribute(MODE_ITEM_ATTR)) return;
      const menu = target.closest('[role="menu"]');
      if (!associatedModeMenu(menu)) return;
      const text = target.textContent || "";
      const leafLabel = [...target.querySelectorAll("span")]
        .find((span) => !span.querySelector("span") && (span.textContent || "").trim());
      const selectedLabel = (leafLabel && leafLabel.textContent || "").trim();
      const nextMode = /codex/i.test(text) ? "codex" : "work";
      // Restore our temporary Weft label during capture, before the native
      // Radix/React handler commits its own selected mode in the bubble phase.
      // Deferring this would overwrite the newly rendered ChatGPT/Codex label.
      setMode(nextMode);
      applyNativeModeButtonLabel(selectedLabel || (nextMode === "codex" ? "Codex" : "ChatGPT"));
    }

    function mount() {
      if (state.disposed || !document.documentElement) return;
      installStyles();
      ensureSidebarRoot();
      syncNativeSidebar();
      ensureWorkspaceRoot();
      ensureModalRoot();
      ensurePopoverRoot();
      ensureInspectorRoot();
      if (state.mode === "weft") ensurePopoverButton();
      syncNativeChrome();
      syncSlotGeometry();
      const nextModeButton = modeButton();
      if (state.modeButton !== nextModeButton) {
        restoreModeButton();
        state.modeButton = nextModeButton;
        if (state.mode === "weft" && nextModeButton) applyWeftModeButton(nextModeButton);
      } else if (state.mode === "weft" && nextModeButton) {
        applyWeftModeButton(nextModeButton);
      } else if (state.mode !== "weft" && nextModeButton) {
        const inferred = inferNativeMode(nextModeButton);
        if (inferred !== state.mode) state.mode = inferred;
      }
      if (nextModeButton) {
        markModeHeader(nextModeButton);
        ensureHeaderActions(nextModeButton);
      } else {
        removeHeaderActions();
        state.headerActionsMounted = false;
      }
      setDocumentState();
      syncModeMenus();
    }

    function scheduleMount() {
      if (state.mountTimer || state.disposed) return;
      state.mountTimer = window.setTimeout(() => {
        state.mountTimer = 0;
        mount();
      }, 0);
    }

    function start() {
      if (state.started || state.disposed || !document.documentElement) return;
      state.started = true;
      state.messageListener = onFrameMessage;
      state.clickListener = onDocumentClick;
      window.addEventListener("message", state.messageListener);
      document.addEventListener("click", state.clickListener, true);
      state.mutationObserver = new MutationObserver(() => {
        scheduleMount();
        publishContextSoon();
      });
      state.mutationObserver.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class", "lang", "style", "inert", "aria-hidden", "hidden"],
        childList: true,
        subtree: true,
      });
      state.resizeObserver = new ResizeObserver(() => {
        syncSlotGeometry();
        publishContextSoon();
      });
      state.resizeObserver.observe(document.documentElement);
      const rightPanel = nativeRightPanel();
      if (rightPanel instanceof HTMLElement) state.resizeObserver.observe(rightPanel);
      state.mediaQuery = matchMedia("(prefers-color-scheme: dark)");
      state.mediaListener = () => publishContextSoon();
      state.mediaQuery.addEventListener("change", state.mediaListener);
      mount();
      notifyHost("agent.ready", { tier: config.compatibilityTier });
    }

    function reloadFrames() {
      state.readyFrames.clear();
      state.modalVisible = false;
      syncModalRoot();
      if (state.sidebarFrame) state.sidebarFrame.src = surfaceUrl("sidebar");
      if (state.workspaceFrame) state.workspaceFrame.src = surfaceUrl("workspace");
      if (state.modalFrame) state.modalFrame.src = surfaceUrl("modal");
      if (state.popoverFrame) state.popoverFrame.src = surfaceUrl("popover");
      if (state.inspectorFrame) state.inspectorFrame.src = surfaceUrl("inspector");
    }

    function setCspBypass(enabled) {
      state.cspBypass = Boolean(enabled);
      setDocumentState();
      reloadFrames();
      publishContextSoon();
    }

    function status() {
      return {
        version: 1,
        mode: state.mode,
        view: state.view,
        tier: config.compatibilityTier,
        cspBypass: state.cspBypass,
        sidebarMounted: Boolean(state.sidebarRoot && state.sidebarRoot.isConnected),
        workspaceMounted: Boolean(state.workspaceRoot && state.workspaceRoot.isConnected),
        modalMounted: Boolean(state.modalRoot && state.modalRoot.isConnected),
        sidebarReady: state.readyFrames.has("sidebar"),
        workspaceReady: state.readyFrames.has("workspace"),
        modalReady: state.readyFrames.has("modal"),
        popoverMounted: Boolean(state.popoverRoot && state.popoverRoot.isConnected),
        popoverReady: state.readyFrames.has("popover"),
        inspectorMounted: Boolean(state.inspectorRoot && state.inspectorRoot.isConnected),
        inspectorReady: state.readyFrames.has("inspector"),
        nativeModeSwitcher: Boolean(state.modeButton),
        headerActions: state.headerActionsMounted ? "native" : "fallback",
        inboxCount: state.inboxCount,
      };
    }

    function dispose() {
      if (state.disposed) return;
      state.disposed = true;
      if (state.mountTimer) window.clearTimeout(state.mountTimer);
      if (state.contextTimer) window.clearTimeout(state.contextTimer);
      if (state.mutationObserver) state.mutationObserver.disconnect();
      if (state.resizeObserver) state.resizeObserver.disconnect();
      if (state.mediaQuery && state.mediaListener) state.mediaQuery.removeEventListener("change", state.mediaListener);
      if (state.messageListener) window.removeEventListener("message", state.messageListener);
      if (state.clickListener) document.removeEventListener("click", state.clickListener, true);
      state.pendingActions.clear();
      restoreModeButton();
      removeHeaderActions();
      restoreModalBackground();
      if (state.sidebarRoot) state.sidebarRoot.remove();
      if (state.workspaceRoot) state.workspaceRoot.remove();
      if (state.modalRoot) state.modalRoot.remove();
      if (state.popoverRoot) state.popoverRoot.remove();
      for (const element of document.querySelectorAll("[data-weft-codex-chats-bound]")) {
        element.removeEventListener("click", onWeftChatsClick, true);
        element.removeAttribute("data-weft-codex-chats-bound");
        element.removeAttribute("aria-expanded");
      }
      for (const element of document.querySelectorAll("[data-weft-codex-side-panel-bound]")) {
        element.removeEventListener("click", onNativeSidePanelClick, true);
        element.removeAttribute("data-weft-codex-side-panel-bound");
      }

      if (state.inspectorRoot) state.inspectorRoot.remove();
      for (const element of document.querySelectorAll("[data-weft-codex-hide-side-panel]")) {
        element.removeAttribute("data-weft-codex-hide-side-panel");
      }
      for (const element of document.querySelectorAll("[data-weft-codex-hide-native-diff]")) {
        element.removeAttribute("data-weft-codex-hide-native-diff");
      }
      const panel = document.querySelector('[data-app-shell-focus-area="right-panel"]');
      if (panel instanceof HTMLElement) {
        panel.style.removeProperty("width");
        panel.style.removeProperty("flex-basis");
        panel.style.removeProperty("flex-grow");
        panel.style.removeProperty("flex-shrink");
        panel.removeAttribute("data-weft-codex-resize-observed");
      }
      for (const element of document.querySelectorAll("[data-weft-codex-hide-thread-title]")) {
        element.removeAttribute("data-weft-codex-hide-thread-title");
      }
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      const root = document.documentElement;
      delete root.dataset.weftCodexMode;
      delete root.dataset.weftCodexView;
      delete root.dataset.weftCodexTier;
      delete root.dataset.weftCodexModeCapability;
      delete root.dataset.weftCodexHeaderActions;
      delete root.dataset.weftCodexCspBypass;
      delete root.dataset.weftCodexInspector;
      delete root.dataset.weftCodexRight;
      for (const element of document.querySelectorAll("[data-weft-codex-mode-header]")) {
        element.removeAttribute("data-weft-codex-mode-header");
      }
      for (const element of document.querySelectorAll("[data-weft-codex-native-header-action]")) {
        element.removeAttribute("data-weft-codex-native-header-action");
      }
      restoreNativeSidebar();
    }

    window[GLOBAL_KEY] = {
      version: 1,
      status,
      setMode,
      setCspBypass,
      reloadFrames,
      deliverActionResult,
      dispose,
    };
    if (document.documentElement) start();
    else document.addEventListener("readystatechange", start, { once: true });
  })();`
}
