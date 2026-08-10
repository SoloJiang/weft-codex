import * as React from "react"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  FolderGit2,
  KanbanSquare,
  MessageCircle,
  Plus,
  SquarePen,
} from "lucide-react"

import { api, jsonRequest } from "@/api"
import { openCodexThread } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { HostContextV1 } from "@/host-context"
import { requestHostAction } from "@/host-context"
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

interface ThreadRowProps {
  label: string
  threadId: string
  active: boolean
  primary?: boolean
  nested?: boolean
  onOpen: (threadId: string) => void
}

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

function branchesFor(entry: BoardEntry, directionId: number | null): ThreadBinding[] {
  return entry.threads.filter((binding) => binding.direction_id === directionId)
}

function primaryBranch(entry: BoardEntry, directionId: number | null): ThreadBinding | undefined {
  return branchesFor(entry, directionId).find((binding) => binding.is_primary === 1)
}

function branchTitle(binding: ThreadBinding, forkIndex: number, fallback: string): string {
  if (binding.is_primary === 1) return fallback
  const title = binding.title.trim()
  if (title) return title
  return `${fallback} ${forkIndex}`
}

function ScrollingIssueTitle({ title }: { title: string }) {
  const viewportRef = React.useRef<HTMLSpanElement>(null)

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    if (!viewport) return

    const updateOverflow = () => {
      viewport.dataset.overflow = viewport.scrollWidth > viewport.clientWidth + 1 ? "true" : "false"
    }
    updateOverflow()

    const observer = new ResizeObserver(updateOverflow)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [title])

  const scrollTo = (position: "start" | "end") => {
    const viewport = viewportRef.current
    if (!viewport || viewport.dataset.overflow !== "true") return
    const left = position === "end" ? viewport.scrollWidth - viewport.clientWidth : 0
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "auto"
      : "smooth"
    viewport.scrollTo({ left, behavior })
  }

  return (
    <span
      ref={viewportRef}
      className="sidebar-issue-title-viewport"
      onMouseEnter={() => scrollTo("end")}
      onMouseLeave={() => scrollTo("start")}
    >
      <span className="sidebar-row-title">{title}</span>
    </span>
  )
}

