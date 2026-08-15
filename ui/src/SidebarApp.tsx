import * as React from "react"

import { api, jsonRequest } from "@/api"
import { openCodexThread } from "@/components/shared"
import { primaryBranch } from "@/components/conversation-tree"
import type { HostContextV1, SidebarItem, SidebarModel } from "@/host-context"
import {
  requestHostAction,
  requestInspectorClose,
  requestInspectorOpen,
  requestSidebarSync,
  useSidebarCommand,
} from "@/host-context"
import { useI18n } from "@/i18n"
import { createSurfaceChannel, type SurfaceMessage } from "@/surface-channel"
import { readInitialRoute, readInitialWorkspaceId, type SurfaceRoute } from "@/surface"
import type {
  BoardEntry,
  ThreadBinding,
  ThreadLocationResponse,
  Workspace,
} from "@/types"

const SIDEBAR_EVENT_NAMES = [
  "direction.updated",
  "issue.updated",
  "workspace.updated",
  "repo.added",
  "bus.message",
  "bus.parked",
  "bus.undelivered",
  "thread.binding.updated",
]

interface ResolvedThread {
  binding: ThreadBinding
  workspaceId: number
}

type SidebarLocation =
  | { kind: "workspace"; route: SurfaceRoute }
  | { kind: "bound-thread"; threadId: string; binding: ThreadBinding }
  | { kind: "unbound-thread"; threadId: string }

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

function buildThreadMap(
  board: BoardEntry[],
  resolved: ReadonlyMap<string, ResolvedThread>,
): Map<string, ThreadBinding> {
  const bindings = new Map<string, ThreadBinding>()
  for (const entry of board) {
    for (const binding of entry.threads) bindings.set(binding.thread_id, binding)
  }
  for (const [threadId, location] of resolved) bindings.set(threadId, location.binding)
  return bindings
}

function deriveLocation(
  hostContext: HostContextV1 | null,
  route: SurfaceRoute,
  bindings: ReadonlyMap<string, ThreadBinding>,
): SidebarLocation {
  const threadId = hostContext?.threadId
  const nativeThreadVisible = hostContext?.view === "thread"
  const legacyThreadVisible = hostContext?.view === undefined && Boolean(threadId)
  if (!threadId || (!nativeThreadVisible && !legacyThreadVisible)) {
    return { kind: "workspace", route }
  }
  const binding = bindings.get(threadId)
  if (binding) return { kind: "bound-thread", threadId, binding }
  return { kind: "unbound-thread", threadId }
}

