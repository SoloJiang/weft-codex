import * as React from "react"
import {
  AlertTriangle,
  FolderGit2,
  KanbanSquare,
  MessageCircle,
  Plus,
  SquarePen,
} from "lucide-react"

import { api, jsonRequest } from "@/api"
import { IssueConversationCard } from "@/components/issue-conversation-panel"
import { openCodexThread } from "@/components/shared"
import { Button } from "@/components/ui/button"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import type { HostContextV1 } from "@/host-context"
import { requestHostAction, subscribeIssuePanelState } from "@/host-context"
import { useI18n } from "@/i18n"
import { primaryBranch } from "@/lib/thread-bindings"
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

interface LocalIssuePanel {
  entry: BoardEntry
  top: number
}

type MarqueeStyle = React.CSSProperties & {
  "--sidebar-marquee-duration": string
  "--sidebar-marquee-scroll-distance": string
  "--sidebar-marquee-scroll-timing": string
}

const NATIVE_MARQUEE_HOLD_SECONDS = 0.35
const NATIVE_MARQUEE_SPEED_EM_PER_SECOND = 2
const NATIVE_MARQUEE_STEPS = 128
const NATIVE_MARQUEE_CURVE = { x1: 0.49, y1: 0.6, x2: 0.7, y2: 1 }

function marqueePoint(progress: number, elapsed: number, total: number): string {
  return `${progress.toFixed(4)} ${((elapsed / total) * 100).toFixed(4)}%`
}

function nativeMarqueeStyle(distance: number, speedPxPerSecond: number): MarqueeStyle {
  const movementSeconds = distance / speedPxPerSecond
  const totalSeconds = NATIVE_MARQUEE_HOLD_SECONDS + movementSeconds
  const points = [marqueePoint(0, 0, totalSeconds)]

  for (let index = 0; index <= NATIVE_MARQUEE_STEPS; index += 1) {
    const time = index / NATIVE_MARQUEE_STEPS
    const inverse = 1 - time
    const first = 3 * inverse ** 2 * time
    const second = 3 * inverse * time ** 2
    const last = time ** 3
    const progress = first * NATIVE_MARQUEE_CURVE.y1
      + second * NATIVE_MARQUEE_CURVE.y2
      + last
    const curveTime = first * NATIVE_MARQUEE_CURVE.x1
      + second * NATIVE_MARQUEE_CURVE.x2
      + last
    points.push(marqueePoint(
      progress,
      NATIVE_MARQUEE_HOLD_SECONDS + movementSeconds * curveTime,
      totalSeconds,
    ))
  }

  return {
    "--sidebar-marquee-duration": `${totalSeconds.toFixed(3)}s`,
    "--sidebar-marquee-scroll-distance": `${distance}px`,
    "--sidebar-marquee-scroll-timing": `linear(${points.join(", ")})`,
  }
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

function ScrollingIssueTitle({ title }: { title: string }) {
  const viewportRef = React.useRef<HTMLSpanElement>(null)
  const contentRef = React.useRef<HTMLSpanElement>(null)
  const [style, setStyle] = React.useState<MarqueeStyle | null>(null)

  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || !content) return

    const updateOverflow = () => {
      const viewportWidth = viewport.getBoundingClientRect().width
      const contentWidth = Math.max(content.getBoundingClientRect().width, content.scrollWidth)
      const distance = contentWidth - viewportWidth
      if (viewportWidth <= 0 || distance <= 1) {
        setStyle(null)
        return
      }

      const computed = getComputedStyle(content)
      const fontSize = Number.parseFloat(computed.fontSize) || 13
      const configuredSpeed = Number.parseFloat(
        computed.getPropertyValue("--marquee-speed-em-per-second"),
      )
      const speedEmPerSecond = Number.isFinite(configuredSpeed) && configuredSpeed > 0
        ? configuredSpeed
        : NATIVE_MARQUEE_SPEED_EM_PER_SECOND
      const next = nativeMarqueeStyle(distance, fontSize * speedEmPerSecond)
      setStyle((current) => {
        if (
          current?.["--sidebar-marquee-duration"] === next["--sidebar-marquee-duration"]
          && current["--sidebar-marquee-scroll-distance"]
            === next["--sidebar-marquee-scroll-distance"]
        ) return current
        return next
      })
    }
    updateOverflow()

    const observer = new ResizeObserver(updateOverflow)
    observer.observe(viewport)
    observer.observe(content)
    return () => observer.disconnect()
  }, [title])

  return (
    <span
      ref={viewportRef}
      className="sidebar-issue-title-marquee"
      data-overflow={style ? "true" : "false"}
      style={style ?? undefined}
      title={title}
    >
      <span className="sidebar-issue-title-clip">
        <span className="sidebar-issue-title-track">
          <span ref={contentRef} className="sidebar-row-title">{title}</span>
        </span>
      </span>
    </span>
  )
}

