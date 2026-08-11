import * as React from "react"

import { languageFromLocale, type Language } from "@/i18n"

const ALLOWED_TOKENS = new Set([
  "--vscode-sideBar-background",
  "--vscode-button-hoverBackground",
  "--vscode-focusBorder",
  "--vscode-font-family",
  "--vscode-editor-font-family",
  "--color-token-main-surface-primary",
  "--color-token-dropdown-background",
  "--color-token-border",
  "--color-token-border-heavy",
  "--color-token-foreground",
  "--color-token-text-secondary",
  "--color-token-text-link-foreground",
  "--color-token-input-placeholder-foreground",
  "--color-token-input-background",
  "--color-token-input-border",
  "--color-token-primary",
  "--color-token-button-foreground",
  "--color-token-list-hover-background",
  "--color-token-charts-yellow",
  "--color-token-charts-red",
  "--color-token-charts-green",
  "--font-sans",
  "--font-mono",
  "--radius-lg",
  "--radius-md",
  "--radius-sm",
])

const TOKEN_ALIASES: Record<string, string> = {
  "--vscode-font-family": "--font",
  "--vscode-editor-font-family": "--mono",
  "--font-sans": "--font",
  "--font-mono": "--mono",
  "--radius-lg": "--r-lg",
  "--radius-md": "--r-md",
  "--radius-sm": "--r-sm",
}

export interface HostContextV1 {
  version: 1
  theme: "light" | "dark"
  locale: string
  tokens: Record<string, string>
  mode: "work" | "codex" | "weft"
  view?: "workspace" | "thread"
  projectId?: string
  threadId?: string
  sidebarCollapsed: boolean
  /**
   * Where the search and inbox entries render. "native" means the host put them
   * in its own sidebar header; "fallback" means it could not, and the sidebar
   * must draw its own pair. Absent on hosts that predate the capability, which
   * read the same as "fallback".
   */
  headerActions?: "native" | "fallback"
  security?: {
    cspBypass: boolean
  }
}

export type HostAction =
  | { action: "workspace.show" }
  | { action: "thread.open"; threadId: string }
  | { action: "repositories.pick" }
  | { action: "inbox.count"; count: number }

/** Host → UI, the opposite direction from HostAction: a trigger, not a request. */
export type HostCommand = "search.open" | "inbox.open"

interface PendingRepositoryAction {
  resolve(paths: string[]): void
  reject(error: Error): void
  timeout: number
}

interface PendingThreadAction {
  resolve(): void
  reject(error: Error): void
  timeout: number
}

const pendingRepositoryActions = new Map<string, PendingRepositoryAction>()
const pendingThreadActions = new Map<string, PendingThreadAction>()
let hostResultListenerInstalled = false

interface HostContextEnvelope {
  source: "weft-codex-host"
  type: "weft:host-context"
  payload: HostContextV1
}

function isHostContext(value: unknown): value is HostContextV1 {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<HostContextV1>
  if (candidate.version !== 1) return false
  if (candidate.theme !== "light" && candidate.theme !== "dark") return false
  if (typeof candidate.locale !== "string") return false
  if (!candidate.tokens || typeof candidate.tokens !== "object" || Array.isArray(candidate.tokens)) return false
  if (!Object.values(candidate.tokens).every((token) => typeof token === "string")) return false
  if (candidate.mode !== "work" && candidate.mode !== "codex" && candidate.mode !== "weft") return false
  if (candidate.view !== undefined && candidate.view !== "workspace" && candidate.view !== "thread") return false
  if (candidate.projectId !== undefined && typeof candidate.projectId !== "string") return false
  if (candidate.threadId !== undefined && typeof candidate.threadId !== "string") return false
  if (
    candidate.headerActions !== undefined &&
    candidate.headerActions !== "native" &&
    candidate.headerActions !== "fallback"
  ) return false
  if (candidate.security !== undefined) {
    if (!candidate.security || typeof candidate.security !== "object") return false
    if (typeof candidate.security.cspBypass !== "boolean") return false
  }
  return typeof candidate.sidebarCollapsed === "boolean"
}

function isHostEnvelope(value: unknown): value is HostContextEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<HostContextEnvelope>
  return (
    candidate.source === "weft-codex-host" &&
    candidate.type === "weft:host-context" &&
    isHostContext(candidate.payload)
  )
}

function applyHostContext(context: HostContextV1) {
  const root = document.documentElement
  root.dataset.hostTheme = context.theme
  root.dataset.hostCspBypass = context.security?.cspBypass ? "true" : "false"
  root.style.colorScheme = context.theme
  for (const [token, value] of Object.entries(context.tokens)) {
    if (ALLOWED_TOKENS.has(token) && typeof value === "string") {
      root.style.setProperty(token, value)
      const alias = TOKEN_ALIASES[token]
      if (alias) root.style.setProperty(alias, value)
    }
  }
}

function standaloneLanguage(): Language {
  const declared = document.documentElement.lang
  return languageFromLocale(declared || navigator.language || "en")
}

function expectedHostOrigin(): string | null {
  const configured = new URLSearchParams(window.location.search).get("host_origin")
  if (!configured) return window.location.origin
  try {
    const origin = new URL(configured).origin
    return origin === "null" ? null : origin
  } catch {
    return null
  }
}

