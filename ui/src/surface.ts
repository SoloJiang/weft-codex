import type { AppView } from "@/types"

export type UiSurface = "standalone" | "sidebar" | "workspace" | "issue-panel"

export interface SurfaceRoute {
  view: AppView
  issueId: number | null
}

function positiveInteger(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

export function readUiSurface(): UiSurface {
  const value = new URLSearchParams(window.location.search).get("surface")
  if (value === "sidebar" || value === "workspace" || value === "issue-panel") return value
  return "standalone"
}

export function readInitialWorkspaceId(): number | null {
  return positiveInteger(new URLSearchParams(window.location.search).get("workspace_id"))
}

export function readInitialIssueId(): number | null {
  return positiveInteger(new URLSearchParams(window.location.search).get("issue_id"))
}

export function readInitialRoute(): SurfaceRoute {
  const params = new URLSearchParams(window.location.search)
  const view = params.get("view")
  if (view === "repos") return { view: "repos", issueId: null }
  if (view === "issue") {
    const issueId = positiveInteger(params.get("issue_id"))
    if (issueId) return { view: "issue", issueId }
  }
  return { view: "kanban", issueId: null }
}
