import * as React from "react"
import { Check, Flag, ListTree, MoreHorizontal, Play, RotateCcw, Search } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { useI18n } from "@/i18n"
import type { BoardEntry, Direction, DirectionStatus, Issue, Repo } from "@/types"
import { STATUSES } from "@/types"
import { AsyncButton, EmptyState, ThreadCardLink, ThreadLink } from "./shared"

export interface WorkActions {
  onError: (error: unknown) => void
  onStartLead: (issue: Issue) => Promise<void>
  onRetryTask: (direction: Direction) => Promise<void>
  onCompleteTask: (direction: Direction) => Promise<void>
  onClearAttention: (direction: Direction) => Promise<void>
}

export function directionMeta(
  direction: Direction,
  repos: Repo[],
): string {
  const repo = repos.find((candidate) => candidate.id === direction.repo_id)
  const parts: string[] = []
  if (repo?.name) parts.push(repo.name)
  if (direction.branch) parts.push(direction.branch)
  return parts.join(" · ")
}

function attentionLabel(direction: Direction, t: ReturnType<typeof useI18n>["t"]): string {
  if (direction.attention_reason === "worker-start-failed") return t("dir.startFailed")
  return direction.attention_reason || t("dir.attention")
}

export function DirectionActions({
  direction,
  actions,
}: {
  direction: Direction
  actions: WorkActions
}) {
  const { t } = useI18n()
  const canRetryStart = !direction.codex_thread_id && Boolean(direction.attention)
  const canComplete = direction.status === "review"
  const canClearAttention = Boolean(direction.attention) && !canRetryStart
  if (!canRetryStart && !canComplete && !canClearAttention) return null
  return (
    <div className="btns">
      {canRetryStart ? (
        <AsyncButton
          variant="ghost"
          label={t("dir.retryStart")}
          pendingLabel={t("loading.retryingTask")}
          onAction={() => actions.onRetryTask(direction)}
          onError={actions.onError}
        >
          <RotateCcw aria-hidden="true" />
        </AsyncButton>
      ) : null}
      {canComplete ? (
        <AsyncButton
          className="task-complete-action"
          label={t("dir.complete")}
          pendingLabel={t("loading.completingTask")}
          onAction={() => actions.onCompleteTask(direction)}
          onError={actions.onError}
        >
          <Check aria-hidden="true" />
        </AsyncButton>
      ) : null}
      {canClearAttention ? (
        <AsyncButton
          variant="ghost"
          label={t("dir.clearAttention")}
          pendingLabel={t("loading.clearingFlag")}
          onAction={() => actions.onClearAttention(direction)}
          onError={actions.onError}
        >
          <Flag aria-hidden="true" />
        </AsyncButton>
      ) : null}
    </div>
  )
}

export function IssueActions({ issue, actions }: { issue: Issue; actions: WorkActions }) {
  const { t } = useI18n()
  return (
    <div className="issue-actions">
      {issue.lead_codex_thread_id ? (
        <ThreadLink threadId={issue.lead_codex_thread_id} onError={actions.onError} />
      ) : (
        <AsyncButton
          variant="ghost"
          label={t("issue.spawnLead")}
          pendingLabel={t("loading.startingLead")}
          onAction={() => actions.onStartLead(issue)}
          onError={actions.onError}
        >
          <Play aria-hidden="true" />
        </AsyncButton>
      )}
    </div>
  )
}

interface KanbanTask {
  direction: Direction
  entry: BoardEntry
}

