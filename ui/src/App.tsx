import * as React from "react"
import { api, apiUrl, jsonRequest, slugify } from "@/api"
import { IssueDetailView } from "@/components/issue-detail-view"
import { ArtifactView } from "@/components/artifact-view"
import { KanbanView, type WorkActions } from "@/components/kanban-view"
import { RepositoriesView } from "@/components/repositories-view"
import { openCodexThread } from "@/components/shared"
import { useI18n } from "@/i18n"
import { useWeftSession } from "@/session"
import type {
  BoardEntry,
  DialogSubmission,
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
  "lead.attention",
  "thread.binding.updated",
]

function errorText(error: unknown, network: string, unknown: string): string {
  if (error instanceof TypeError) return network
  if (error instanceof Error && error.message) return error.message
  return unknown
}

export default function App() {
  const { t } = useI18n()
  const session = useWeftSession()
  const workspaceId = session.workspaceId
  const view = session.route.view
  const detailIssueId = session.route.issueId
  const artifactId = session.route.artifactId ?? null
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [repos, setRepos] = React.useState<Repo[]>([])
  const [board, setBoard] = React.useState<BoardEntry[]>([])
  const [repoMap, setRepoMap] = React.useState<RepoMap | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [revision, setRevision] = React.useState(0)
  const [toasts, setToasts] = React.useState<ToastMessage[]>([])
  const loadSequence = React.useRef(0)
  const toastSequence = React.useRef(0)
  const openDialog = session.openDialog

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
    let nextId: number | null = null
    if (preferredId && rows.some((workspace) => workspace.id === preferredId)) nextId = preferredId
    else if (workspaceId && rows.some((workspace) => workspace.id === workspaceId)) nextId = workspaceId
    else nextId = rows[0]?.id ?? null
    session.setWorkspaceId(nextId)
    return rows
  }, [session, workspaceId])

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
    const source = new EventSource(apiUrl("/api/events"))
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

  const refreshCurrent = React.useCallback(async () => {
    if (!workspaceId) return
    await refreshWorkspace(workspaceId)
  }, [workspaceId, refreshWorkspace])

  const createWorkspace = async (name: string) => {
    const created = await api<{ id: number }>("/api/workspaces", jsonRequest("POST", { name, slug: slugify(name) }))
    await loadWorkspaces(created.id)
    session.navigate({ view: "kanban", issueId: null })
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
    const created = await api<{ id: number; codexThreadId?: string | null }>("/api/issues", jsonRequest("POST", {
      workspace_id: workspaceId,
      title,
      slug: slugify(title),
      kind,
    }))
    await refreshCurrent()
    session.navigate({ view: "issue", issueId: created.id })
    notify(t("success.issueCreated"), "success")
    // The lead is started server side with the issue, so there is no second
    // call to race here. A start that failed is recorded on the issue and shows
    // on the board; opening the thread is all that is left.
    if (created.codexThreadId) {
      window.setTimeout(() => {
        void openCodexThread(created.codexThreadId as string).catch(() => {
          notifyError(new Error(t("err.threadOpen")))
        })
      }, 0)
    }
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
    onContinueTask: (direction: Direction) => openDialog({ type: "message", target: "task", id: direction.id, intent: "continue" }),
  }), [notifyError, refreshCurrent, completeTask, launchLead, openDialog, t])

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

  const handleDialogSubmit = async (submission: DialogSubmission) => {
    if (submission.type === "workspace") {
      await createWorkspace(submission.name)
      return undefined
    }
    if (submission.type === "issue") {
      await createIssue(submission.title, submission.kind)
      return undefined
    }
    if (submission.type === "repositories") {
      return importRepositories(submission.paths)
    }
    await sendMessage(
      submission.target,
      submission.id,
      submission.text,
      submission.intent,
    )
    return undefined
  }

  React.useEffect(() => {
    session.registerDialogSubmit(handleDialogSubmit)
  })

  const analyzeRepository = async (id: number) => {
    await api(`/api/repos/${id}/analyze`, jsonRequest("POST"))
    notify(t("success.analysisStarted"), "success")
    await refreshCurrent()
  }

  const switchView = (next: "kanban" | "repos") => {
    session.navigate({ view: next, issueId: null })
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
        onCreateWorkspace={() => openDialog({ type: "workspace" })}
        onOpenImport={() => openDialog({ type: "repositories" })}
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
        onOpenCreateIssue={() => openDialog({ type: "issue" })}
        onCreateWorkspace={() => openDialog({ type: "workspace" })}
        onOpenIssue={(id) => session.navigate({ view: "issue", issueId: id })}
      />
    )
  }

  return (
    <>
      <main className="embedded-main">{mainContent}</main>

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
