import * as React from "react"

import { api, jsonRequest } from "@/api"
import { IssueDetailView } from "@/components/issue-detail-view"
import { openCodexThread } from "@/components/shared"
import type { WorkActions } from "@/components/kanban-view"
import type { HostContextV1 } from "@/host-context"
import { requestHostAction, requestInspectorClose } from "@/host-context"
import { useI18n } from "@/i18n"
import type { BoardEntry, Direction, Issue, Repo } from "@/types"

const EVENT_NAMES = [
  "direction.updated",
  "issue.updated",
  "bus.message",
  "thread.binding.updated",
]

function errorText(error: unknown, network: string, unknown: string): string {
  if (error instanceof TypeError) return network
  if (error instanceof Error && error.message) return error.message
  return unknown
}

function normalizeBoard(entries: BoardEntry[]): BoardEntry[] {
  return entries.map((entry) => ({
    ...entry,
    threads: Array.isArray(entry.threads) ? entry.threads : [],
  }))
}

export default function InspectorApp({ hostContext }: { hostContext: HostContextV1 | null }) {
  const { t } = useI18n()
  const [repos, setRepos] = React.useState<Repo[]>([])
  const [board, setBoard] = React.useState<BoardEntry[]>([])
  const [revision, setRevision] = React.useState(0)
  const [error, setError] = React.useState("")
  const loadSequence = React.useRef(0)
  const workspaceIdRef = React.useRef<number | null>(null)

  const issueId = hostContext?.inspector?.issueId ?? null

  React.useEffect(() => {
    requestHostAction({ action: "inspector.mounted" })
  }, [])

  const reportError = React.useCallback((caught: unknown) => {
    setError(t("err.prefix") + errorText(caught, t("err.network"), t("err.unknown")))
  }, [t])

  const loadIssue = React.useCallback(async (id: number) => {
    const sequence = loadSequence.current + 1
    loadSequence.current = sequence
    let found: BoardEntry | undefined
    let workspaceId = workspaceIdRef.current
    if (workspaceId) {
      const rows = normalizeBoard(await api<BoardEntry[]>(`/api/issues?workspace_id=${workspaceId}`))
      found = rows.find((candidate) => candidate.issue.id === id)
      if (!found) workspaceId = null
    }
    if (!found) {
      const workspaces = await api<Array<{ id: number }>>("/api/workspaces")
      for (const workspace of workspaces) {
        const rows = normalizeBoard(await api<BoardEntry[]>(`/api/issues?workspace_id=${workspace.id}`))
        const entry = rows.find((candidate) => candidate.issue.id === id)
        if (entry) {
          found = entry
          workspaceId = workspace.id
          break
        }
      }
    }
    if (loadSequence.current !== sequence) return
    if (!found || !workspaceId) {
      workspaceIdRef.current = null
      setBoard([])
      setRepos([])
      return
    }
    workspaceIdRef.current = workspaceId
    const workspaceRepos = await api<Repo[]>(`/api/workspaces/${workspaceId}/repos`)
    if (loadSequence.current !== sequence) return
    setBoard([found])
    setRepos(workspaceRepos)
    setRevision((current) => current + 1)
    setError("")
  }, [])

  React.useEffect(() => {
    if (!issueId) {
      setBoard([])
      setRepos([])
      return
    }
    void loadIssue(issueId).catch(reportError)
  }, [issueId, loadIssue, reportError])

  React.useEffect(() => {
    if (!issueId) return
    const source = new EventSource("/api/events")
    let timer: number | undefined
    const scheduleRefresh = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        loadIssue(issueId).catch(reportError)
      }, 300)
    }
    for (const name of EVENT_NAMES) source.addEventListener(name, scheduleRefresh)
    return () => {
      window.clearTimeout(timer)
      source.close()
    }
  }, [issueId, loadIssue, reportError])

  const launchLead = React.useCallback(async (targetIssueId: number) => {
    const started = await api<{ codexThreadId: string }>(`/api/issues/${targetIssueId}/spawn-lead`, jsonRequest("POST"))
    if (issueId) await loadIssue(issueId)
    window.setTimeout(() => {
      void openCodexThread(started.codexThreadId).catch(reportError)
    }, 0)
  }, [issueId, loadIssue, reportError])

  const workActions = React.useMemo<WorkActions>(() => ({
    onError: reportError,
    onStartLead: async (issue: Issue) => launchLead(issue.id),
    onRetryTask: async (direction: Direction) => {
      await api(`/api/directions/${direction.id}/spawn`, jsonRequest("POST"))
      if (issueId) await loadIssue(issueId)
    },
    onCompleteTask: async (direction: Direction) => {
      await api(`/api/directions/${direction.id}/complete`, jsonRequest("POST"))
      if (issueId) await loadIssue(issueId)
    },
    onClearAttention: async (direction: Direction) => {
      await api(`/api/directions/${direction.id}/attention/clear`, jsonRequest("POST"))
      if (issueId) await loadIssue(issueId)
    },
    onContinueTask: () => undefined,
  }), [issueId, launchLead, loadIssue, reportError])

  const entry = board.find((candidate) => candidate.issue.id === issueId)

  return (
    <div className="inspector-surface">
      <IssueDetailView
        entry={entry}
        repos={repos}
        revision={revision}
        actions={workActions}
        onBack={() => { requestInspectorClose() }}
        closeLabelKey="detail.close"
      />
      {error ? <p className="inspector-error" role="alert">{error}</p> : null}
    </div>
  )
}
