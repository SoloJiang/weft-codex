import * as React from "react"
import { api, jsonRequest, slugify } from "@/api"
import { IssueDetailView } from "@/components/issue-detail-view"
import { ArtifactView } from "@/components/artifact-view"
import { KanbanView, type WorkActions } from "@/components/kanban-view"
import { RepositoriesView } from "@/components/repositories-view"
import { openCodexThread } from "@/components/shared"
import { useI18n } from "@/i18n"
import { useWeftSession } from "@/session"
import { useWeftWorkspace } from "@/workspace-store"
import type {
  DialogSubmission,
  Direction,
  Issue,
  IssueKind,
  MessageIntent,
  RepoImportResponse,
} from "@/types"

export default function App() {
  const { t } = useI18n()
  const session = useWeftSession()
  const store = useWeftWorkspace()
  const workspaceId = session.workspaceId
  const view = session.route.view
  const detailIssueId = session.route.issueId
  const artifactId = session.route.artifactId ?? null
  const { workspaces, repos, board, repoMap, revision, loading, notify, notifyError } = store
  const openDialog = session.openDialog

  const createWorkspace = async (name: string) => {
    const created = await api<{ id: number }>("/api/workspaces", jsonRequest("POST", { name, slug: slugify(name) }))
    await store.loadWorkspaces(created.id)
    session.navigate({ view: "kanban", issueId: null })
    notify(t("success.workspaceCreated"), "success")
  }

  const launchLead = React.useCallback(async (issueId: number) => {
    const started = await api<{ codexThreadId: string }>(`/api/issues/${issueId}/spawn-lead`, jsonRequest("POST"))
    await store.refreshCurrent()
    window.setTimeout(() => {
      void openCodexThread(started.codexThreadId).catch(() => {
        notifyError(new Error(t("err.threadOpen")))
      })
    }, 0)
  }, [notifyError, store, t])

  const createIssue = async (title: string, kind: IssueKind) => {
    if (!workspaceId) throw new Error(t("err.unknown"))
    const created = await api<{ id: number; codexThreadId?: string | null }>("/api/issues", jsonRequest("POST", {
      workspace_id: workspaceId,
      title,
      slug: slugify(title),
      kind,
    }))
    await store.refreshCurrent()
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
    await store.refreshCurrent()
    notify(t(intent === "continue" ? "success.continueSent" : "success.messageSent"), "success")
  }

  const completeTask = React.useCallback(async (direction: Direction) => {
    await api(`/api/directions/${direction.id}/complete`, jsonRequest("POST"))
    await store.refreshCurrent()
    notify(t("success.taskCompleted"), "success")
  }, [notify, store, t])

  const workActions = React.useMemo<WorkActions>(() => ({
    onError: notifyError,
    onStartLead: async (issue: Issue) => launchLead(issue.id),
    onRetryTask: async (direction: Direction) => {
      try {
        await api(`/api/directions/${direction.id}/spawn`, jsonRequest("POST"))
      } catch {
        throw new Error(t("err.taskStart"))
      }
      await store.refreshCurrent()
    },
    onCompleteTask: completeTask,
    onClearAttention: async (direction: Direction) => {
      await api(`/api/directions/${direction.id}/attention/clear`, jsonRequest("POST"))
      await store.refreshCurrent()
    },
    onContinueTask: (direction: Direction) => openDialog({ type: "message", target: "task", id: direction.id, intent: "continue" }),
  }), [notifyError, store, completeTask, launchLead, openDialog, t])

  const importRepositories = async (paths: string[]): Promise<RepoImportResponse> => {
    if (!workspaceId) throw new Error(t("err.unknown"))
    const response = await api<RepoImportResponse>(
      `/api/workspaces/${workspaceId}/repos/import`,
      jsonRequest("POST", { paths }),
    )
    await store.refreshCurrent()
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
    await store.refreshCurrent()
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

  return <main className="embedded-main">{mainContent}</main>
}
