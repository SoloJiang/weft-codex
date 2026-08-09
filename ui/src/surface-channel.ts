import type { AppView } from "@/types"
import type { UiSurface } from "@/surface"

export type SurfaceCommand = "workspace.create" | "issue.create"

export type SurfaceMessage =
  | { type: "surface.ready"; surface: UiSurface }
  | { type: "state.request" }
  | { type: "workspace.select"; workspaceId: number }
  | { type: "workspace.changed"; workspaceId: number | null }
  | { type: "navigate"; view: AppView; issueId: number | null }
  | { type: "route.changed"; view: AppView; issueId: number | null }
  | { type: "command"; command: SurfaceCommand }

export interface SurfaceChannel {
  post(message: SurfaceMessage): void
  subscribe(listener: (message: SurfaceMessage) => void): () => void
  close(): void
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isRoute(value: unknown): value is AppView {
  return value === "kanban" || value === "repos" || value === "issue"
}

function isSurface(value: unknown): value is UiSurface {
  return value === "standalone" || value === "sidebar" || value === "workspace"
}

function hasValidRoute(candidate: Record<string, unknown>): boolean {
  if (!isRoute(candidate.view)) return false
  if (candidate.view === "issue") return isPositiveInteger(candidate.issueId)
  return candidate.issueId === null
}

function isSurfaceMessage(value: unknown): value is SurfaceMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.type === "surface.ready") return isSurface(candidate.surface)
  if (candidate.type === "state.request") return true
  if (candidate.type === "workspace.select") return isPositiveInteger(candidate.workspaceId)
  if (candidate.type === "workspace.changed") {
    return candidate.workspaceId === null || isPositiveInteger(candidate.workspaceId)
  }
  if (candidate.type === "navigate" || candidate.type === "route.changed") {
    return hasValidRoute(candidate)
  }
  if (candidate.type !== "command") return false
  return candidate.command === "workspace.create" || candidate.command === "issue.create"
}

function bridgeId(): string | null {
  const value = new URLSearchParams(window.location.search).get("bridge_id")?.trim()
  if (!value || value.length > 128 || !/^[a-zA-Z0-9._-]+$/.test(value)) return null
  return value
}

export function createSurfaceChannel(): SurfaceChannel | null {
  const id = bridgeId()
  if (!id || typeof BroadcastChannel === "undefined") return null

  const channel = new BroadcastChannel(`weft-codex:${id}`)
  let closed = false
  return {
    post(message) {
      if (closed) return
      channel.postMessage(message)
    },
    subscribe(listener) {
      if (closed) return () => {}
      const onMessage = (event: MessageEvent<unknown>) => {
        if (isSurfaceMessage(event.data)) listener(event.data)
      }
      channel.addEventListener("message", onMessage)
      return () => channel.removeEventListener("message", onMessage)
    },
    close() {
      if (closed) return
      closed = true
      channel.close()
    },
  }
}
