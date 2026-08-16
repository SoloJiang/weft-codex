import * as React from "react"
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Star,
  FileText,
  FolderGit2,
  Inbox,
  KanbanSquare,
  MessageCircle,
  Plus,
  Search,
  SquarePen,
  X,
} from "lucide-react"

import { api, jsonRequest } from "@/api"
import { kindLabel, statusLabel } from "@/components/artifact-view"
import { AsyncButton } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useI18n } from "@/i18n"
import { useWeftSession } from "@/session"
import { useWeftWorkspace } from "@/workspace-store"
import {
  buildInbox,
  type InboxItem,
  type SearchHit,
  searchBoard,
} from "@/lib/sidebar-entries"
import {
  sidebarFooter,
  THREAD_RESOLVE_DELAYS_MS,
  threadLinkStatus,
  type SidebarFooter,
} from "@/lib/thread-resolve"
import { isTypingTarget } from "@/lib/utils"
import type { SurfaceRoute } from "@/route"
import type {
  ArtifactSummary,
  BoardEntry,
  ThreadBinding,
  ThreadLocationResponse,
} from "@/types"

/** Only one of the two header entries can be open; neither is the default. */
type SidebarPanel = "none" | "search" | "inbox"

interface ResolvedThread {
  binding: ThreadBinding
  workspaceId: number
}

type SidebarLocation =
  | { kind: "workspace"; route: SurfaceRoute }
  | { kind: "bound-thread"; threadId: string; binding: ThreadBinding }
  | { kind: "unbound-thread"; threadId: string }

interface ThreadRowProps {
  /** Present only on lead forks that can become the primary chat. */
  onPromote?: (threadId: string) => Promise<void>
  onError?: (error: unknown) => void
  label: string
  threadId: string
  active: boolean
  opening?: boolean
  primary?: boolean
  nested?: boolean
  onOpen: (threadId: string) => void
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
  hostView: "workspace" | "thread",
  threadId: string | undefined,
  route: SurfaceRoute,
  bindings: ReadonlyMap<string, ThreadBinding>,
): SidebarLocation {
  if (!threadId || hostView !== "thread") {
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
  opening = false,
  primary = false,
  nested = false,
  onOpen,
  onPromote,
  onError,
}: ThreadRowProps) {
  const { t } = useI18n()
  const openingLabel = t("loading.openingThread")
  const row = (
    <button
      type="button"
      className="sidebar-thread-row"
      data-active={active ? "true" : "false"}
      data-nested={nested ? "true" : "false"}
      data-opening={opening ? "true" : "false"}
      aria-busy={opening}
      aria-current={active ? "page" : undefined}
      disabled={opening}
      onClick={() => onOpen(threadId)}
    >
      {nested ? <CornerDownRight aria-hidden="true" /> : <MessageCircle aria-hidden="true" />}
      <span className="sidebar-thread-title" title={opening ? openingLabel : label}>
        {opening ? openingLabel : label}
      </span>
      {primary ? <span className="sidebar-primary-chip">{t("sidebar.primary")}</span> : null}
    </button>
  )
  if (!onPromote) return row
  // The promote control is a sibling, not a child: a button inside a button is
  // invalid and screen readers flatten it unpredictably.
  return (
    <div className="sidebar-thread-row-wrap">
      {row}
      <AsyncButton
        variant="ghost"
        size="icon-sm"
        className="sidebar-thread-promote"
        label={t("sidebar.makePrimary", { label })}
        pendingLabel={t("sidebar.makingPrimary")}
        onAction={() => onPromote(threadId)}
        onError={onError ?? (() => {})}
        iconOnly
      >
        <Star aria-hidden="true" />
      </AsyncButton>
    </div>
  )
}

