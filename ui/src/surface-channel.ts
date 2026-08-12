import type {
  AppView,
  DialogSubmission,
  RepoImportResponse,
} from "@/types"
import type { UiSurface } from "@/surface"

export type SurfaceCommand = "workspace.create" | "issue.create"

export type SurfaceMessage =
  | { type: "surface.ready"; surface: UiSurface }
  | { type: "state.request" }
  | { type: "workspace.select"; workspaceId: number }
  | { type: "workspace.changed"; workspaceId: number | null }
  | { type: "navigate"; view: AppView; issueId: number | null; artifactId?: number | null }
  | { type: "route.changed"; view: AppView; issueId: number | null; artifactId?: number | null }
  | { type: "command"; command: SurfaceCommand }
  | { type: "dialog.submit"; requestId: string; submission: DialogSubmission }
  | { type: "dialog.result"; requestId: string; ok: true; result?: RepoImportResponse }
  | { type: "dialog.result"; requestId: string; ok: false; error: string }

export interface SurfaceChannel {
  post(message: SurfaceMessage): void
  subscribe(listener: (message: SurfaceMessage) => void): () => void
  close(): void
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0
}

function isRoute(value: unknown): value is AppView {
  return value === "kanban" || value === "repos" || value === "issue" || value === "artifact"
}

function isSurface(value: unknown): value is UiSurface {
  return value === "standalone" || value === "sidebar" || value === "workspace" || value === "modal"
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128
}

function isIssueKind(value: unknown): boolean {
  return value === "feature" || value === "bugfix" || value === "refactor" || value === "spike"
}

function isMessageIntent(value: unknown): boolean {
  return value === "message" || value === "continue"
}

function isDialogSubmission(value: unknown): value is DialogSubmission {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate.type === "workspace") {
    return typeof candidate.name === "string" && candidate.name.length <= 120
  }
  if (candidate.type === "issue") {
    return typeof candidate.title === "string" && candidate.title.length <= 120 && isIssueKind(candidate.kind)
  }
  if (candidate.type === "repositories") {
    return Array.isArray(candidate.paths) && candidate.paths.every((path) => typeof path === "string")
  }
  if (candidate.type !== "message") return false
  if (candidate.target !== "lead" && candidate.target !== "task") return false
  return (
    isPositiveInteger(candidate.id) &&
    typeof candidate.text === "string" &&
    candidate.text.length <= 20_000 &&
    isMessageIntent(candidate.intent)
  )
}

function isRepoImportResponse(value: unknown): value is RepoImportResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return (
    Array.isArray(candidate.results) &&
    typeof candidate.added === "number" &&
    typeof candidate.existing === "number" &&
    typeof candidate.failed === "number" &&
    typeof candidate.analysisQueued === "boolean"
  )
}

function hasValidRoute(candidate: Record<string, unknown>): boolean {
  if (!isRoute(candidate.view)) return false
  if (candidate.view === "issue") return isPositiveInteger(candidate.issueId)
  if (candidate.view === "artifact") {
    // The target is the artifact; the issue id rides along for context and may
    // legitimately be absent. This guard rejects cross-frame messages, so the
    // required field stays required.
    if (!isPositiveInteger(candidate.artifactId)) return false
    return candidate.issueId === null || isPositiveInteger(candidate.issueId)
  }
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
  if (candidate.type === "command") {
    return candidate.command === "workspace.create" || candidate.command === "issue.create"
  }
  if (candidate.type === "dialog.submit") {
    return isRequestId(candidate.requestId) && isDialogSubmission(candidate.submission)
  }
  if (candidate.type !== "dialog.result" || !isRequestId(candidate.requestId)) return false
  if (candidate.ok === false) return typeof candidate.error === "string"
  if (candidate.ok !== true) return false
  return candidate.result === undefined || isRepoImportResponse(candidate.result)
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