function ThreadRow({
  label,
  threadId,
  active,
  primary = false,
  nested = false,
  onOpen,
}: ThreadRowProps) {
  const { t } = useI18n()
  return (
    <button
      type="button"
      className="sidebar-thread-row"
      data-active={active ? "true" : "false"}
      data-nested={nested ? "true" : "false"}
      aria-current={active ? "page" : undefined}
      onClick={() => onOpen(threadId)}
    >
      {nested ? <CornerDownRight aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
      <span className="sidebar-thread-title" title={label}>{label}</span>
      {primary ? <span className="sidebar-primary-chip">{t("sidebar.primary")}</span> : null}
    </button>
  )
}

function IssueConversationTree({
  entry,
  activeThreadId,
  onOpenThread,
}: {
  entry: BoardEntry
  activeThreadId: string | null
  onOpenThread: (threadId: string) => void
}) {
  const { t } = useI18n()
  const leadBranches = branchesFor(entry, null)
  const leadPrimary = leadBranches.find((binding) => binding.is_primary === 1)
  const leadForks = leadBranches.filter((binding) => binding.is_primary !== 1)

  return (
    <div className="sidebar-conversation-tree">
      <section className="sidebar-chat-group" aria-label={t("party.lead")}>
        <div className="sidebar-chat-group-heading">
          <MessageCircle aria-hidden="true" />
          <span>{t("party.lead")}</span>
        </div>
        <div className="sidebar-chat-group-rows">
          {leadPrimary ? (
            <ThreadRow
              label={t("sidebar.mainChat")}
              threadId={leadPrimary.thread_id}
              active={activeThreadId === leadPrimary.thread_id}
              primary
              nested
              onOpen={onOpenThread}
            />
          ) : (
            <span className="sidebar-chat-pending">{t("sidebar.leadStarting")}</span>
          )}
          {leadForks.map((binding, index) => (
            <ThreadRow
              key={binding.thread_id}
              label={branchTitle(binding, index + 1, t("sidebar.forkChat"))}
              threadId={binding.thread_id}
              active={activeThreadId === binding.thread_id}
              nested
              onOpen={onOpenThread}
            />
          ))}
        </div>
      </section>

      <section className="sidebar-chat-group" aria-label={t("detail.directions")}>
        <div className="sidebar-chat-group-heading">
          <span>{t("detail.directions")}</span>
          <span className="sidebar-chat-group-count">{entry.directions.length}</span>
        </div>
        {entry.directions.length ? (
          <div className="sidebar-chat-group-rows">
            {entry.directions.map((direction) => {
              const taskBranches = branchesFor(entry, direction.id)
              const taskPrimary = taskBranches.find((binding) => binding.is_primary === 1)
              const taskForks = taskBranches.filter((binding) => binding.is_primary !== 1)
              if (!taskPrimary) {
                return (
                  <div key={direction.id} className="sidebar-thread-row sidebar-thread-unavailable">
                    <MessageCircle aria-hidden="true" />
                    <span className="sidebar-thread-title" title={direction.name}>{direction.name}</span>
                  </div>
                )
              }
              return (
                <div key={direction.id} className="sidebar-task-chat">
                  <ThreadRow
                    label={direction.name}
                    threadId={taskPrimary.thread_id}
                    active={activeThreadId === taskPrimary.thread_id}
                    onOpen={onOpenThread}
                  />
                  {taskForks.map((binding, index) => (
                    <ThreadRow
                      key={binding.thread_id}
                      label={branchTitle(binding, index + 1, t("sidebar.forkChat"))}
                      threadId={binding.thread_id}
                      active={activeThreadId === binding.thread_id}
                      nested
                      onOpen={onOpenThread}
                    />
                  ))}
                </div>
              )
            })}
          </div>
        ) : (
          <p className="sidebar-chat-pending">{t("sidebar.noTasks")}</p>
        )}
      </section>
    </div>
  )
}

export default function SidebarApp({ hostContext }: { hostContext: HostContextV1 | null }) {
  const { t, lang } = useI18n()
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = React.useState<number | null>(readInitialWorkspaceId)
  const [board, setBoard] = React.useState<BoardEntry[]>([])
  const [route, setRoute] = React.useState<SurfaceRoute>(readInitialRoute)
  const [expandedIssueId, setExpandedIssueId] = React.useState<number | null>(null)
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
        setExpandedIssueId(response.binding.issue_id)
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
  let activeThreadId: string | null = null
  if (location.kind === "bound-thread") {
    activeIssueId = location.binding.issue_id
    activeThreadId = location.threadId
  } else if (location.kind === "workspace" && location.route.view === "issue") {
    activeIssueId = location.route.issueId
  }

  React.useEffect(() => {
    if (activeIssueId) setExpandedIssueId(activeIssueId)
  }, [activeIssueId])

  const navigate = React.useCallback((next: SurfaceRoute) => {
    requestHostAction({ action: "workspace.show" })
    setRoute(next)
    channel?.post({ type: "navigate", view: next.view, issueId: next.issueId })
  }, [channel])

  const selectWorkspace = React.useCallback((id: number) => {
    requestHostAction({ action: "workspace.show" })
    setWorkspaceId(id)
    setRoute({ view: "kanban", issueId: null })
    setExpandedIssueId(null)
    channel?.post({ type: "workspace.select", workspaceId: id })
    channel?.post({ type: "navigate", view: "kanban", issueId: null })
  }, [channel])

  const openThread = React.useCallback((threadId: string) => {
    setError("")
    void openCodexThread(threadId).catch(() => {
      setError(t("err.prefix") + t("err.threadOpen"))
    })
  }, [t])

  const openIssue = React.useCallback((entry: BoardEntry) => {
    setExpandedIssueId(entry.issue.id)
    const primary = primaryBranch(entry, null)
    const threadId = primary?.thread_id || entry.issue.lead_codex_thread_id
    if (threadId) {
      openThread(threadId)
      return
    }
    navigate({ view: "issue", issueId: entry.issue.id })
  }, [navigate, openThread])

  const attentionItems = board.flatMap((entry) => entry.directions
    .filter((task) => Boolean(task.attention))
    .map((task) => ({ task, issue: entry.issue })))

  let issueList: React.ReactNode
  if (loading && !board.length) {
    issueList = <p className="sidebar-empty" role="status">{t("app.loading")}</p>
  } else if (!board.length) {
    issueList = <p className="sidebar-empty">{t("sidebar.noIssues")}</p>
  } else {
    issueList = board.map((entry) => {
      const expanded = expandedIssueId === entry.issue.id
      const selected = activeIssueId === entry.issue.id
      return (
        <div
          key={entry.issue.id}
          className="sidebar-issue-row"
          data-active={selected || expanded ? "true" : "false"}
        >
          <button
            type="button"
            className="sidebar-issue-main"
            aria-label={t("sidebar.openIssueLead", { title: entry.issue.title })}
            onClick={() => openIssue(entry)}
          >
            <ScrollingIssueTitle title={entry.issue.title} />
          </button>
          <button
            type="button"
            className="sidebar-issue-toggle"
            aria-label={t(expanded ? "sidebar.collapseIssue" : "sidebar.expandIssue", { title: entry.issue.title })}
            aria-expanded={expanded}
            onClick={() => setExpandedIssueId((current) => current === entry.issue.id ? null : entry.issue.id)}
          >
            {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}
          </button>
        </div>
      )
    })
  }

  const expandedEntry = expandedIssueId
    ? board.find((entry) => entry.issue.id === expandedIssueId)
    : undefined

  return (
    <aside className="sidebar-surface" aria-label={t("sidebar.title")}>
      <div className="sidebar-workspace-row">
        <label className="sr-only" htmlFor="sidebar-workspace-select">{t("workspace.label")}</label>
        <NativeSelect
          className="sidebar-workspace-select"
          id="sidebar-workspace-select"
          size="sm"
          disabled={!workspaces.length}
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
          onClick={() => {
            requestHostAction({ action: "workspace.show" })
            channel?.post({ type: "command", command: "workspace.create" })
          }}
        >
          <Plus aria-hidden="true" />
        </Button>
      </div>

      <div className="sidebar-primary-actions">
        <Button
          variant="ghost"
          className="sidebar-create-button"
          disabled={!channel}
          onClick={() => {
            requestHostAction({ action: "workspace.show" })
            channel?.post({
              type: "command",
              command: workspaceId ? "issue.create" : "workspace.create",
            })
          }}
        >
          {workspaceId ? <SquarePen aria-hidden="true" /> : <Plus aria-hidden="true" />}
          {workspaceId ? t("issue.create") : t("ws.add")}
        </Button>
      </div>

      <nav className="sidebar-nav" aria-label={t("nav.primary")}>
        <Button
          variant="ghost"
          className="sidebar-nav-button"
          data-active={location.kind === "workspace" && route.view === "kanban" ? "true" : "false"}
          aria-current={location.kind === "workspace" && route.view === "kanban" ? "page" : undefined}
          onClick={() => navigate({ view: "kanban", issueId: null })}
        >
          <KanbanSquare aria-hidden="true" />
          {t("nav.kanban")}
        </Button>
        <Button
          variant="ghost"
          className="sidebar-nav-button"
          data-active={location.kind === "workspace" && route.view === "repos" ? "true" : "false"}
          aria-current={location.kind === "workspace" && route.view === "repos" ? "page" : undefined}
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
          </div>
          <div className="sidebar-list">{issueList}</div>
          {expandedEntry ? (
            <section className="sidebar-expanded-issue" aria-label={expandedEntry.issue.title}>
              <div className="sidebar-expanded-issue-header">
                <ScrollingIssueTitle title={expandedEntry.issue.title} />
                <button
                  type="button"
                  className="sidebar-issue-toggle"
                  aria-label={t("sidebar.collapseIssue", { title: expandedEntry.issue.title })}
                  aria-expanded={true}
                  onClick={() => setExpandedIssueId(null)}
                >
                  <ChevronDown aria-hidden="true" />
                </button>
              </div>
              <IssueConversationTree
                entry={expandedEntry}
                activeThreadId={activeThreadId}
                onOpenThread={openThread}
              />
            </section>
          ) : null}
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
                  onClick={() => {
                    setExpandedIssueId(issue.id)
                    const entry = board.find((candidate) => candidate.issue.id === issue.id)
                    const thread = entry ? primaryBranch(entry, task.id) : undefined
                    if (thread) openThread(thread.thread_id)
                    else navigate({ view: "issue", issueId: issue.id })
                  }}
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