function SidebarStatusFooter({
  footer,
  onRetry,
}: {
  footer: SidebarFooter
  onRetry: (threadId: string) => void
}) {
  const { t } = useI18n()
  if (footer.kind === "none") return null
  if (footer.kind === "retry") {
    return (
      <footer className="sidebar-footer">
        <span className="sidebar-error" role="alert" title={t("err.prefix") + t("err.threadOpen")}>
          {t("err.prefix") + t("err.threadOpen")}
        </span>
        <Button
          variant="ghost"
          size="xs"
          className="sidebar-footer-retry"
          onClick={() => onRetry(footer.threadId)}
        >
          {t("action.retryOpenThread")}
        </Button>
      </footer>
    )
  }
  if (footer.kind === "linking") {
    return (
      <footer className="sidebar-footer">
        <span className="sidebar-status" role="status">{t("sidebar.linkingThread")}</span>
      </footer>
    )
  }
  return (
    <footer className="sidebar-footer">
      <span className="sidebar-status" role="status">{t("sidebar.unboundThread")}</span>
    </footer>
  )
}

function IssueConversationTree({
  entry,
  activeThreadId,
  openingThreadId,
  onOpenThread,
  onPromoteLead,
  onError,
}: {
  entry: BoardEntry
  activeThreadId: string | null
  openingThreadId: string | null
  onOpenThread: (threadId: string) => void
  onPromoteLead: (threadId: string) => Promise<void>
  onError: (error: unknown) => void
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
              opening={openingThreadId === leadPrimary.thread_id}
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
              opening={openingThreadId === binding.thread_id}
              nested
              onOpen={onOpenThread}
              onPromote={onPromoteLead}
              onError={onError}
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
                    opening={openingThreadId === taskPrimary.thread_id}
                    onOpen={onOpenThread}
                  />
                  {taskForks.map((binding, index) => (
                    <ThreadRow
                      key={binding.thread_id}
                      label={branchTitle(binding, index + 1, t("sidebar.forkChat"))}
                      threadId={binding.thread_id}
                      active={activeThreadId === binding.thread_id}
                      opening={openingThreadId === binding.thread_id}
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

/**
 * Progressive disclosure: the sidebar says an artifact exists, what state it is
 * in and which revision — the document itself opens in the workspace. Status is
 * text, not a colour, because the product bar forbids colour-only state.
 */
function ArtifactSummaryList({
  artifacts,
  onOpen,
}: {
  artifacts: ArtifactSummary[]
  onOpen: (artifact: ArtifactSummary) => void
}) {
  const { t } = useI18n()
  if (!artifacts.length) return null
  return (
    <div className="sidebar-artifacts">
      <div className="sidebar-artifacts-heading">
        <h3>{t("sidebar.artifacts")}</h3>
        <span>{artifacts.length}</span>
      </div>
      {artifacts.map((artifact) => (
        <button
          key={artifact.id}
          type="button"
          className="sidebar-artifact-row"
          data-status={artifact.status}
          onClick={() => onOpen(artifact)}
        >
          <FileText aria-hidden="true" />
          <span className="sidebar-artifact-name">
            {artifact.title || kindLabel(artifact.kind, t)}
          </span>
          <span className="sidebar-artifact-meta">
            {statusLabel(artifact.status, t)} · {t("artifact.revision", { revision: artifact.revision })}
          </span>
        </button>
      ))}
    </div>
  )
}

/**
 * The same two entries the host renders in its sidebar header, drawn here when
 * it cannot. The capability must not depend on a host structure we do not own:
 * the browser path has no host at all, and a Codex release that reshapes the
 * mode row would otherwise take search and the inbox down with it.
 */
function HeaderEntries({
  inboxCount,
  panel,
  onOpen,
}: {
  inboxCount: number
  panel: SidebarPanel
  onOpen: (panel: SidebarPanel) => void
}) {
  const { t } = useI18n()
  return (
    <div className="sidebar-header-entries">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={t("entries.search")}
        title={t("entries.search")}
        data-active={panel === "search" ? "true" : "false"}
        onClick={() => onOpen("search")}
      >
        <Search aria-hidden="true" />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        className="sidebar-inbox-entry"
        aria-label={inboxCount ? t("entries.inboxCount", { count: inboxCount }) : t("entries.inbox")}
        title={t("entries.inbox")}
        data-active={panel === "inbox" ? "true" : "false"}
        onClick={() => onOpen("inbox")}
      >
        <Inbox aria-hidden="true" />
        {inboxCount ? (
          <span className="sidebar-inbox-badge" aria-hidden="true">
            {inboxCount > 99 ? "99+" : inboxCount}
          </span>
        ) : null}
      </Button>
    </div>
  )
}

function SearchPanel({
  hits,
  query,
  onQuery,
  onOpenHit,
}: {
  hits: SearchHit[]
  query: string
  onQuery: (value: string) => void
  onOpenHit: (hit: SearchHit) => void
}) {
  const { t } = useI18n()
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => { inputRef.current?.focus() }, [])

  const kindLabels: Record<SearchHit["kind"], string> = {
    issue: t("entries.kind.issue"),
    direction: t("entries.kind.direction"),
    artifact: t("entries.kind.artifact"),
    thread: t("entries.kind.thread"),
  }

  let results: React.ReactNode = null
  if (query.trim() && !hits.length) {
    results = <p className="sidebar-empty" role="status">{t("entries.noMatches")}</p>
  } else if (hits.length) {
    results = hits.map((hit) => (
      <button
        key={hit.key}
        type="button"
        className="sidebar-result-row"
        onClick={() => onOpenHit(hit)}
      >
        <span className="sidebar-result-kind">{kindLabels[hit.kind]}</span>
        <span>
          <span className="sidebar-row-title">{hit.title}</span>
          <span className="sidebar-row-meta">{hit.meta}</span>
        </span>
      </button>
    ))
  }

  return (
    <>
      <div className="sidebar-search-field">
        <Search aria-hidden="true" />
        <Input
          ref={inputRef}
          type="search"
          value={query}
          aria-label={t("entries.searchLabel")}
          placeholder={t("entries.searchPlaceholder")}
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <div className="sidebar-panel-list">{results}</div>
    </>
  )
}

function InboxPanel({
  items,
  onOpenItem,
}: {
  items: InboxItem[]
  onOpenItem: (item: InboxItem) => void
}) {
  const { t } = useI18n()
  if (!items.length) {
    return <p className="sidebar-empty" role="status">{t("entries.inboxEmpty")}</p>
  }
  return (
    <div className="sidebar-panel-list">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          className="sidebar-attention-row"
          onClick={() => onOpenItem(item)}
        >
          <AlertTriangle aria-hidden="true" />
          <span>
            <span className="sidebar-row-title">{item.title}</span>
            <span className="sidebar-row-meta">{item.meta}</span>
          </span>
        </button>
      ))}
    </div>
  )
}

export default function SidebarApp() {
  const { t } = useI18n()
  const session = useWeftSession()
  const store = useWeftWorkspace()
  const workspaceId = session.workspaceId
  const route = session.route
  const { workspaces, board, repos, loading, deliveryFailures } = store
  const [panel, setPanel] = React.useState<SidebarPanel>("none")
  const [query, setQuery] = React.useState("")
  const [expandedIssueId, setExpandedIssueId] = React.useState<number | null>(null)
  const [resolvedThreads, setResolvedThreads] = React.useState<Map<string, ResolvedThread>>(
    () => new Map(),
  )
  const resolveSequence = React.useRef(0)
  const [resolveExhausted, setResolveExhausted] = React.useState(false)
  const stateRef = React.useRef({ workspaceId, route })
  const threadMap = React.useMemo(
    () => buildThreadMap(board, resolvedThreads),
    [board, resolvedThreads],
  )
  const location = React.useMemo(
    () => deriveLocation(session.hostView, session.threadId, route, threadMap),
    [session.hostView, session.threadId, route, threadMap],
  )
  stateRef.current = { workspaceId, route }

  React.useEffect(() => {
    if (location.kind !== "unbound-thread") {
      setResolveExhausted(false)
      return
    }
    const sequence = resolveSequence.current + 1
    resolveSequence.current = sequence
    setResolveExhausted(false)
    let cancelled = false
    const resolve = async () => {
      for (const delay of THREAD_RESOLVE_DELAYS_MS) {
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
          session.setWorkspaceId(response.workspaceId)
          session.navigate({ view: "kanban", issueId: null })
        }
        return
      }
      if (!cancelled && resolveSequence.current === sequence) {
        setResolveExhausted(true)
      }
    }
    void resolve()
    return () => { cancelled = true }
  }, [location, session])

  const footer = sidebarFooter(
    session.failedThreadId,
    threadLinkStatus(location.kind, resolveExhausted),
  )

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
    session.navigate(next)
  }, [session])

  const selectWorkspace = React.useCallback((id: number) => {
    setExpandedIssueId(null)
    session.selectWorkspace(id)
  }, [session])

  const openThread = React.useCallback((threadId: string) => {
    void session.openThread(threadId).catch(() => {
      // Session keeps failedThreadId so the footer can offer a retry.
    })
  }, [session])

  /**
   * Opening an artifact must NOT change the native thread: the human is reading
   * a document, not switching conversations. Only the workspace surface moves.
   */
  const openArtifact = React.useCallback((artifact: ArtifactSummary) => {
    navigate({ view: "artifact", issueId: artifact.issue_id, artifactId: artifact.id })
  }, [navigate])

  /**
   * Make a lead fork the issue's primary chat.
   *
   * The canonical pointer is what `thread_for` reads, so every later bus
   * delivery follows immediately — no other bookkeeping, and the fork keeps its
   * ancestry.
   */
  const promoteLead = React.useCallback(async (issueId: number, threadId: string) => {
    await api(`/api/issues/${issueId}/lead-thread`, jsonRequest("POST", { thread_id: threadId }))
    await store.refreshCurrent()
  }, [store])

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

  const deferredQuery = React.useDeferredValue(query)
  const searchHits = React.useMemo(
    () => searchBoard(board, repos, deferredQuery),
    [board, repos, deferredQuery],
  )
  const inboxItems = React.useMemo(
    () => buildInbox(board, deliveryFailures),
    [board, deliveryFailures],
  )

  React.useEffect(() => {
    return session.host.onCommand((command) => {
      setPanel(command === "search.open" ? "search" : "inbox")
    })
  }, [session.host])

  // Slash focuses Weft search. ⌘K is not ours to take: the host binds it to
  // its command menu.
  React.useEffect(() => {
    const openSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
      event.preventDefault()
      setPanel("search")
    }
    window.addEventListener("keydown", openSearch)
    return () => window.removeEventListener("keydown", openSearch)
  }, [])

  // The host paints the badge but never counts: the board lives here.
  React.useEffect(() => { session.host.setInboxCount(inboxItems.length) }, [inboxItems.length, session.host])

  const closePanel = React.useCallback(() => {
    setPanel("none")
    setQuery("")
  }, [])

  // Escape has to work wherever focus went — clicking a result list, then the
  // panel background, used to leave the only exit as the close button.
  React.useEffect(() => {
    if (panel === "none") return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return
      event.preventDefault()
      closePanel()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [panel, closePanel])

  const openDirectionThread = React.useCallback((issueId: number, directionId?: number) => {
    const entry = board.find((candidate) => candidate.issue.id === issueId)
    setExpandedIssueId(issueId)
    const binding = entry && directionId !== undefined
      ? primaryBranch(entry, directionId)
      : undefined
    if (binding) {
      openThread(binding.thread_id)
      return
    }
    navigate({ view: "issue", issueId })
  }, [board, navigate, openThread])

  const openHit = React.useCallback((hit: SearchHit) => {
    closePanel()
    if (hit.threadId) {
      setExpandedIssueId(hit.issueId)
      openThread(hit.threadId)
      return
    }
    if (hit.artifactId !== undefined) {
      navigate({ view: "artifact", issueId: hit.issueId, artifactId: hit.artifactId })
      return
    }
    const entry = board.find((candidate) => candidate.issue.id === hit.issueId)
    if (entry) {
      openIssue(entry)
      return
    }
    navigate({ view: "issue", issueId: hit.issueId })
  }, [board, closePanel, navigate, openIssue, openThread])

  const openInboxItem = React.useCallback((item: InboxItem) => {
    closePanel()
    if (item.failureKey) {
      // Acting on it is the only acknowledgement there is; the bus event will
      // not fire again for a failure that already happened.
      store.dismissDeliveryFailure(item.failureKey)
    }
    openDirectionThread(item.issueId, item.directionId)
  }, [closePanel, openDirectionThread, store])

  const headerActionsAreNative = session.headerActions === "native"

  let issueList: React.ReactNode
  if (loading && !board.length) {
    issueList = <p className="sidebar-empty" role="status">{t("app.loading")}</p>
  } else if (!board.length) {
    issueList = <p className="sidebar-empty">{t("sidebar.noIssues")}</p>
  } else {
    issueList = board.map((entry) => {
      const expanded = expandedIssueId === entry.issue.id
      const selected = activeIssueId === entry.issue.id
      const leadThreadId = primaryBranch(entry, null)?.thread_id || entry.issue.lead_codex_thread_id
      const opening = Boolean(leadThreadId) && session.openingThreadId === leadThreadId
      return (
        <div
          key={entry.issue.id}
          className="sidebar-issue-row"
          data-active={selected || expanded ? "true" : "false"}
        >
          <button
            type="button"
            className="sidebar-issue-main"
            data-opening={opening ? "true" : "false"}
            aria-busy={opening}
            disabled={opening}
            aria-label={opening
              ? t("loading.openingThread")
              : t("sidebar.openIssueLead", { title: entry.issue.title })}
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
        <Select
          value={workspaceId ? String(workspaceId) : undefined}
          disabled={!workspaces.length}
          onValueChange={(value) => selectWorkspace(Number(value))}
        >
          <SelectTrigger
            className="sidebar-workspace-select"
            id="sidebar-workspace-select"
            aria-label={t("workspace.label")}
          >
            <SelectValue placeholder={t("workspace.none")} />
          </SelectTrigger>
          <SelectContent>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={String(workspace.id)}>{workspace.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("ws.add")}
          title={t("ws.add")}
          onClick={() => session.openDialog({ type: "workspace" })}
        >
          <Plus aria-hidden="true" />
        </Button>
        {headerActionsAreNative ? null : (
          <HeaderEntries inboxCount={inboxItems.length} panel={panel} onOpen={setPanel} />
        )}
      </div>

      {workspaceId ? (
        <div className="sidebar-primary-actions">
          <Button
            variant="ghost"
            className="sidebar-create-button"
            onClick={() => session.openDialog({ type: "issue" })}
          >
            <SquarePen aria-hidden="true" />
            {t("issue.create")}
          </Button>
        </div>
      ) : null}

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
                openingThreadId={session.openingThreadId}
                onOpenThread={openThread}
                onPromoteLead={(threadId) => promoteLead(expandedEntry.issue.id, threadId)}
                onError={store.notifyError}
              />
              <ArtifactSummaryList
                artifacts={expandedEntry.artifacts ?? []}
                onOpen={openArtifact}
              />
            </section>
          ) : null}
        </section>

      </div>

      {panel === "none" ? null : (
        <section
          className="sidebar-panel"
          aria-label={t(panel === "search" ? "entries.search" : "entries.inbox")}
        >
          <header className="sidebar-panel-header">
            <h2>{t(panel === "search" ? "entries.search" : "entries.inbox")}</h2>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("entries.close")}
              title={t("entries.close")}
              onClick={closePanel}
            >
              <X aria-hidden="true" />
            </Button>
          </header>
          {panel === "search" ? (
            <SearchPanel hits={searchHits} query={query} onQuery={setQuery} onOpenHit={openHit} />
          ) : (
            <InboxPanel items={inboxItems} onOpenItem={openInboxItem} />
          )}
        </section>
      )}

      <SidebarStatusFooter footer={footer} onRetry={openThread} />
    </aside>
  )
}
