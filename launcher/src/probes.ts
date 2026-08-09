import type { CdpSession } from "./cdp.js"

export type CompatibilityTier = "safe-mode" | "additive" | "weft-mode"

export interface CapabilityProbe {
  id: string
  ok: boolean
  detail: string
  requiredFor: "base" | "additive" | "subtractive" | "optional"
}

export interface ProbeReport {
  tier: CompatibilityTier
  probes: CapabilityProbe[]
}

interface RuntimeEvaluateResult {
  result?: {
    value?: unknown
    description?: string
  }
  exceptionDetails?: unknown
}

interface RendererSnapshot {
  selectors: Record<string, boolean>
  tokens: Record<string, string>
  modeSwitcher: boolean
  titlebarDragRegion: boolean
  locale: string
}

const SELECTORS = {
  "renderer.root": "#root",
  "renderer.main": "main",
  "sidebar.scroll": "[data-app-action-sidebar-scroll]",
  "sidebar.section": "[data-app-action-sidebar-section]",
  "sidebar.heading": "[data-app-action-sidebar-section-heading]",
  "sidebar.projectCreate": "[data-app-action-sidebar-project-create]",
  "sidebar.threadRow": "[data-app-action-sidebar-thread-row]",
  "sidebar.threadRoute": "[data-app-action-sidebar-thread-id]",
} as const

export const TOKEN_PROBES = {
  "theme.sidebarSurface": "--vscode-sideBar-background",
  "theme.mainSurface": "--color-token-main-surface-primary",
  "theme.dropdownSurface": "--color-token-dropdown-background",
  "theme.foreground": "--color-token-foreground",
  "theme.secondaryText": "--color-token-text-secondary",
  "theme.border": "--color-token-border",
  "theme.borderHeavy": "--color-token-border-heavy",
  "theme.primary": "--color-token-primary",
  "theme.buttonForeground": "--color-token-button-foreground",
  "theme.linkForeground": "--color-token-text-link-foreground",
  "theme.inputBackground": "--color-token-input-background",
  "theme.inputBorder": "--color-token-input-border",
  "theme.hoverBackground": "--color-token-list-hover-background",
  "theme.fontSans": "--font-sans",
  "theme.fontMono": "--font-mono",
  "theme.radiusLarge": "--radius-lg",
  "theme.radiusMedium": "--radius-md",
  "theme.radiusSmall": "--radius-sm",
} as const

export const ALLOWED_CODEX_TOKENS = [
  ...Object.values(TOKEN_PROBES),
  "--vscode-button-hoverBackground",
  "--vscode-focusBorder",
  "--vscode-font-family",
  "--vscode-editor-font-family",
  "--color-token-input-placeholder-foreground",
  "--color-token-charts-yellow",
  "--color-token-charts-red",
  "--color-token-charts-green",
] as const

function selectorProbe(
  snapshot: RendererSnapshot,
  id: keyof typeof SELECTORS,
  requiredFor: CapabilityProbe["requiredFor"],
): CapabilityProbe {
  const ok = snapshot.selectors[id] === true
  return {
    id,
    ok,
    detail: ok ? SELECTORS[id] : `Missing ${SELECTORS[id]}`,
    requiredFor,
  }
}

function tokenProbe(snapshot: RendererSnapshot, id: string, token: string): CapabilityProbe {
  const value = snapshot.tokens[token]?.trim() ?? ""
  return {
    id,
    ok: Boolean(value),
    detail: value || `Missing ${token}`,
    requiredFor: "additive",
  }
}

export function classifyCompatibility(probes: CapabilityProbe[]): CompatibilityTier {
  if (probes.some((probe) => probe.requiredFor === "base" && !probe.ok)) return "safe-mode"
  if (probes.some((probe) => probe.requiredFor === "additive" && !probe.ok)) return "safe-mode"
  if (probes.some((probe) => probe.requiredFor === "subtractive" && !probe.ok)) return "additive"
  return "weft-mode"
}

export function reportFromSnapshot(snapshot: RendererSnapshot): ProbeReport {
  const probes: CapabilityProbe[] = [
    selectorProbe(snapshot, "renderer.root", "base"),
    selectorProbe(snapshot, "renderer.main", "base"),
    selectorProbe(snapshot, "sidebar.scroll", "base"),
    selectorProbe(snapshot, "sidebar.section", "base"),
    selectorProbe(snapshot, "sidebar.heading", "additive"),
    ...Object.entries(TOKEN_PROBES).map(([id, token]) => tokenProbe(snapshot, id, token)),
    selectorProbe(snapshot, "sidebar.projectCreate", "optional"),
    selectorProbe(snapshot, "sidebar.threadRow", "optional"),
    selectorProbe(snapshot, "sidebar.threadRoute", "optional"),
    {
      id: "mode.switcher",
      ok: snapshot.modeSwitcher,
      detail: snapshot.modeSwitcher
        ? "Sidebar mode menu trigger"
        : "Missing one semantic sidebar mode menu trigger",
      requiredFor: "subtractive",
    },
    {
      id: "host.locale",
      ok: Boolean(snapshot.locale.trim()),
      detail: snapshot.locale.trim() || "Document locale is empty",
      requiredFor: "additive",
    },
    {
      id: "titlebar.dragRegion",
      ok: snapshot.titlebarDragRegion,
      detail: snapshot.titlebarDragRegion
        ? "Native titlebar drag region preserved"
        : "No native titlebar drag region detected",
      requiredFor: "optional",
    },
  ]
  return { tier: classifyCompatibility(probes), probes }
}

export async function probeRenderer(session: CdpSession): Promise<ProbeReport> {
  const expression = `(() => {
    const selectors = ${JSON.stringify(SELECTORS)};
    const tokens = ${JSON.stringify(ALLOWED_CODEX_TOKENS)};
    const rootStyle = getComputedStyle(document.documentElement);
    const sidebar = document.querySelector(selectors["sidebar.scroll"]);
    const navigation = sidebar?.closest("nav");
    const modeButtons = navigation
      ? [...navigation.querySelectorAll('button[aria-haspopup="menu"][aria-expanded][data-state]')]
          .filter((button) => !sidebar.contains(button))
      : [];
    const titlebarDragRegion = [...document.querySelectorAll("header, header *")].some((element) =>
      getComputedStyle(element).getPropertyValue("-webkit-app-region") === "drag"
    );
    return {
      selectors: Object.fromEntries(Object.entries(selectors).map(([id, selector]) => [id, Boolean(document.querySelector(selector))])),
      tokens: Object.fromEntries(tokens.map((token) => [token, rootStyle.getPropertyValue(token)])),
      modeSwitcher: modeButtons.length === 1,
      titlebarDragRegion,
      locale: document.documentElement.lang || navigator.language || "",
    };
  })()`
  const response = await session.send<RuntimeEvaluateResult>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (response.exceptionDetails) throw new Error("Renderer capability probe threw an exception")
  const value = response.result?.value
  if (!value || typeof value !== "object") {
    throw new Error(response.result?.description || "Renderer capability probe returned no value")
  }
  return reportFromSnapshot(value as RendererSnapshot)
}