function TaskCardActions({
  direction,
  actions,
  onOpenIssue,
}: {
  direction: Direction
  actions: WorkActions
  onOpenIssue: () => void
}) {
  const { t } = useI18n()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const menuRef = React.useRef<HTMLDivElement>(null)
  const canComplete = direction.status === "review"
  const canRetryStart = !direction.codex_thread_id && Boolean(direction.attention)
  const canClearAttention = Boolean(direction.attention) && !canRetryStart

  React.useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return
      setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false)
    }
    document.addEventListener("pointerdown", closeOutside)
    document.addEventListener("keydown", closeOnEscape)
    return () => {
      document.removeEventListener("pointerdown", closeOutside)
      document.removeEventListener("keydown", closeOnEscape)
    }
  }, [menuOpen])

  let primaryAction: React.ReactNode = null
  if (canRetryStart) {
    primaryAction = (
      <AsyncButton
        variant="ghost"
        label={t("dir.retryStart")}
        pendingLabel={t("loading.retryingTask")}
        onAction={() => actions.onRetryTask(direction)}
        onError={actions.onError}
      >
        <RotateCcw aria-hidden="true" />
      </AsyncButton>
    )
  }

  return (
    <div className="kanban-card-actions">
      {primaryAction}
      <div ref={menuRef} className="kanban-card-menu">
        <Button
          variant="ghost"
          size="icon-sm"
          className="kanban-card-menu-trigger"
          aria-label={t("kanban.moreActions")}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t("kanban.moreActions")}
          onClick={() => setMenuOpen((current) => !current)}
        >
          <MoreHorizontal aria-hidden="true" />
        </Button>
        {menuOpen ? (
          <div className="kanban-card-menu-popover" role="menu">
            <Button
              variant="ghost"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false)
                onOpenIssue()
              }}
            >
              <ListTree aria-hidden="true" />
              {t("kanban.viewIssue")}
            </Button>
            {canComplete ? (
              <AsyncButton
                variant="ghost"
                label={t("dir.complete")}
                pendingLabel={t("loading.completingTask")}
                role="menuitem"
                onAction={async () => {
                  await actions.onCompleteTask(direction)
                  setMenuOpen(false)
                }}
                onError={actions.onError}
              >
                <Check aria-hidden="true" />
              </AsyncButton>
            ) : null}
            {canClearAttention ? (
              <AsyncButton
                variant="ghost"
                label={t("dir.clearAttention")}
                pendingLabel={t("loading.clearingFlag")}
                role="menuitem"
                onAction={async () => {
                  await actions.onClearAttention(direction)
                  setMenuOpen(false)
                }}
                onError={actions.onError}
              >
                <Flag aria-hidden="true" />
              </AsyncButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function TaskCard({
  task,
  repos,
  actions,
  onOpenIssue,
}: {
  task: KanbanTask
  repos: Repo[]
  actions: WorkActions
  onOpenIssue: (id: number) => void
}) {
  const { t } = useI18n()
  const { direction, entry } = task
  const meta = directionMeta(direction, repos)
  return (
    <article
      className={`kanban-card${direction.attention ? " attention" : ""}`}
    >
      {direction.codex_thread_id ? (
        <ThreadCardLink
          threadId={direction.codex_thread_id}
          label={t("dir.openTaskChat", { name: direction.name })}
          onError={actions.onError}
        />
      ) : null}
      <div className="kanban-card-issue">
        <span className="kanban-card-issue-number">#{entry.issue.id}</span>
        <span className="kanban-card-issue-title">{entry.issue.title}</span>
      </div>
      <h3 className="name">
        {direction.name}
        {direction.attention ? (
          <span className="badge">{attentionLabel(direction, t)}</span>
        ) : null}
      </h3>
      {meta ? <div className="sub">{meta}</div> : null}
      <TaskCardActions
        direction={direction}
        actions={actions}
        onOpenIssue={() => onOpenIssue(entry.issue.id)}
      />
    </article>
  )
}

function KanbanColumn({
  status,
  tasks,
  repos,
  actions,
  onOpenIssue,
}: {
  status: DirectionStatus
  tasks: KanbanTask[]
  repos: Repo[]
  actions: WorkActions
  onOpenIssue: (id: number) => void
}) {
  const { t } = useI18n()
  const headingId = `kanban-status-${status}`
  const statusTasks = tasks.filter((task) => task.direction.status === status)

  return (
    <section className="kanban-column" aria-labelledby={headingId}>
      <header className="kanban-column-heading">
        <h2 id={headingId}>{t(`status.${status}`)}</h2>
      </header>
      <div className="kanban-column-cards">
        {statusTasks.map((task) => (
          <TaskCard
            key={task.direction.id}
            task={task}
            repos={repos}
            actions={actions}
            onOpenIssue={onOpenIssue}
          />
        ))}
      </div>
    </section>
  )
}

function normalizedSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function taskMatches(task: KanbanTask, query: string, repo: Repo | undefined): boolean {
  if (!query) return true
  const values = [
    task.entry.issue.title,
    task.direction.name,
    task.direction.branch,
    repo?.name ?? "",
  ]
  return values.some((value) => normalizedSearchValue(value).includes(query))
}

export function KanbanView({
  workspaceId,
  repos,
  board,
  actions,
  onOpenCreateIssue,
  onCreateWorkspace,
  onOpenIssue,
}: {
  workspaceId: number | null
  repos: Repo[]
  board: BoardEntry[]
  actions: WorkActions
  onOpenCreateIssue: () => void
  onCreateWorkspace: () => void
  onOpenIssue: (id: number) => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = React.useState("")
  const [issueFilter, setIssueFilter] = React.useState("all")
  const deferredQuery = React.useDeferredValue(query)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const repoById = React.useMemo(
    () => new Map(repos.map((repo) => [repo.id, repo])),
    [repos],
  )
  const tasks = React.useMemo<KanbanTask[]>(
    () => board.flatMap((entry) => entry.directions.map((direction) => ({ direction, entry }))),
    [board],
  )
  const visibleTasks = React.useMemo(() => {
    const normalizedQuery = normalizedSearchValue(deferredQuery)
    return tasks.filter((task) => {
      if (issueFilter !== "all" && String(task.entry.issue.id) !== issueFilter) return false
      return taskMatches(task, normalizedQuery, repoById.get(task.direction.repo_id))
    })
  }, [deferredQuery, issueFilter, repoById, tasks])

  React.useEffect(() => {
    if (issueFilter === "all") return
    if (board.some((entry) => String(entry.issue.id) === issueFilter)) return
    setIssueFilter("all")
  }, [board, issueFilter])

  React.useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLocaleLowerCase() !== "k") return
      event.preventDefault()
      searchRef.current?.focus()
    }
    window.addEventListener("keydown", focusSearch)
    return () => window.removeEventListener("keydown", focusSearch)
  }, [])

  let content: React.ReactNode
  if (!workspaceId) {
    content = <EmptyState titleKey="empty.workspaceTitle" bodyKey="empty.workspaceBody" actionKey="empty.workspaceAction" onAction={onCreateWorkspace} />
  } else if (!board.length) {
    content = <EmptyState titleKey="empty.issuesTitle" bodyKey="empty.issuesBody" actionKey="empty.issuesAction" onAction={onOpenCreateIssue} />
  } else {
    content = (
      <>
        <header className="kanban-toolbar">
          <h1 id="kanban-heading">{t("nav.kanban")}</h1>
          <div className="kanban-search">
            <Search aria-hidden="true" />
            <Input
              ref={searchRef}
              type="search"
              value={query}
              aria-label={t("kanban.searchLabel")}
              placeholder={t("kanban.searchPlaceholder")}
              onChange={(event) => setQuery(event.target.value)}
            />
            <kbd aria-hidden="true">⌘K</kbd>
          </div>
          <label className="sr-only" htmlFor="kanban-issue-filter">{t("kanban.issueFilterLabel")}</label>
          <NativeSelect
            className="kanban-issue-filter"
            id="kanban-issue-filter"
            value={issueFilter}
            onChange={(event) => setIssueFilter(event.target.value)}
          >
            <NativeSelectOption value="all">{t("kanban.allIssues")}</NativeSelectOption>
            {board.map((entry) => (
              <NativeSelectOption key={entry.issue.id} value={entry.issue.id}>
                #{entry.issue.id} {entry.issue.title}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </header>
        {tasks.length && !visibleTasks.length ? (
          <p className="kanban-filter-empty" role="status">{t("kanban.noMatchingTasks")}</p>
        ) : null}
        <div className="kanban-board-scroll">
          <div className="kanban-board" aria-label={t("kanban.boardLabel")}>
            {STATUSES.map((status) => (
              <KanbanColumn
                key={status}
                status={status}
                tasks={visibleTasks}
                repos={repos}
                actions={actions}
                onOpenIssue={onOpenIssue}
              />
            ))}
          </div>
        </div>
      </>
    )
  }

  return (
    <section className="view active" aria-label={t("nav.kanban")}>
      <div id="issues">{content}</div>
    </section>
  )
}
