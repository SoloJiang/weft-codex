export const STATUSES = ["queued", "planning", "working", "review", "done"] as const

export type DirectionStatus = (typeof STATUSES)[number]
export type AppView = "kanban" | "repos" | "issue"
export type MessageIntent = "message" | "continue"

export interface Workspace {
  id: number
  name: string
  slug: string
  created_at: string
}

export interface Repo {
  id: number
  workspace_id: number
  name: string
  path: string
  base_ref: string
  created_at: string
}

export interface Issue {
  id: number
  workspace_id: number
  title: string
  slug: string
  lead_codex_thread_id: string
  created_at: string
}

export interface Direction {
  id: number
  issue_id: number
  name: string
  slug: string
  branch: string
  status: DirectionStatus
  repo_id: number
  reason: string
  mandate: string
  target_branch: string
  base_branch: string
  spec: string
  codex_thread_id: string
  attention: number
  attention_reason: string
  created_at: string
}

export interface BoardEntry {
  issue: Issue
  directions: Direction[]
}

export interface RepoProfile {
  repo_id: number
  run_state: "idle" | "running" | "failed" | "done"
  run_error: string
  tier: string
  stack: string
  summary: string
  components: string
  layer: string
  layer_rank: number
  codex_thread_id: string
  updated_at: string
}

export interface RepoMapEntry {
  repo: Repo
  profile: RepoProfile | null
}

export interface RepoRelation {
  id: number
  workspace_id: number
  from_repo: string
  to_repo: string
  kind: string
  via: string
  confidence: number
  rationale: string
}

export interface RepoMap {
  repos: RepoMapEntry[]
  relations: RepoRelation[]
  repoMap: string
}

export interface BusMessage {
  id: number
  from_party: string
  to_party: string
  text: string
  kind: string
  ts: string
}

export type DialogState =
  | { type: "workspace" }
  | { type: "message"; target: "lead" | "task"; id: number; intent: MessageIntent }
  | null

export type ToastKind = "info" | "success" | "error"
