import * as React from "react"

import { api, jsonRequest } from "@/api"
import { IssueConversationTree } from "@/components/conversation-tree"
import { openCodexThread } from "@/components/shared"
import type { HostContextV1 } from "@/host-context"
import { requestHostAction, requestInspectorOpen } from "@/host-context"
import { useI18n } from "@/i18n"
import { readInitialWorkspaceId } from "@/surface"
import type { BoardEntry, ThreadBinding, ThreadLocationResponse } from "@/types"

const POPOVER_EVENT_NAMES = [
  "direction.updated",
  "issue.updated",
  "thread.binding.updated",
  "bus.message",
]

interface Props {
  hostContext: HostContextV1 | null
}

function errorText(error: unknown, network: string, unknownText: string): string {
  if (error instanceof TypeError) return network
  if (error instanceof Error && error.message) return error.message
  return unknownText
}

function normalizeBoard(entries: BoardEntry[]): BoardEntry[] {
  return entries.map((entry) => ({
    ...entry,
    threads: Array.isArray(entry.threads) ? entry.threads : [],
  }))
}

/**
 * Conversation popover surface (spec 2026-08-13-lead-chat-conversation-popover).
 *
 * The floating "会话" panel attached to the Lead chat header. It resolves the
 * issue behind the host's active native thread and renders the same
 * conversation tree the sidebar used to host. It owns no expansion state —
 * the launcher-level agent owns closed / open-auto / open-pinned.
 */
export default function PopoverApp({ hostContext }: Props) {
  const { t } = useI18n()
  const [board, setBoard] = React.useState<BoardEntry[]>([])
  const [resolvedIssueId, setResolvedIssueId] = React.useState<number | null>(null)
  const [resolvedWorkspaceId, setResolvedWorkspaceId] = React.useState<number | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const loadSequence = React.useRef(0)

  const threadId = hostContext?.threadId ?? null
  const focusedIssueId = hostContext?.issueId ?? null
  const hostWorkspaceId = hostContext?.workspaceId ?? readInitialWorkspaceId()

  const reportError = React.useCallback((caught: unknown) => {
    setError(t("err.prefix") + errorText(caught, t("err.network"), t("err.unknown")))
  }, [t])

  // Resolve the active native thread to its issue. Falls back to scanning the
  // board when the thread is the lead's primary (already bound server-side),
  // and to the resolve endpoint for forks that may not be on the board yet.
  React.useEffect(() => {
    if (!threadId) {
      setResolvedIssueId(null)
      setResolvedWorkspaceId(null)
      setLoading(false)
      return
    }
    let cancelled = false
    const sequence = loadSequence.current + 1
    loadSequence.current = sequence
    setLoading(true)
    setError("")

    const resolve = async () => {
      try {
        const response = await api<ThreadLocationResponse>(
          "/api/threads/resolve",
          jsonRequest("POST", { thread_id: threadId }),
        )
        if (cancelled || loadSequence.current !== sequence) return
        if (response.binding && response.workspaceId) {
          setResolvedIssueId(response.binding.issue_id)
          setResolvedWorkspaceId(response.workspaceId)
          return
        }
      } catch {
        // Fall through to the board scan — the thread may be a freshly
        // started lead that the resolve endpoint has not seen yet.
      }
      if (cancelled || loadSequence.current !== sequence) return
      setResolvedIssueId(focusedIssueId)
      setResolvedWorkspaceId(hostWorkspaceId)
    }
    void resolve()
    return () => { cancelled = true }
  }, [focusedIssueId, threadId, hostWorkspaceId])

  const workspaceId = resolvedWorkspaceId ?? hostWorkspaceId

  const loadBoard = React.useCallback(async (id: number) => {
    const rows = await api<BoardEntry[]>(`/api/issues?workspace_id=${id}`)
    setBoard(normalizeBoard(rows))
  }, [])

  React.useEffect(() => {
    if (!workspaceId) {
      setBoard([])
      setLoading(false)
      return
    }
    setLoading(true)
    loadBoard(workspaceId)
      .catch(reportError)
      .finally(() => setLoading(false))
  }, [workspaceId, loadBoard, reportError])

  React.useEffect(() => {
    if (!workspaceId) return
    const source = new EventSource("/api/events")
    let timer: number | undefined
    const scheduleRefresh = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        loadBoard(workspaceId).catch(reportError)
      }, 300)
    }
    for (const name of POPOVER_EVENT_NAMES) source.addEventListener(name, scheduleRefresh)
    return () => {
      window.clearTimeout(timer)
      source.close()
    }
  }, [workspaceId, loadBoard, reportError])

  const entry: BoardEntry | undefined = React.useMemo(() => {
    if (resolvedIssueId) return board.find((candidate) => candidate.issue.id === resolvedIssueId)
    if (focusedIssueId) {
      const focused = board.find((candidate) => candidate.issue.id === focusedIssueId)
      if (focused) return focused
    }
    if (!threadId) return undefined
    // Lead primary threads are always on the board; use them before the
    // resolve endpoint catches up.
    for (const candidate of board) {
      if (candidate.threads.some((binding: ThreadBinding) => binding.thread_id === threadId)) {
        return candidate
      }
      if (candidate.issue.lead_codex_thread_id === threadId) return candidate
    }
    return undefined
  }, [board, focusedIssueId, resolvedIssueId, threadId])

  const openThread = React.useCallback((nextThreadId: string) => {
    setError("")
    void openCodexThread(nextThreadId).catch(() => {
      setError(t("err.prefix") + t("err.threadOpen"))
    })
  }, [t])

  const promoteLead = React.useCallback(async (issueId: number, forkThreadId: string) => {
    await api(`/api/issues/${issueId}/lead-thread`, jsonRequest("POST", { thread_id: forkThreadId }))
    if (workspaceId) await loadBoard(workspaceId)
  }, [workspaceId, loadBoard])

  const close = React.useCallback(() => {
    requestHostAction({ action: "popover.dismiss" })
  }, [])

  let body: React.ReactNode
  if (!threadId) {
    body = <p className="popover-empty">{t("popover.noThread")}</p>
  } else if (loading && !entry) {
    body = <p className="popover-empty" role="status">{t("app.loading")}</p>
  } else if (!entry) {
    body = <p className="popover-empty">{t("popover.notWeft")}</p>
  } else {
    body = (
      <IssueConversationTree
        entry={entry}
        activeThreadId={threadId}
        onOpenThread={openThread}
        onPromoteLead={(forkThreadId) => promoteLead(entry.issue.id, forkThreadId)}
        onError={reportError}
      />
    )
  }

  return (
    <div className="popover-surface" role="dialog" aria-label={t("surface.popoverTitle")}>
      <div className="popover-header">
        <span className="popover-title">{t("surface.popoverTitle")}</span>
        {entry ? <span className="popover-issue" title={entry.issue.title}>{entry.issue.title}</span> : null}
        {entry ? (
          <button
            type="button"
            className="popover-details"
            aria-label={t("popover.openDetails")}
            onClick={() => {
              requestInspectorOpen(entry.issue.id)
            }}
          >
            {t("popover.details")}
          </button>
        ) : null}
        <button
          type="button"
          className="popover-close"
          aria-label={t("popover.close")}
          onClick={close}
        >
          ×
        </button>
      </div>
      <div className="popover-body">{body}</div>
      {error ? (
        <div className="popover-footer">
          <span className="popover-error" role="alert" title={error}>{error}</span>
        </div>
      ) : null}
    </div>
  )
}
