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
  security?: {
    cspBypass: boolean
  }
}

export type HostAction =
  | { action: "workspace.show" }
  | { action: "thread.open"; threadId: string }
  | { action: "repositories.pick" }
  | {
      action: "issue-panel.toggle"
      workspaceId: number
      issueId: number
      anchor: IssuePanelAnchor
    }
  | { action: "issue-panel.close" }
  | { action: "issue-panel.resize"; height: number }

export interface IssuePanelAnchor {
  top: number
  right: number
  bottom: number
  left: number
  width: number
  height: number
}

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
const issuePanelStateListeners = new Set<(issueId: number | null) => void>()
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

function ensureHostResultListener() {
  if (hostResultListenerInstalled) return
  hostResultListenerInstalled = true
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    const hostOrigin = expectedHostOrigin()
    if (!hostOrigin || event.source !== window.parent || event.origin !== hostOrigin) return
    if (!event.data || typeof event.data !== "object" || Array.isArray(event.data)) return
    const message = event.data as Record<string, unknown>
    if (message.source !== "weft-codex-host") return
    if (message.type === "weft:issue-panel-state") {
      const issueId = message.issueId
      if (issueId !== null && (typeof issueId !== "number" || !Number.isInteger(issueId) || issueId <= 0)) {
        return
      }
      for (const listener of issuePanelStateListeners) listener(issueId as number | null)
      return
    }
    if (message.type !== "weft:host-action-result") return
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

export function subscribeIssuePanelState(
  listener: (issueId: number | null) => void,
): () => void {
  ensureHostResultListener()
  issuePanelStateListeners.add(listener)
  return () => issuePanelStateListeners.delete(listener)
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
