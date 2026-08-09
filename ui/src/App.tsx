import * as React from "react"
import { FolderGit2, KanbanSquare, Plus } from "lucide-react"

import { api, jsonRequest, slugify } from "@/api"
import { DialogLayer, type TaskInput } from "@/components/dialogs"
import { IssueDetailView } from "@/components/issue-detail-view"
import { KanbanView, type WorkActions } from "@/components/kanban-view"
import { RepositoriesView } from "@/components/repositories-view"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useI18n } from "@/i18n"
import type {
  AppView,
  BoardEntry,
  DialogState,
  Direction,
  DirectionStatus,
  Issue,
  Repo,
  RepoMap,
  ToastKind,
  Workspace,
} from "@/types"

interface ToastMessage {
  id: number
  message: string
  kind: ToastKind
}

const EVENT_NAMES = [
  "direction.updated",
  "issue.updated",
  "workspace.updated",
  "repo.added",
  "repo.profile",
  "repo.relations",
  "bus.message",
  "bus.parked",
  "bus.undelivered",
  "thread.human-active",
]

function errorText(error: unknown, network: string, unknown: string): string {
  if (error instanceof TypeError) return network
  if (error instanceof Error && error.message) return error.message
  return unknown
}

export default function App() {
  const { t, lang } = useI18n()
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = React.useState<number | null>(null)
  const [repos, setRepos] = React.useState<Repo[]>([])
  const [board, setBoard] = React.useState<BoardEntry[]>([])
  const [repoMap, setRepoMap] = React.useState<RepoMap | null>(null)
  const [view, setView] = React.useState<AppView>("kanban")
  const [detailIssueId, setDetailIssueId] = React.useState<number | null>(null)
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [connected, setConnected] = React.useState(false)
  const [loading, setLoading] = React.useState(true)
  const [revision, setRevision] = React.useState(0)
  const [toasts, setToasts] = React.useState<ToastMessage[]>([])
  const loadSequence = React.useRef(0)
  const toastSequence = React.useRef(0)

  React.useEffect(() => {
    document.documentElement.lang = lang
    document.title = t("app.title")
  }, [lang, t])

  const notify = React.useCallback((message: string, kind: ToastKind = "info") => {
    toastSequence.current += 1
    const id = toastSequence.current
    setToasts((current) => [...current, { id, message, kind }])
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id))
    }, 6000)
  }, [])

  const notifyError = React.useCallback((error: unknown) => {
    notify(t("err.prefix") + errorText(error, t("err.network"), t("err.unknown")), "error")
  }, [notify, t])

  const refreshWorkspace = React.useCallback(async (id: number) => {
    const sequence = loadSequence.current + 1
    loadSequence.current = sequence
    const [nextRepos, nextBoard, nextRepoMap] = await Promise.all([
      api<Repo[]>(`/api/workspaces/${id}/repos`),
      api<BoardEntry[]>(`/api/issues?workspace_id=${id}`),
      api<RepoMap>(`/api/workspaces/${id}/repo-map`),
    ])
    if (loadSequence.current !== sequence) return
    setRepos(nextRepos)
    setBoard(nextBoard)
    setRepoMap(nextRepoMap)
    setRevision((current) => current + 1)
  }, [])

  const loadWorkspaces = React.useCallback(async (preferredId?: number) => {
    const rows = await api<Workspace[]>("/api/workspaces")
    setWorkspaces(rows)
    setWorkspaceId((current) => {
      if (preferredId && rows.some((workspace) => workspace.id === preferredId)) return preferredId
      if (current && rows.some((workspace) => workspace.id === current)) return current
      return rows[0]?.id ?? null
    })
    return rows
  }, [])

  React.useEffect(() => {
    let active = true
    loadWorkspaces()
      .catch(notifyError)
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [loadWorkspaces, notifyError])

  React.useEffect(() => {
    if (!workspaceId) {
      loadSequence.current += 1
      setRepos([])
      setBoard([])
      setRepoMap(null)
      return
    }
    setLoading(true)
    refreshWorkspace(workspaceId)
      .catch(notifyError)
      .finally(() => setLoading(false))
  }, [workspaceId, refreshWorkspace, notifyError])

  React.useEffect(() => {
    const source = new EventSource("/api/events")
    let timer: number | undefined
    let refreshWorkspaceList = false

    const scheduleRefresh = (event: Event) => {
      setConnected(true)
      if (event.type === "workspace.updated") refreshWorkspaceList = true
      window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        const jobs: Promise<unknown>[] = []
        if (workspaceId) jobs.push(refreshWorkspace(workspaceId))
        if (refreshWorkspaceList) {
          refreshWorkspaceList = false
          jobs.push(loadWorkspaces())
        }
        Promise.all(jobs).catch(notifyError)
        setRevision((current) => current + 1)
      }, 400)
    }

    for (const name of EVENT_NAMES) source.addEventListener(name, scheduleRefresh)
    source.onopen = () => setConnected(true)
    source.onerror = () => setConnected(false)
    return () => {
      window.clearTimeout(timer)
      source.close()
    }
  }, [workspaceId, refreshWorkspace, loadWorkspaces, notifyError])

  const refreshCurrent = React.useCallback(async () => {
    if (!workspaceId) return
    await refreshWorkspace(workspaceId)
  }, [workspaceId, refreshWorkspace])

  const createWorkspace = async (name: string) => {
    const created = await api<{ id: number }>("/api/workspaces", jsonRequest("POST", { name, slug: slugify(name) }))
    await loadWorkspaces(created.id)
    setView("kanban")
    setDetailIssueId(null)
    notify(t("success.workspaceCreated"), "success")
  }

  const createIssue = async (title: string) => {
    if (!workspaceId) throw new Error(t("err.unknown"))
    await api("/api/issues", jsonRequest("POST", { workspace_id: workspaceId, title, slug: slugify(title) }))
    await refreshCurrent()
    notify(t("success.issueCreated"), "success")
  }

  const createTask = async (issueId: number, input: TaskInput) => {
    await api(`/api/issues/${issueId}/directions`, jsonRequest("POST", {
      name: input.name,
      slug: slugify(input.name),
      repo_id: input.repoId,
      spec: input.spec,
      mandate: input.mandate,
      base_branch: input.baseBranch,
    }))
    await refreshCurrent()
    notify(t("success.taskCreated"), "success")
  }

  const sendMessage = async (target: "lead" | "task", id: number, text: string) => {
    const path = target === "lead" ? `/api/issues/${id}/message` : `/api/directions/${id}/message`
    await api(path, jsonRequest("POST", { text }))
    await refreshCurrent()
    notify(t("success.messageSent"), "success")
  }

  const moveTask = React.useCallback(async (id: number, status: DirectionStatus) => {
    await api(`/api/directions/${id}/status`, jsonRequest("POST", { status }))
    await refreshCurrent()
    notify(t("success.taskMoved", { status: t(`status.${status}`) }), "success")
  }, [notify, refreshCurrent, t])

  const workActions = React.useMemo<WorkActions>(() => ({
    onError: notifyError,
    onStartLead: async (issue: Issue) => {
      await api(`/api/issues/${issue.id}/spawn-lead`, jsonRequest("POST"))
      await refreshCurrent()
    },
    onStartTask: async (direction: Direction) => {
      await api(`/api/directions/${direction.id}/spawn`, jsonRequest("POST"))
      await refreshCurrent()
    },
    onClearAttention: async (direction: Direction) => {
      await api(`/api/directions/${direction.id}/attention/clear`, jsonRequest("POST"))
      await refreshCurrent()
    },
    onMoveTask: moveTask,
    onMessageLead: (issue: Issue) => setDialog({ type: "message", target: "lead", id: issue.id }),
    onMessageTask: (direction: Direction) => setDialog({ type: "message", target: "task", id: direction.id }),
    onNewTask: (issue: Issue) => {
      if (!repos.length) {
        notify(t("task.noRepo"), "error")
        return
      }
      setDialog({ type: "task", issueId: issue.id })
    },
    onMoveTaskDialog: (direction: Direction) => setDialog({ type: "move", direction }),
  }), [notifyError, refreshCurrent, moveTask, repos.length, notify, t])

  const addRepository = async (name: string, path: string) => {
    if (!workspaceId) throw new Error(t("err.unknown"))
    await api(`/api/workspaces/${workspaceId}/repos`, jsonRequest("POST", { name, path, base_ref: "main" }))
    await refreshCurrent()
    notify(t("success.repoAdded"), "success")
  }

  const analyzeRepository = async (id: number) => {
    await api(`/api/repos/${id}/analyze`, jsonRequest("POST"))
    notify(t("success.analysisStarted"), "success")
    await refreshCurrent()
  }

  const analyzeWorkspace = async () => {
    if (!workspaceId) return
    await api(`/api/workspaces/${workspaceId}/analyze`, jsonRequest("POST"))
    notify(t("success.analysisStarted"), "success")
    await refreshCurrent()
  }

  const analyzeRelations = async () => {
    if (!workspaceId) return
    await api(`/api/workspaces/${workspaceId}/analyze-relations`, jsonRequest("POST"))
    notify(t("success.relationsStarted"), "success")
    await refreshCurrent()
  }

  const switchView = (next: "kanban" | "repos") => {
    setDetailIssueId(null)
    setView(next)
  }

  const detailEntry = board.find((entry) => entry.issue.id === detailIssueId)
  let mainContent: React.ReactNode
  if (loading && !workspaces.length) {
    mainContent = <div className="app-loading" role="status">{t("app.loading")}</div>
  } else if (view === "repos") {
    mainContent = (
      <RepositoriesView
        workspaceId={workspaceId}
        repoMap={repoMap}
        onCreateWorkspace={() => setDialog({ type: "workspace" })}
        onAddRepository={addRepository}
        onAnalyzeRepository={analyzeRepository}
        onAnalyzeWorkspace={analyzeWorkspace}
        onAnalyzeRelations={analyzeRelations}
        onError={notifyError}
      />
    )
  } else if (view === "issue") {
    mainContent = (
      <IssueDetailView
        entry={detailEntry}
        repos={repos}
        revision={revision}
        actions={workActions}
        onBack={() => switchView("kanban")}
      />
    )
  } else {
    mainContent = (
      <KanbanView
        workspaceId={workspaceId}
        repos={repos}
        board={board}
        actions={workActions}
        onCreateIssue={createIssue}
        onCreateWorkspace={() => setDialog({ type: "workspace" })}
        onShowRepositories={() => switchView("repos")}
        onOpenIssue={(id) => { setDetailIssueId(id); setView("issue") }}
      />
    )
  }

  const activeNavigation = view === "issue" ? "kanban" : view
  return (
    <>
      <header id="topbar">
        <nav aria-label={t("nav.primary")}>
          <Button
            variant="ghost"
            className={`nav-btn${activeNavigation === "kanban" ? " active" : ""}`}
            aria-current={activeNavigation === "kanban" ? "page" : undefined}
            onClick={() => switchView("kanban")}
          >
            <KanbanSquare aria-hidden="true" />
            {t("nav.kanban")}
          </Button>
          <Button
            variant="ghost"
            className={`nav-btn${activeNavigation === "repos" ? " active" : ""}`}
            aria-current={activeNavigation === "repos" ? "page" : undefined}
            onClick={() => switchView("repos")}
          >
            <FolderGit2 aria-hidden="true" />
            {t("nav.repos")}
          </Button>
        </nav>
        <div className="workspace-controls">
          <label className="sr-only" htmlFor="workspace-select">{t("workspace.label")}</label>
          <NativeSelect
            className="workspace-select-shell"
            id="workspace-select"
            disabled={!workspaces.length}
            value={workspaceId ?? ""}
            onChange={(event) => {
              loadSequence.current += 1
              setRepos([])
              setBoard([])
              setRepoMap(null)
              setDetailIssueId(null)
              setView("kanban")
              setWorkspaceId(Number(event.target.value))
            }}
          >
            {!workspaces.length ? <NativeSelectOption value="">{t("workspace.none")}</NativeSelectOption> : null}
            {workspaces.map((workspace) => <NativeSelectOption key={workspace.id} value={workspace.id}>{workspace.name}</NativeSelectOption>)}
          </NativeSelect>
          <Button variant="ghost" onClick={() => setDialog({ type: "workspace" })}>
            <Plus aria-hidden="true" />
            {t("ws.add")}
          </Button>
          <span className="connection" data-state={connected ? "up" : "down"} role="status" aria-live="polite" aria-label={connected ? t("status.connected") : t("status.disconnected")}>
            <span className="conn-dot" aria-hidden="true" />
            <span>{connected ? t("status.connected") : t("status.disconnected")}</span>
          </span>
        </div>
      </header>

      <main>{mainContent}</main>

      <DialogLayer
        state={dialog}
        repos={repos}
        onClose={() => setDialog(null)}
        onCreateWorkspace={createWorkspace}
        onCreateTask={createTask}
        onSendMessage={sendMessage}
        onMoveTask={moveTask}
      />

      <div className="notifications" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`} role={toast.kind === "error" ? "alert" : "status"}>
            {toast.message}
          </div>
        ))}
      </div>
    </>
  )
}
