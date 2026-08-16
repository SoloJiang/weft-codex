import type { AppView } from "@/types"

export type UiSurface = "standalone" | "sidebar" | "workspace" | "modal"

export interface SurfaceRoute {
  view: AppView
  issueId: number | null
  /** Only meaningful for the `artifact` view. */
  artifactId?: number | null
}

function positiveInteger(value: string | null): number | null {
  if (!value) return null
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) return null
  return parsed
}

export function readUiSurface(): UiSurface {
  const value = new URLSearchParams(window.location.search).get("surface")
  if (value === "sidebar" || value === "workspace" || value === "modal") return value
  return "standalone"
}

/**
 * The dedicated modal iframe is a transparent overlay. Chromium paints an
 * opaque black canvas when that document's `color-scheme` is `dark`, even if
 * html/body are `background: transparent`. Keep the document `normal` and put
 * the theme on the dialog card instead.
 */
export function documentColorScheme(
  surface: UiSurface,
  theme: "light" | "dark",
): "light" | "dark" | "normal" {
  if (surface === "modal") return "normal"
  return theme
}

export function readInitialWorkspaceId(): number | null {
  return positiveInteger(new URLSearchParams(window.location.search).get("workspace_id"))
}

export function readInitialRoute(): SurfaceRoute {
  const params = new URLSearchParams(window.location.search)
  const view = params.get("view")
  if (view === "repos") return { view: "repos", issueId: null }
  if (view === "artifact") {
    const artifactId = positiveInteger(params.get("artifact_id"))
    if (artifactId) return { view: "artifact", issueId: positiveInteger(params.get("issue_id")), artifactId }
  }
  if (view === "issue") {
    const issueId = positiveInteger(params.get("issue_id"))
    if (issueId) return { view: "issue", issueId }
  }
  return { view: "kanban", issueId: null }
}