export default function SidebarApp({ hostContext }: { hostContext: HostContextV1 | null }) {
  const { t, lang } = useI18n()
  const [workspaces, setWorkspaces] = React.useState<Workspace[]>([])
  const [workspaceId, setWorkspaceId] = React.useState<number | null>(readInitialWorkspaceId)
  const [board, setBoard] = React.useState<BoardEntry[]>([])
  const [route, setRoute] = React.useState<SurfaceRoute>(readInitialRoute)
  const [panelIssueId, setPanelIssueId] = React.useState<number | null>(null)
  const [localPanel, setLocalPanel] = React.useState<LocalIssuePanel | null>(null)
  const [resolvedThreads, setResolvedThreads] = React.useState<Map<string, ResolvedThread>>(
    () => new Map(),
  )
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState("")
  const sidebarRef = React.useRef<HTMLElement>(null)
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
  let activeThreadId: string | null = null
  if (location.kind === "bound-thread") {
    activeIssueId = location.binding.issue_id
    activeThreadId = location.threadId
  } else if (location.kind === "workspace" && location.route.view === "issue") {
    activeIssueId = location.route.issueId
  }

  React.useEffect(() => subscribeIssuePanelState(setPanelIssueId), [])

  React.useEffect(() => {
    if (!localPanel) return
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      if (target.closest(".sidebar-local-issue-panel")) return
      if (target.closest(".sidebar-issue-panel-button")) return
      setLocalPanel(null)
      setPanelIssueId(null)
    }
    document.addEventListener("pointerdown", onPointerDown, true)
    return () => document.removeEventListener("pointerdown", onPointerDown, true)
  }, [localPanel])

  const closeIssuePanel = React.useCallback(() => {
    setPanelIssueId(null)
    setLocalPanel(null)
    requestHostAction({ action: "issue-panel.close" })
  }, [])

  const navigate = React.useCallback((next: SurfaceRoute) => {
    closeIssuePanel()
    requestHostAction({ action: "workspace.show" })
    setRoute(next)
    channel?.post({ type: "navigate", view: next.view, issueId: next.issueId })
  }, [channel, closeIssuePanel])

  const selectWorkspace = React.useCallback((id: number) => {
    closeIssuePanel()
    requestHostAction({ action: "workspace.show" })
    setWorkspaceId(id)
    setRoute({ view: "kanban", issueId: null })
    channel?.post({ type: "workspace.select", workspaceId: id })
    channel?.post({ type: "navigate", view: "kanban", issueId: null })
  }, [channel, closeIssuePanel])

  const openThread = React.useCallback((threadId: string) => {
    closeIssuePanel()
    setError("")
    void openCodexThread(threadId).catch(() => {
      setError(t("err.prefix") + t("err.threadOpen"))
    })
  }, [closeIssuePanel, t])

  const openIssue = React.useCallback((entry: BoardEntry) => {
    const primary = primaryBranch(entry, null)
    const threadId = primary?.thread_id || entry.issue.lead_codex_thread_id
    if (threadId) {
      openThread(threadId)
      return
    }
    navigate({ view: "issue", issueId: entry.issue.id })
  }, [navigate, openThread])

  const toggleIssuePanel = React.useCallback((
    entry: BoardEntry,
    button: HTMLButtonElement,
  ) => {
    const rect = button.getBoundingClientRect()
    const anchor = {
      top: rect.top,
      right: rect.right,
      bottom: rect.bottom,
      left: rect.left,
      width: rect.width,
      height: rect.height,
    }
    const handled = requestHostAction({
      action: "issue-panel.toggle",
      workspaceId: entry.issue.workspace_id,
      issueId: entry.issue.id,
      anchor,
    })
    if (handled) {
      setLocalPanel(null)
      setPanelIssueId((current) => current === entry.issue.id ? null : entry.issue.id)
      return
    }

    const asideRect = sidebarRef.current?.getBoundingClientRect()
    if (!asideRect) return
    if (localPanel?.entry.issue.id === entry.issue.id) {
      setLocalPanel(null)
      setPanelIssueId(null)
      return
    }
    const maxHeight = Math.min(420, window.innerHeight - 32)
    const maxTop = Math.max(8, asideRect.height - maxHeight - 8)
    const top = Math.min(Math.max(8, rect.top - asideRect.top - 8), maxTop)
    setLocalPanel({ entry, top })
    setPanelIssueId(entry.issue.id)
  }, [localPanel])

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
      const panelOpen = panelIssueId === entry.issue.id
      const selected = activeIssueId === entry.issue.id
      return (
        <div
          key={entry.issue.id}
          className="sidebar-issue-row"
          data-active={selected || panelOpen ? "true" : "false"}
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
            className="sidebar-issue-panel-button"
            aria-label={t("sidebar.showConversations", { title: entry.issue.title })}
            aria-haspopup="dialog"
            aria-expanded={panelOpen}
            data-active={panelOpen ? "true" : "false"}
            onClick={(event) => toggleIssuePanel(entry, event.currentTarget)}
          >
            <MessageCircle aria-hidden="true" />
          </button>
        </div>
      )
    })
  }

  return (
    <aside ref={sidebarRef} className="sidebar-surface" aria-label={t("sidebar.title")}>
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
            closeIssuePanel()
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
            closeIssuePanel()
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

      <div
        className="sidebar-scroll"
        onScroll={() => {
          if (panelIssueId !== null) closeIssuePanel()
        }}
      >
        <section className="sidebar-section" aria-labelledby="sidebar-issues-heading">
          <div className="sidebar-section-heading">
            <h2 id="sidebar-issues-heading">{t("sidebar.issues")}</h2>
          </div>
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
                  onClick={() => {
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

      {localPanel ? (
        <div className="sidebar-local-issue-panel" style={{ top: localPanel.top }}>
          <IssueConversationCard
            entry={localPanel.entry}
            activeThreadId={activeThreadId}
            onOpenThread={openThread}
            onClose={closeIssuePanel}
            autoFocus
          />
        </div>
      ) : null}

      {error ? (
        <footer className="sidebar-footer">
          <span className="sidebar-error" role="alert" title={error}>{error}</span>
        </footer>
      ) : null}
    </aside>
  )
}
