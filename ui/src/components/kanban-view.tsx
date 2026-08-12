import * as React from "react"
import {
  Check,
  Flag,
  Play,
  RotateCcw,
  Search,
  Send,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/i18n"
import type { BoardEntry, Direction, DirectionStatus, Issue, Repo } from "@/types"
import { STATUSES } from "@/types"
import { buildIssueBoard, groupIssueBoard, type IssueBoardCard } from "@/lib/issue-board"
import { isTypingTarget } from "@/lib/utils"
import { AsyncButton, EmptyState, ThreadLink } from "./shared"

export interface WorkActions {
  onError: (error: unknown) => void
  onStartLead: (issue: Issue) => Promise<void>
  onRetryTask: (direction: Direction) => Promise<void>
  onCompleteTask: (direction: Direction) => Promise<void>
  onClearAttention: (direction: Direction) => Promise<void>
  onContinueTask: (direction: Direction) => void
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


export function DirectionActions({
  direction,
  actions,
}: {
  direction: Direction
  actions: WorkActions
}) {
  const { t } = useI18n()
  const canContinue = direction.status === "review" || direction.status === "done"
  const canRetryStart = !direction.codex_thread_id && Boolean(direction.attention)
  let threadActions: React.ReactNode = null
  if (canRetryStart) {
    threadActions = (
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
  } else if (direction.codex_thread_id) {
    threadActions = (
      <>
        <ThreadLink threadId={direction.codex_thread_id} onError={actions.onError} />
        {canContinue ? (
          <Button variant="ghost" onClick={() => actions.onContinueTask(direction)}>
            <Send aria-hidden="true" />
            {t("dir.continue")}
          </Button>
        ) : null}
      </>
    )
  }
  return (
    <div className="btns">
      {threadActions}
      {direction.status === "review" ? (
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
      {Boolean(direction.attention) && !canRetryStart ? (
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



function IssueBoardCardView({
  card,
  onOpenIssue,
  onOpenLead,
  onError,
}: {
  card: IssueBoardCard
  onOpenIssue: (id: number) => void
  onOpenLead: (entry: BoardEntry) => Promise<void>
  onError: (error: unknown) => void
}) {
  const { t } = useI18n()
  const { entry, status, totalTasks, doneTasks, attentionCount, hasLead } = card
  const signal = attentionCount
    ? t("kanban.issueNeedsYou", { done: doneTasks, total: totalTasks })
    : t("kanban.issueProgress", {
      status: t(`status.${status}`),
      done: doneTasks,
      total: totalTasks,
    })
  return (
    <article
      className={`kanban-card issue-board-card${attentionCount ? " attention" : ""}`}
      aria-label={t("kanban.issueCardLabel", { title: entry.issue.title })}
    >
      <button
        type="button"
        className="kanban-card-issue issue-board-card-body"
        aria-label={t("kanban.openIssueBoard", { title: entry.issue.title })}
        onClick={() => onOpenIssue(entry.issue.id)}
      >
        <span className="kanban-card-issue-number">#{entry.issue.id}</span>
        <span className="kanban-card-issue-title">{entry.issue.title}</span>
        <span className="issue-board-card-signal">{signal}</span>
      </button>
      <div className="kanban-card-actions issue-board-card-actions">
        {hasLead ? (
          <ThreadLink
            threadId={entry.issue.lead_codex_thread_id}
            onError={onError}
            label={t("kanban.openLead", { title: entry.issue.title })}
            pendingLabel={t("loading.openingThread")}
            className="issue-board-lead-link"
            iconOnly
          />
        ) : (
          <AsyncButton
            variant="ghost"
            className="issue-board-lead-link"
            label={t("kanban.startLead", { title: entry.issue.title })}
            pendingLabel={t("loading.startingLead")}
            onAction={() => onOpenLead(entry)}
            onError={onError}
            iconOnly
          >
            <Play aria-hidden="true" />
          </AsyncButton>
        )}
      </div>
    </article>
  )
}

function IssueBoardColumn({
  status,
  cards,
  onOpenIssue,
  onOpenLead,
  onError,
}: {
  status: DirectionStatus
  cards: IssueBoardCard[]
  onOpenIssue: (id: number) => void
  onOpenLead: (entry: BoardEntry) => Promise<void>
  onError: (error: unknown) => void
}) {
  const { t } = useI18n()
  const headingId = `kanban-status-${status}`
  return (
    <section className="kanban-column" aria-labelledby={headingId}>
      <header className="kanban-column-heading">
        <h2 id={headingId}>{t(`status.${status}`)}</h2>
        <span className="kanban-column-count" aria-label={t("kanban.issueCount", { count: cards.length })}>
          {cards.length}
        </span>
      </header>
      <div className="kanban-column-cards">
        {cards.map((card) => (
          <IssueBoardCardView
            key={card.entry.issue.id}
            card={card}
            onOpenIssue={onOpenIssue}
            onOpenLead={onOpenLead}
            onError={onError}
          />
        ))}
      </div>
    </section>
  )
}

function normalizedSearchValue(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function issueMatches(card: IssueBoardCard, query: string, repos: Repo[]): boolean {
  if (!query) return true
  const repoNames = card.entry.directions
    .map((direction) => repos.find((repo) => repo.id === direction.repo_id)?.name ?? "")
    .join(" ")
  const values = [
    card.entry.issue.title,
    String(card.entry.issue.id),
    ...card.entry.directions.map((direction) => direction.name),
    ...card.entry.directions.map((direction) => direction.branch),
    repoNames,
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
  const deferredQuery = React.useDeferredValue(query)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const cards = React.useMemo(() => buildIssueBoard(board), [board])
  const visibleCards = React.useMemo(() => {
    const normalizedQuery = normalizedSearchValue(deferredQuery)
    return cards.filter((card) => issueMatches(card, normalizedQuery, repos))
  }, [cards, deferredQuery, repos])
  const grouped = React.useMemo(() => groupIssueBoard(visibleCards), [visibleCards])

  const startLead = React.useCallback(async (entry: BoardEntry) => {
    await actions.onStartLead(entry.issue)
  }, [actions])

  // Not ⌘K: Codex Desktop binds that (and ⇧⌘P) to its own command menu, at the
  // Electron menu-accelerator level, so the keypress may never reach this frame
  // — and the hint we used to print promised something the host would take.
  // See docs/compat/codex-builds.md §5.10.
  React.useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return
      if (isTypingTarget(event.target)) return
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
            <kbd aria-hidden="true">/</kbd>
          </div>
        </header>
        {cards.length && !visibleCards.length ? (
          <p className="kanban-filter-empty" role="status">{t("kanban.noMatchingIssues")}</p>
        ) : null}
        <div className="kanban-board-scroll">
          <div className="kanban-board" aria-label={t("kanban.boardLabel")}>
            {STATUSES.map((status) => (
              <IssueBoardColumn
                key={status}
                status={status}
                cards={grouped[status]}
                onOpenIssue={onOpenIssue}
                onOpenLead={startLead}
                onError={actions.onError}
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
