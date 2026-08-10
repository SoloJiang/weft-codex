import * as React from "react"
import { FolderGit2, KanbanSquare, Plus, SquarePen } from "lucide-react"

import { api, jsonRequest, slugify } from "@/api"
import { DialogLayer } from "@/components/dialogs"
import { IssueDetailView } from "@/components/issue-detail-view"
import { ArtifactView } from "@/components/artifact-view"
import { KanbanView, type WorkActions } from "@/components/kanban-view"
import { RepositoriesView } from "@/components/repositories-view"
import { openCodexThread } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useI18n } from "@/i18n"
import { readInitialRoute, readInitialWorkspaceId } from "@/surface"
import { createSurfaceChannel, type SurfaceMessage } from "@/surface-channel"
import type {
  AppView,
  BoardEntry,
  DialogState,
  Direction,
  Issue,
  IssueKind,
  MessageIntent,
  Repo,
  RepoImportResponse,
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
  "thread.binding.updated",
]

function errorText(error: unknown, network: string, unknown: string): string {
  if (error instanceof TypeError) return network
  if (error instanceof Error && error.message) return error.message
  return unknown
}

export default function App({ embedded = false }: { embedded?: boolean }) {
  const { t, lang } = useI18n()
  const initialRoute = React.useMemo(readInitialRoute, [])
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = React.useState<number | null>(readInitialWorkspaceId)
  const [repos, setRepos] = React.useState<Repo[]>([])
  const [board, setBoard] = React.useState<BoardEntry[]>([])
  const [repoMap, setRepoMap] = React.useState<RepoMap | null>(null)
  const [view, setView] = React.useState<AppView>(initialRoute.view)
  const [detailIssueId, setDetailIssueId] = React.useState<number | null>(initialRoute.issueId)
  const [artifactId, setArtifactId] = React.useState<number | null>(initialRoute.artifactId ?? null)
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [loading, setLoading] = React.useState(true)
  const [revision, setRevision] = React.useState(0)
  const [toasts, setToasts] = React.useState<ToastMessage[]>([])
  const loadSequence = React.useRef(0)
  const toastSequence = React.useRef(0)
  const surfaceState = React.useRef({ workspaceId, view, detailIssueId })
  const channel = React.useMemo(createSurfaceChannel, [])
  surfaceState.current = { workspaceId, view, detailIssueId }

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
    return () => {
      window.clearTimeout(timer)
      source.close()
    }
  }, [workspaceId, refreshWorkspace, loadWorkspaces, notifyError])

  React.useEffect(() => {
    if (!channel) return
    const publishState = () => {
      const current = surfaceState.current
      channel.post({ type: "workspace.changed", workspaceId: current.workspaceId })
      channel.post({ type: "route.changed", view: current.view, issueId: current.detailIssueId })
    }
    const receive = (message: SurfaceMessage) => {
      if (message.type === "workspace.select") {
        loadSequence.current += 1
        setRepos([])
        setBoard([])
        setRepoMap(null)
        setDetailIssueId(null)
        setView("kanban")
        setWorkspaceId(message.workspaceId)
        return
      }
      if (message.type === "navigate") {
        setDetailIssueId(message.issueId)
        setArtifactId(message.artifactId ?? null)
        setView(message.view)
        return
      }
      if (message.type === "command" && message.command === "workspace.create") {
        setDialog({ type: "workspace" })
        return
      }
      if (message.type === "command" && message.command === "issue.create") {
        setDialog({ type: "issue" })
        return
      }
      if (message.type === "state.request") publishState()
      if (message.type === "surface.ready" && message.surface === "sidebar") publishState()
    }
    const unsubscribe = channel.subscribe(receive)
    channel.post({ type: "surface.ready", surface: embedded ? "workspace" : "standalone" })
    return unsubscribe
  }, [channel, embedded, refreshWorkspace, notifyError])

  React.useEffect(() => {
    return () => channel?.close()
  }, [channel])

  React.useEffect(() => {
    channel?.post({ type: "workspace.changed", workspaceId })
  }, [channel, workspaceId])

  React.useEffect(() => {
    channel?.post({ type: "route.changed", view, issueId: detailIssueId })
  }, [channel, view, detailIssueId])

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

  const launchLead = React.useCallback(async (issueId: number) => {
    const started = await api<{ codexThreadId: string }>(`/api/issues/${issueId}/spawn-lead`, jsonRequest("POST"))
    await refreshCurrent()
    window.setTimeout(() => {
      void openCodexThread(started.codexThreadId).catch(() => {
        notifyError(new Error(t("err.threadOpen")))
      })
    }, 0)
  }, [notifyError, refreshCurrent, t])

  const createIssue = async (title: string, kind: IssueKind) => {
    if (!workspaceId) throw new Error(t("err.unknown"))
    const created = await api<{ id: number }>("/api/issues", jsonRequest("POST", {
      workspace_id: workspaceId,
      title,
      slug: slugify(title),
      kind,
    }))
    await refreshCurrent()
    setDetailIssueId(created.id)
    setView("issue")
    notify(t("success.issueCreated"), "success")
    void launchLead(created.id).catch((caught) => {
      notifyError(caught)
      void refreshCurrent()
    })
  }

  const sendMessage = async (target: "lead" | "task", id: number, text: string, intent: MessageIntent) => {
    const path = target === "lead" ? `/api/issues/${id}/message` : `/api/directions/${id}/message`
    await api(path, jsonRequest("POST", { text }))
    await refreshCurrent()
    notify(t(intent === "continue" ? "success.continueSent" : "success.messageSent"), "success")
  }

  const completeTask = React.useCallback(async (direction: Direction) => {
    await api(`/api/directions/${direction.id}/complete`, jsonRequest("POST"))
    await refreshCurrent()
    notify(t("success.taskCompleted"), "success")
  }, [notify, refreshCurrent, t])

  const workActions = React.useMemo<WorkActions>(() => ({
    onError: notifyError,
    onStartLead: async (issue: Issue) => launchLead(issue.id),
    onRetryTask: async (direction: Direction) => {
      try {
        await api(`/api/directions/${direction.id}/spawn`, jsonRequest("POST"))
      } catch {
        throw new Error(t("err.taskStart"))
      }
      await refreshCurrent()
    },
    onCompleteTask: completeTask,
    onClearAttention: async (direction: Direction) => {
      await api(`/api/directions/${direction.id}/attention/clear`, jsonRequest("POST"))
      await refreshCurrent()
    },
    onContinueTask: (direction: Direction) => setDialog({ type: "message", target: "task", id: direction.id, intent: "continue" }),
  }), [notifyError, refreshCurrent, completeTask, launchLead, t])

  const importRepositories = async (paths: string[]): Promise<RepoImportResponse> => {
    if (!workspaceId) throw new Error(t("err.unknown"))
    const response = await api<RepoImportResponse>(
      `/api/workspaces/${workspaceId}/repos/import`,
      jsonRequest("POST", { paths }),
    )
    await refreshCurrent()
    if (response.added) notify(t("success.reposAdded", { count: response.added }), "success")
    else if (!response.failed) notify(t("success.reposExisting"), "info")
    return response
  }

  const analyzeRepository = async (id: number) => {
    await api(`/api/repos/${id}/analyze`, jsonRequest("POST"))
    notify(t("success.analysisStarted"), "success")
    await refreshCurrent()
  }

  const switchView = (next: "kanban" | "repos") => {
    setDetailIssueId(null)
    setArtifactId(null)
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
        onOpenImport={() => setDialog({ type: "repositories" })}
        onAnalyzeRepository={analyzeRepository}
        onError={notifyError}
      />
    )
  } else if (view === "artifact" && artifactId) {
    mainContent = (
      <ArtifactView
        artifactId={artifactId}
        onBack={() => switchView("kanban")}
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
        onOpenCreateIssue={() => setDialog({ type: "issue" })}
        onCreateWorkspace={() => setDialog({ type: "workspace" })}
        onOpenIssue={(id) => { setDetailIssueId(id); setView("issue") }}
      />
    )
  }

  const activeNavigation = view === "issue" ? "kanban" : view
  let topbar: React.ReactNode = null
  if (!embedded) {
    topbar = (
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
          <Button variant="ghost" disabled={!workspaceId} onClick={() => setDialog({ type: "issue" })}>
            <SquarePen aria-hidden="true" />
            {t("issue.create")}
          </Button>
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
        </div>
      </header>
    )
  }
  return (
    <>
      {topbar}

      <main className={embedded ? "embedded-main" : undefined}>{mainContent}</main>

      <DialogLayer
        state={dialog}
        onClose={() => setDialog(null)}
        onCreateWorkspace={createWorkspace}
        onCreateIssue={createIssue}
        onImportRepositories={importRepositories}
        onSendMessage={sendMessage}
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