export function requestHostAction(action: HostAction): boolean {
  const hostOrigin = expectedHostOrigin()
  if (!hostOrigin || window.parent === window) return false
  const requestId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  window.parent.postMessage({
    source: "weft-codex-ui",
    type: "weft:host-action",
    version: 1,
    requestId,
    ...action,
  }, hostOrigin)
  return true
}

export function hasHostBridge(): boolean {
  return Boolean(expectedHostOrigin()) && window.parent !== window
}

/**
 * How many things are waiting on the human, published so the host can badge the
 * entry it renders. One-way: the sidebar owns the number, the host only paints
 * it, so there is nothing to await and a dropped update self-corrects on the
 * next board refresh.
 */
export function reportInboxCount(count: number): boolean {
  if (!Number.isFinite(count) || count < 0) return false
  return requestHostAction({ action: "inbox.count", count: Math.floor(count) })
}

function isHostCommand(value: unknown): value is HostCommand {
  return value === "search.open" || value === "inbox.open"
}

/**
 * Subscribe to the host's header entries. The buttons live in the host document
 * because that is where the slot is, but the panels they open belong here —
 * spec §7.6 keeps the renderer a thin surface agent, not a second renderer of
 * Weft data.
 */
export function useHostCommand(handler: (command: HostCommand) => void): void {
  const latest = React.useRef(handler)
  latest.current = handler

  React.useEffect(() => {
    const hostOrigin = expectedHostOrigin()
    if (!hostOrigin || window.parent === window) return

    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== hostOrigin) return
      if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return
      const message = event.data as Record<string, unknown>
      if (message.source !== "weft-codex-host" || message.type !== "weft:host-command") return
      if (message.version !== 1 || !isHostCommand(message.command)) return
      latest.current(message.command)
    }

    window.addEventListener("message", onMessage)
    return () => window.removeEventListener("message", onMessage)
  }, [])
}

function ensureHostResultListener() {
  if (hostResultListenerInstalled) return
  hostResultListenerInstalled = true
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const hostOrigin = expectedHostOrigin()
    if (!hostOrigin || event.source !== window.parent || event.origin !== hostOrigin) return
    if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return
    const message = event.data as Record<string, unknown>
    if (message.source !== "weft-codex-host" || message.type !== "weft:host-action-result") return
    if (typeof message.requestId !== "string") return
    const pendingThread = pendingThreadActions.get(message.requestId)
    if (pendingThread) {
      pendingThreadActions.delete(message.requestId)
      window.clearTimeout(pendingThread.timeout)
      if (message.ok === true) pendingThread.resolve()
      else {
        const detail = typeof message.error === "string" ? message.error : "Host action failed"
        pendingThread.reject(new Error(detail))
      }
      return
    }
    const pending = pendingRepositoryActions.get(message.requestId)
    if (!pending) return
    pendingRepositoryActions.delete(message.requestId)
    window.clearTimeout(pending.timeout)
    if (message.ok !== true) {
      const detail = typeof message.error === "string" ? message.error : "Host action failed"
      pending.reject(new Error(detail))
      return
    }
    const result = message.result
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      pending.resolve([])
      return
    }
    const paths = (result as Record<string, unknown>).paths
    if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) {
      pending.reject(new Error("Host returned invalid repository paths"))
      return
    }
    pending.resolve(paths)
  })
}

export function pickRepositoryPaths(): Promise<string[]> | null {
  const hostOrigin = expectedHostOrigin()
  if (!hostOrigin || window.parent === window) return null
  ensureHostResultListener()
  const requestId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return new Promise<string[]>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRepositoryActions.delete(requestId)
      reject(new Error("Repository picker timed out"))
    }, 120_000)
    pendingRepositoryActions.set(requestId, { resolve, reject, timeout })
    window.parent.postMessage({
      source: "weft-codex-ui",
      type: "weft:host-action",
      version: 1,
      requestId,
      action: "repositories.pick",
    }, hostOrigin)
  })
}

export function requestThreadOpen(threadId: string): Promise<void> | null {
  const hostOrigin = expectedHostOrigin()
  if (!hostOrigin || window.parent === window) return null
  ensureHostResultListener()
  const requestId = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return new Promise<void>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingThreadActions.delete(requestId)
      reject(new Error("Thread open timed out"))
    }, 10_000)
    pendingThreadActions.set(requestId, { resolve, reject, timeout })
    window.parent.postMessage({
      source: "weft-codex-ui",
      type: "weft:host-action",
      version: 1,
      requestId,
      action: "thread.open",
      threadId,
    }, hostOrigin)
  })
}

export function useHostContext(): { lang: Language; context: HostContextV1 | null } {
  const [lang, setLang] = React.useState<Language>(standaloneLanguage)
  const [context, setContext] = React.useState<HostContextV1 | null>(null)

  React.useEffect(() => {
    const hostOrigin = expectedHostOrigin()

    const onMessage = (event: MessageEvent<unknown>) => {
      if (!hostOrigin || event.source !== window.parent || event.origin !== hostOrigin) return
      if (!isHostEnvelope(event.data)) return
      applyHostContext(event.data.payload)
      setContext(event.data.payload)
      setLang(languageFromLocale(event.data.payload.locale))
    }

    window.addEventListener("message", onMessage)
    if (hostOrigin && window.parent !== window) {
      window.parent.postMessage(
        { source: "weft-codex-ui", type: "weft:host-context-request", version: 1 },
        hostOrigin,
      )
    }
    return () => window.removeEventListener("message", onMessage)
  }, [])

  return { lang, context }
}
