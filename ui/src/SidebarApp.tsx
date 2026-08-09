import * as React from "react"
import { AlertTriangle, Check, FolderGit2, KanbanSquare, Plus, X } from "lucide-react"

import { api, jsonRequest, slugify } from "@/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useI18n } from "@/i18n"
import { createSurfaceChannel, type SurfaceMessage } from "@/surface-channel"
import { readInitialRoute, readInitialWorkspaceId, type SurfaceRoute } from "@/surface"
import type { BoardEntry, Repo, Workspace } from "@/types"

const SIDEBAR_EVENT_NAMES = [
  "direction.updated",
  "issue.updated",
  "workspace.updated",
  "repo.added",
  "bus.message",
  "bus.parked",
  "bus.undelivered",
]

function errorText(error: unknown, network: string, unknown: string): string {
  if (error instanceof TypeError) return network
  if (error instanceof Error && error.message) return error.message
  return unknown
}

export default function SidebarApp() {
  const { t, lang } = useI18n()
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = React.useState<number | null>(readInitialWorkspaceId)
  const [board, setBoard] = React.useState<BoardEntry[]>([])
  const [repoCount, setRepoCount] = React.useState(0)
  const [route, setRoute] = React.useState<SurfaceRoute>(readInitialRoute)
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const [issueComposerOpen, setIssueComposerOpen] = React.useState(false)
  const [issueTitle, setIssueTitle] = React.useState("")
  const [issueError, setIssueError] = React.useState("")
  const [creatingIssue, setCreatingIssue] = React.useState(false)
  const loadSequence = React.useRef(0)
  const stateRef = React.useRef({ workspaceId, route })
  const channel = React.useMemo(createSurfaceChannel, [])
  stateRef.current = { workspaceId, route }

  React.useEffect(() => {
    document.documentElement.lang = lang
    document.title = t("sidebar.title")
  }, [lang, t])

  const reportError = React.useCallback((caught: unknown) => {
    setError(t("err.prefix") + errorText(caught, t("err.network"), t("err.unknown")))
  }, [t])

  const loadWorkspaces = React.useCallback(async () => {
    const rows = await api<Workspace[]>("/api/workspaces")
    setWorkspaces(rows)
    setWorkspaceId((current) => {
      if (current && rows.some((workspace) => workspace.id === current)) return current
      return rows[0]?.id ?? null
    })
  }, [])

  const loadWorkspace = React.useCallback(async (id: number) => {
    const sequence = loadSequence.current + 1
    loadSequence.current = sequence
    const [rows, repos] = await Promise.all([
      api<BoardEntry[]>(`/api/issues?workspace_id=${id}`),
      api<Repo[]>(`/api/workspaces/${id}/repos`),
    ])
    if (loadSequence.current !== sequence) return
    setBoard(rows)
    setRepoCount(repos.length)
  }, [])

  React.useEffect(() => {
    let active = true
    loadWorkspaces()
      .catch(reportError)
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [loadWorkspaces, reportError])

  React.useEffect(() => {
    if (!workspaceId) {
      loadSequence.current += 1
      setBoard([])
      setRepoCount(0)
      return
    }
    setLoading(true)
    setError("")
    loadWorkspace(workspaceId)
      .catch(reportError)
      .finally(() => setLoading(false))
  }, [workspaceId, loadWorkspace, reportError])

  React.useEffect(() => {
    const source = new EventSource("/api/events")
    let timer: number | undefined
    let refreshWorkspaceList = false
    const scheduleRefresh = (event: Event) => {
      if (event.type === "workspace.updated") refreshWorkspaceList = true
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const jobs: Promise<unknown>[] = []
        if (stateRef.current.workspaceId) jobs.push(loadWorkspace(stateRef.current.workspaceId))
        if (refreshWorkspaceList) {
          refreshWorkspaceList = false
          jobs.push(loadWorkspaces())
        }
        Promise.all(jobs).catch(reportError)
      }, 400)
    }

    for (const name of SIDEBAR_EVENT_NAMES) source.addEventListener(name, scheduleRefresh)
    return () => {
      window.clearTimeout(timer)
      source.close()
    }
  }, [loadWorkspace, loadWorkspaces, reportError])

  React.useEffect(() => {
    if (!channel) return
    const receive = (message: SurfaceMessage) => {
      if (message.type === "workspace.changed") {
        setWorkspaceId(message.workspaceId)
        setIssueComposerOpen(false)
        setIssueTitle("")
        setIssueError("")
        return
      }
      if (message.type === "route.changed") {
        setRoute({ view: message.view, issueId: message.issueId })
        return
      }
      if (message.type === "surface.ready" && message.surface === "workspace") {
        channel.post({ type: "state.request" })
      }
    }
    const unsubscribe = channel.subscribe(receive)
    channel.post({ type: "surface.ready", surface: "sidebar" })
    channel.post({ type: "state.request" })
    return () => {
      unsubscribe()
      channel.close()
    }
  }, [channel])

  const navigate = (next: SurfaceRoute) => {
    setRoute(next)
    channel?.post({ type: "navigate", view: next.view, issueId: next.issueId })
  }

  const selectWorkspace = (id: number) => {
    setWorkspaceId(id)
    setRoute({ view: "kanban", issueId: null })
    setIssueComposerOpen(false)
    setIssueTitle("")
    setIssueError("")
    channel?.post({ type: "workspace.select", workspaceId: id })
    channel?.post({ type: "navigate", view: "kanban", issueId: null })
  }

  const closeIssueComposer = () => {
    if (creatingIssue) return
    setIssueComposerOpen(false)
    setIssueTitle("")
    setIssueError("")
  }

  const createIssue = async (event: React.FormEvent) => {
    event.preventDefault()
    if (creatingIssue || !workspaceId) return
    const title = issueTitle.trim()
    if (!title) {
      setIssueError(t("validation.issueTitle"))
      return
    }
    setCreatingIssue(true)
    setIssueError("")
    try {
      const created = await api<{ id: number }>("/api/issues", jsonRequest("POST", {
        workspace_id: workspaceId,
        title,
        slug: slugify(title),
      }))
      await loadWorkspace(workspaceId)
      setIssueComposerOpen(false)
      setIssueTitle("")
      setRoute({ view: "issue", issueId: created.id })
      channel?.post({ type: "issue.created", workspaceId, issueId: created.id })
    } catch (caught) {
      setIssueError(errorText(caught, t("err.network"), t("err.unknown")))
    } finally {
      setCreatingIssue(false)
    }
  }

  const attentionItems = board.flatMap((entry) => entry.directions
    .filter((task) => Boolean(task.attention))
    .map((task) => ({ task, issue: entry.issue })))

  let issueCreateTitle = t("issue.create")
  if (!workspaceId) issueCreateTitle = t("workspace.none")
  if (workspaceId && !repoCount) issueCreateTitle = t("sidebar.issueRequiresRepo")

  let issueList: React.ReactNode
  if (loading && !board.length) {
    issueList = <p className="sidebar-empty" role="status">{t("app.loading")}</p>
  } else if (!board.length) {
    issueList = <p className="sidebar-empty">{t("sidebar.noIssues")}</p>
  } else {
    issueList = board.map((entry) => {
      const done = entry.directions.filter((task) => task.status === "done").length
      const total = entry.directions.length
      const isActive = route.view === "issue" && route.issueId === entry.issue.id
      return (
        <button
          key={entry.issue.id}
          type="button"
          className="sidebar-issue-row"
          data-active={isActive ? "true" : "false"}
          aria-current={isActive ? "page" : undefined}
          onClick={() => navigate({ view: "issue", issueId: entry.issue.id })}
        >
          <span className="sidebar-row-title">{entry.issue.title}</span>
          <span className="sidebar-row-meta">{t("sidebar.taskProgress", { done, total })}</span>
        </button>
      )
    })
  }

  return (
    <aside className="sidebar-surface" aria-label={t("sidebar.title")}>
      <div className="sidebar-workspace-row">
        <label className="sr-only" htmlFor="sidebar-workspace-select">{t("workspace.label")}</label>
        <NativeSelect
          className="sidebar-workspace-select"
          id="sidebar-workspace-select"
          size="sm"
          disabled={!workspaces.length || creatingIssue}
          value={workspaceId ?? ""}
          onChange={(event) => selectWorkspace(Number(event.target.value))}
        >
          {!workspaces.length ? <NativeSelectOption value="">{t("workspace.none")}</NativeSelectOption> : null}
          {workspaces.map((workspace) => (
            <NativeSelectOption key={workspace.id} value={workspace.id}>{workspace.name}</NativeSelectOption>
          ))}
        </NativeSelect>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("ws.add")}
          title={t("ws.add")}
          disabled={!channel}
          onClick={() => channel?.post({ type: "command", command: "workspace.create" })}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>

      <nav className="sidebar-nav" aria-label={t("nav.primary")}>
        <Button
          variant="ghost"
          className="sidebar-nav-button"
          data-active={route.view === "kanban" ? "true" : "false"}
          aria-current={route.view === "kanban" ? "page" : undefined}
          onClick={() => navigate({ view: "kanban", issueId: null })}
        >
          <KanbanSquare aria-hidden="true" />
          {t("nav.kanban")}
        </Button>
        <Button
          variant="ghost"
          className="sidebar-nav-button"
          data-active={route.view === "repos" ? "true" : "false"}
          aria-current={route.view === "repos" ? "page" : undefined}
          onClick={() => navigate({ view: "repos", issueId: null })}
        >
          <FolderGit2 aria-hidden="true" />
          {t("nav.repos")}
        </Button>
      </nav>

      <div className="sidebar-scroll">
        <section className="sidebar-section" aria-labelledby="sidebar-issues-heading">
          <div className="sidebar-section-heading">
            <h2 id="sidebar-issues-heading">{t("sidebar.issues")}</h2>
            <div className="sidebar-section-actions">
              <span className="sidebar-section-count">{board.length}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={issueCreateTitle}
                title={issueCreateTitle}
                disabled={!workspaceId || !repoCount || issueComposerOpen}
                onClick={() => setIssueComposerOpen(true)}
              >
                <Plus aria-hidden="true" />
              </Button>
            </div>
          </div>
          {issueComposerOpen ? (
            <form className="sidebar-issue-create" noValidate onSubmit={createIssue}>
              <label className="sr-only" htmlFor="sidebar-new-issue-title">{t("issue.titleLabel")}</label>
              <Input
                id="sidebar-new-issue-title"
                autoFocus
                autoComplete="off"
                placeholder={t("issue.titlePh")}
                value={issueTitle}
                aria-invalid={Boolean(issueError)}
                aria-describedby={issueError ? "sidebar-issue-error" : undefined}
                disabled={creatingIssue}
                onChange={(event) => { setIssueTitle(event.target.value); setIssueError("") }}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault()
                    event.stopPropagation()
                    closeIssueComposer()
                  }
                }}
              />
              <Button
                type="submit"
                variant="ghost"
                size="icon-xs"
                aria-label={creatingIssue ? t("loading.creatingIssue") : t("issue.create")}
                title={creatingIssue ? t("loading.creatingIssue") : t("issue.create")}
                disabled={creatingIssue}
                aria-busy={creatingIssue}
              >
                <Check aria-hidden="true" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t("modal.cancel")}
                title={t("modal.cancel")}
                disabled={creatingIssue}
                onClick={closeIssueComposer}
              >
                <X aria-hidden="true" />
              </Button>
              {issueError ? <p id="sidebar-issue-error" className="sidebar-issue-error" role="alert">{issueError}</p> : null}
            </form>
          ) : null}
          <div className="sidebar-list">{issueList}</div>
        </section>

        {attentionItems.length ? (
          <section className="sidebar-section" aria-labelledby="sidebar-attention-heading">
            <div className="sidebar-section-heading">
              <h2 id="sidebar-attention-heading">{t("sidebar.needsAttention")}</h2>
              <span>{attentionItems.length}</span>
            </div>
            <div className="sidebar-list">
              {attentionItems.map(({ task, issue }) => (
                <button
                  key={task.id}
                  type="button"
                  className="sidebar-attention-row"
                  onClick={() => navigate({ view: "issue", issueId: issue.id })}
                >
                  <AlertTriangle aria-hidden="true" />
                  <span>
                    <span className="sidebar-row-title">{task.name}</span>
                    <span className="sidebar-row-meta">{issue.title}</span>
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
      </div>

      {error ? (
        <footer className="sidebar-footer">
          <span className="sidebar-error" role="alert" title={error}>{error}</span>
        </footer>
      ) : null}
    </aside>
  )
}