export default function SidebarApp({ hostContext }: { hostContext: HostContextV1 | null }) {
  const { t, lang } = useI18n()
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = React.useState<number | null>(readInitialWorkspaceId)
  const [board, setBoard] = React.useState<BoardEntry[]>([])
  const [route, setRoute] = React.useState<SurfaceRoute>(readInitialRoute)
  const [resolvedThreads, setResolvedThreads] = React.useState<Map<string, ResolvedThread>>(
    () => new Map(),
  )
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const loadSequence = React.useRef(0)
  const resolveSequence = React.useRef(0)
  const stateRef = React.useRef({ workspaceId, route })
  const channel = React.useMemo(createSurfaceChannel, [])
  const threadMap = React.useMemo(
    () => buildThreadMap(board, resolvedThreads),
    [board, resolvedThreads],
  )
  const location = React.useMemo(
    () => deriveLocation(hostContext, route, threadMap),
    [hostContext, route, threadMap],
  )
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
    const rows = await api<BoardEntry[]>(`/api/issues?workspace_id=${id}`)
    if (loadSequence.current !== sequence) return
    setBoard(normalizeBoard(rows))
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

  React.useEffect(() => {
    if (location.kind !== "unbound-thread") return
    const sequence = resolveSequence.current + 1
    resolveSequence.current = sequence
    let cancelled = false
    const resolve = async () => {
      for (const delay of [0, 250, 750]) {
        if (delay) await new Promise((done) => window.setTimeout(done, delay))
        if (cancelled || resolveSequence.current !== sequence) return
        let response: ThreadLocationResponse
        try {
          response = await api<ThreadLocationResponse>(
            "/api/threads/resolve",
            jsonRequest("POST", { thread_id: location.threadId }),
          )
        } catch {
          continue
        }
        if (!response.binding || !response.workspaceId) continue
        setResolvedThreads((current) => {
          const next = new Map(current)
          next.set(location.threadId, {
            binding: response.binding as ThreadBinding,
            workspaceId: response.workspaceId as number,
          })
          return next
        })
        if (response.workspaceId !== stateRef.current.workspaceId) {
          setWorkspaceId(response.workspaceId)
          setRoute({ view: "kanban", issueId: null })
          channel?.post({ type: "workspace.select", workspaceId: response.workspaceId })
        }
        return
      }
    }
    void resolve()
    return () => { cancelled = true }
  }, [channel, location])

  let activeIssueId: number | null = null
  if (location.kind === "bound-thread") {
    activeIssueId = location.binding.issue_id
  } else if (location.kind === "workspace" && location.route.view === "issue") {
    activeIssueId = location.route.issueId
  }

  const navigate = React.useCallback((next: SurfaceRoute) => {
    requestHostAction({ action: "workspace.show" })
    setRoute(next)
    channel?.post({ type: "navigate", view: next.view, issueId: next.issueId, artifactId: next.artifactId ?? null })
  }, [channel])

  const openThread = React.useCallback((threadId: string) => {
    setError("")
    void openCodexThread(threadId).catch(() => {
      setError(t("err.prefix") + t("err.threadOpen"))
    })
  }, [t])

  const openIssue = React.useCallback((entry: BoardEntry) => {
    const primary = primaryBranch(entry, null)
    const threadId = primary?.thread_id || entry.issue.lead_codex_thread_id
    if (threadId) {
      const openInspectorId = hostContext?.inspector?.issueId
      if (openInspectorId && openInspectorId !== entry.issue.id) requestInspectorClose()
      openThread(threadId)
      return
    }
    setError("")
    void api<{ codexThreadId: string }>(`/api/issues/${entry.issue.id}/spawn-lead`, jsonRequest("POST"))
      .then(async (started) => {
        if (stateRef.current.workspaceId) await loadWorkspace(stateRef.current.workspaceId)
        const openInspectorId = hostContext?.inspector?.issueId
        if (openInspectorId && openInspectorId !== entry.issue.id) requestInspectorClose()
        openThread(started.codexThreadId)
      })
      .catch(() => {
        if (!requestInspectorOpen(entry.issue.id)) {
          navigate({ view: "issue", issueId: entry.issue.id })
        }
        setError(t("err.prefix") + t("err.threadOpen"))
      })
  }, [hostContext?.inspector?.issueId, loadWorkspace, navigate, openThread, t])

  const createIssue = React.useCallback(() => {
    requestHostAction({ action: "workspace.show" })
    channel?.post({ type: "command", command: "issue.create" })
  }, [channel])

  useSidebarCommand((command) => {
    if (command.command === "kanban.show") {
      navigate({ view: "kanban", issueId: null })
      return
    }
    if (command.command === "repos.show") {
      navigate({ view: "repos", issueId: null })
      return
    }
    if (command.command === "issue.create") {
      createIssue()
      return
    }
    if (command.command === "workspace.create") {
      requestHostAction({ action: "workspace.show" })
      channel?.post({ type: "command", command: "workspace.create" })
      return
    }
    if (command.command === "workspace.select") {
      requestInspectorClose()
      requestHostAction({ action: "workspace.show" })
      setWorkspaceId(command.workspaceId)
      setRoute({ view: "kanban", issueId: null })
      channel?.post({ type: "workspace.select", workspaceId: command.workspaceId })
      return
    }
    const entry = board.find((candidate) => candidate.issue.id === command.issueId)
    if (entry) openIssue(entry)
    else if (!requestInspectorOpen(command.issueId)) {
      navigate({ view: "issue", issueId: command.issueId })
    }
  })

  const model = React.useMemo<SidebarModel>(() => {
    const kanbanSelected = location.kind === "workspace" && route.view === "kanban"
    const reposSelected = location.kind === "workspace" && route.view === "repos"
    const items: SidebarItem[] = [
      ...workspaces.map((entry) => ({
        key: `workspace-${entry.id}`,
        kind: "workspace" as const,
        title: entry.name,
        workspaceId: entry.id,
        selected: entry.id === workspaceId,
      })),
      { key: "kanban", kind: "kanban", title: t("nav.kanban"), selected: kanbanSelected },
      { key: "repos", kind: "repos", title: t("nav.repos"), selected: reposSelected },
      ...board.map((entry) => {
        const primary = primaryBranch(entry, null)
        const threadId = primary?.thread_id || entry.issue.lead_codex_thread_id || undefined
        return {
          key: `issue-${entry.issue.id}`,
          kind: "issue" as const,
          title: entry.issue.title,
          issueId: entry.issue.id,
          threadId,
          selected: activeIssueId === entry.issue.id,
        }
      }),
    ]
    return {
      workspaceLabel: t("workspace.label"),
      issuesLabel: t("sidebar.issues"),
      createLabel: t("issue.create"),
      workspaceId: workspaceId ?? undefined,
      items,
    }
  }, [activeIssueId, board, location.kind, route.view, t, workspaceId, workspaces])

  React.useEffect(() => {
    requestSidebarSync(model)
  }, [model])

  return (
    <div className="sidebar-controller" hidden>
      {error ? <span className="sr-only" role="alert">{error}</span> : null}
      {loading ? <span className="sr-only" role="status">{t("app.loading")}</span> : null}
    </div>
  )
}
