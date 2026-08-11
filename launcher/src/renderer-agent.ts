import { ALLOWED_CODEX_TOKENS, VISIBLE_MAIN_HELPERS_SOURCE } from "./probes.js"

export type HostMode = "work" | "codex" | "weft"

const SIDEBAR_ROOT_ID = "weft-codex-sidebar-root"
const WORKSPACE_ROOT_ID = "weft-codex-workspace-root"
const MODAL_ROOT_ID = "weft-codex-modal-root"
const NATIVE_CHECK_ATTR = "data-weft-codex-native-mode-check"

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
    const STYLE_ID = "weft-codex-host-style";
    const MODE_ITEM_ATTR = "data-weft-codex-mode-item";
    const NATIVE_CHECK_ATTR = "data-weft-codex-native-mode-check";
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
      modeButton: null,
      savedModeButton: null,
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

    function markModeHeader(button) {
      if (!(button instanceof HTMLElement)) return;
      const modeRow = button.parentElement;
      const header = modeRow && modeRow.parentElement;
      if (!(modeRow instanceof HTMLElement) || !(header instanceof HTMLElement)) return;
      modeRow.dataset.weftCodexModeHeader = "";
      for (const child of header.children) {
        if (!(child instanceof HTMLElement) || child === modeRow) continue;
        child.dataset.weftCodexNativeHeaderAction = "";
      }
    }

    function setDocumentState() {
      const root = document.documentElement;
      const values = {
        weftCodexMode: state.mode,
        weftCodexView: state.view,
        // Spec §7.5 splits mounting into Tier 1 (additive, native UI untouched)
        // and Tier 2 (weft-mode, subtractive). Publishing the tier here is what
        // lets the stylesheet fail open: every subtractive rule is scoped to
        // tier="weft-mode", so a failed subtractive probe cannot hide native UI.
        weftCodexTier: config.compatibilityTier,
        weftCodexModeCapability: state.modeButton ? "native" : "fallback",
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
      } else {
        dismissDialog();
        state.mode = nextMode;
        state.nativeMode = nextMode;
        state.view = "workspace";
        restoreModeButton();
      }
      setDocumentState();
      syncModeMenus();
      publishContextSoon();
      if (changed && persist) notifyHost("mode.changed", { mode: nextMode });
    }

    function setView(nextView) {
      if (nextView !== "workspace" && nextView !== "thread") return;
      if (state.view === nextView) return;
      state.view = nextView;
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
      if (surface === "sidebar") frame.title = "Workspace navigation";
      else if (surface === "modal") frame.title = "Dialog";
      else frame.title = "Workspace";
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
      root.dataset.open = open ? "true" : "false";
      root.setAttribute("aria-hidden", open ? "false" : "true");
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
      return true;
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
      const mainRect = mainRoute.getBoundingClientRect();
      const dragRegions = [...mainRoute.querySelectorAll("header, header *")].filter((element) =>
        getComputedStyle(element).getPropertyValue("-webkit-app-region") === "drag"
      );
      let top = 0;
      for (const region of dragRegions) {
        const rect = region.getBoundingClientRect();
        top = Math.max(top, rect.bottom - mainRect.top);
      }
      const topValue = Math.max(0, Math.round(top)) + "px";
      if (root.style.top !== topValue) root.style.top = topValue;
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
        #${MODAL_ROOT_ID} > iframe {
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
          inset-inline: 0;
          bottom: 0;
          z-index: 20;
          display: none;
          min-width: 0;
          min-height: 0;
          overflow: hidden;
          background: var(--color-token-main-surface-primary);
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
           on tier="weft-mode"; a failed subtractive probe leaves the host UI
           untouched instead of hiding it (spec §7.5 fail-open). */
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] [data-app-action-sidebar-scroll] {
          gap: 0 !important;
          overflow: hidden !important;
          background: transparent !important;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] #${SIDEBAR_ROOT_ID},
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] #${SIDEBAR_ROOT_ID} > iframe {
          background: transparent !important;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] [data-weft-codex-native-header-action] {
          display: none !important;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] [data-app-action-sidebar-scroll] > :not(#${SIDEBAR_ROOT_ID}) {
          display: none !important;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] #${SIDEBAR_ROOT_ID} {
          display: flex;
          flex: 1 1 auto;
          height: 100%;
        }
        html[data-weft-codex-tier="weft-mode"][data-weft-codex-mode="weft"] #${SIDEBAR_ROOT_ID} > iframe {
          display: block;
          flex: 1 1 auto;
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
      const active = document.querySelector('[data-app-action-sidebar-thread-active="true"][data-app-action-sidebar-thread-id]');
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

    function hostContext() {
      const root = document.documentElement;
      const style = getComputedStyle(root);
      const tokens = {};
      for (const token of allowedTokens) {
        const value = style.getPropertyValue(token).trim();
        if (value) tokens[token] = value;
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
        sidebarCollapsed,
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
        const value = candidate.getAttribute("data-app-action-sidebar-thread-id") || "";
        return value === threadId || value.endsWith(":" + threadId);
      });
    }

    async function openNativeThread(threadId) {
      for (const delay of THREAD_OPEN_RETRY_DELAYS) {
        if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));
        if (state.disposed) return false;
        const row = nativeThreadRow(threadId);
        if (!(row instanceof HTMLElement)) continue;
        row.click();
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
      if (message.action === "workspace.show") {
        setView("workspace");
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
      if (message.action === "thread.open") {
        if (!validThreadId(message.threadId)) {
          actionResult(frame, message.requestId, false, "invalid-thread-id");
          return;
        }
        void openNativeThread(message.threadId).then((opened) => {
          if (state.disposed) return;
          actionResult(frame, message.requestId, opened, opened ? undefined : "thread-not-in-native-sidebar");
          if (!opened) notifyHost("thread.open.missing", { threadId: message.threadId });
        }).catch(() => {
          if (!state.disposed) actionResult(frame, message.requestId, false, "thread-open-failed");
        });
        return;
      }
      if (message.action === "repositories.pick") {
        state.pendingActions.set(message.requestId, frame);
        notifyHost("repositories.pick", { requestId: message.requestId });
      }
    }

    function onDocumentClick(event) {
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
      ensureWorkspaceRoot();
      ensureModalRoot();
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
      if (nextModeButton) markModeHeader(nextModeButton);
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
      state.resizeObserver = new ResizeObserver(() => publishContextSoon());
      state.resizeObserver.observe(document.documentElement);
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
        nativeModeSwitcher: Boolean(state.modeButton),
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
      if (state.sidebarRoot) state.sidebarRoot.remove();
      if (state.workspaceRoot) state.workspaceRoot.remove();
      if (state.modalRoot) state.modalRoot.remove();
      const style = document.getElementById(STYLE_ID);
      if (style) style.remove();
      const root = document.documentElement;
      delete root.dataset.weftCodexMode;
      delete root.dataset.weftCodexView;
      delete root.dataset.weftCodexTier;
      delete root.dataset.weftCodexModeCapability;
      delete root.dataset.weftCodexCspBypass;
      for (const element of document.querySelectorAll("[data-weft-codex-mode-header]")) {
        element.removeAttribute("data-weft-codex-mode-header");
      }
      for (const element of document.querySelectorAll("[data-weft-codex-native-header-action]")) {
        element.removeAttribute("data-weft-codex-native-header-action");
      }
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
