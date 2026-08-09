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
}

const SELECTORS = {
  "renderer.root": "#root",
  "sidebar.scroll": "[data-app-action-sidebar-scroll]",
  "sidebar.section": "[data-app-action-sidebar-section]",
  "sidebar.heading": "[data-app-action-sidebar-section-heading]",
  "sidebar.projectCreate": "[data-app-action-sidebar-project-create]",
  "sidebar.threadRow": "[data-app-action-sidebar-thread-row]",
} as const

const TOKEN_PROBES = {
  "theme.mainSurface": "--color-token-main-surface-primary",
  "theme.foreground": "--color-token-foreground",
  "theme.secondaryText": "--color-token-text-secondary",
  "theme.border": "--color-token-border",
  "theme.primary": "--color-token-primary",
} as const

const TOKENS = Object.values(TOKEN_PROBES)

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
    selectorProbe(snapshot, "sidebar.scroll", "base"),
    selectorProbe(snapshot, "sidebar.section", "base"),
    selectorProbe(snapshot, "sidebar.heading", "additive"),
    ...Object.entries(TOKEN_PROBES).map(([id, token]) => tokenProbe(snapshot, id, token)),
    selectorProbe(snapshot, "sidebar.projectCreate", "optional"),
    selectorProbe(snapshot, "sidebar.threadRow", "optional"),
    {
      id: "mode.switcher",
      ok: false,
      detail: "No semantic mode-switcher anchor is mapped for this release",
      requiredFor: "subtractive",
    },
  ]
  return { tier: classifyCompatibility(probes), probes }
}

export async function probeRenderer(session: CdpSession): Promise<ProbeReport> {
  const expression = `(() => {
    const selectors = ${JSON.stringify(SELECTORS)};
    const tokens = ${JSON.stringify(TOKENS)};
    const rootStyle = getComputedStyle(document.documentElement);
    return {
      selectors: Object.fromEntries(Object.entries(selectors).map(([id, selector]) => [id, Boolean(document.querySelector(selector))])),
      tokens: Object.fromEntries(tokens.map((token) => [token, rootStyle.getPropertyValue(token)])),
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
