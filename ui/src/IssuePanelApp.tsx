import * as React from "react"

import { api } from "@/api"
import { IssueConversationCard } from "@/components/issue-conversation-panel"
import { openCodexThread } from "@/components/shared"
import { requestHostAction } from "@/host-context"
import { useI18n } from "@/i18n"
import { readInitialIssueId, readInitialWorkspaceId } from "@/surface"
import type { BoardEntry } from "@/types"

export default function IssuePanelApp({ activeThreadId }: { activeThreadId: string | null }) {
  const { t } = useI18n()
  const workspaceId = React.useMemo(readInitialWorkspaceId, [])
  const issueId = React.useMemo(readInitialIssueId, [])
  const [entry, setEntry] = React.useState<BoardEntry | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")

  const load = React.useCallback(async () => {
    if (!workspaceId || !issueId) {
      setError(t("detail.notFoundBody"))
      setLoading(false)
      return
    }
    try {
      const board = await api<BoardEntry[]>(`/api/issues?workspace_id=${workspaceId}`)
      const next = board.find((candidate) => candidate.issue.id === issueId)
      if (!next) {
        setError(t("detail.notFoundBody"))
        return
      }
      setEntry({
        ...next,
        threads: Array.isArray(next.threads) ? next.threads : [],
      })
      setError("")
    } catch {
      setError(t("err.network"))
    } finally {
      setLoading(false)
    }
  }, [issueId, t, workspaceId])

  React.useEffect(() => {
    void load()
    const source = new EventSource("/api/events")
    let timer: number | undefined
    const refresh = () => {
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void load(), 250)
    }
    source.addEventListener("direction.updated", refresh)
    source.addEventListener("issue.updated", refresh)
    source.addEventListener("thread.binding.updated", refresh)
    return () => {
      window.clearTimeout(timer)
      source.close()
    }
  }, [load])

  const close = React.useCallback(() => {
    requestHostAction({ action: "issue-panel.close" })
  }, [])

  const resize = React.useCallback((height: number) => {
    requestHostAction({ action: "issue-panel.resize", height })
  }, [])

  const openThread = React.useCallback((threadId: string) => {
    setError("")
    void openCodexThread(threadId).catch(() => setError(t("err.threadOpen")))
  }, [t])

  if (loading) {
    return (
      <div className="issue-panel-frame">
        <div className="issue-panel-state" role="status">{t("app.loading")}</div>
      </div>
    )
  }
  if (!entry) {
    return (
      <div className="issue-panel-frame">
        <div className="issue-panel-state" role="alert">{error || t("detail.notFoundBody")}</div>
      </div>
    )
  }

  return (
    <div className="issue-panel-frame">
      <IssueConversationCard
        entry={entry}
        activeThreadId={activeThreadId}
        onOpenThread={openThread}
        onClose={close}
        onSizeChange={resize}
        autoFocus
      />
      {error ? <p className="issue-panel-error" role="alert">{error}</p> : null}
    </div>
  )
}
