import * as React from "react"
import {
  Check,
  Flag,
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
import { AsyncButton, EmptyState, LeadChatLink, ThreadLink } from "./shared"

export interface WorkActions {
  onError: (error: unknown) => void
  onOpenChat: (issueId: number) => Promise<void>
  onRetryTask: (direction: Direction) => Promise<void>
  onCompleteTask: (direction: Direction) => Promise<void>
  onClearAttention: (direction: Direction) => Promise<void>
  onContinueTask: (direction: Direction) => void
}

/**
 * Failure reasons arrive as stable codes so the daemon never ships user-facing
 * prose. An unrecognised code still has to say something useful — a newer
 * daemon must not render a blank card against an older UI.
 */
const LEAD_FAILURE_KEYS = {
  "start-failed": "lead.startFailed",
  "resume-failed": "lead.resumeFailed",
  "turn-error": "lead.turnError",
} as const

function leadFailureText(reason: string, t: (key: never, values?: never) => string): string {
  const key = LEAD_FAILURE_KEYS[reason as keyof typeof LEAD_FAILURE_KEYS] ?? "lead.failed"
  return t(key as never)
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
  return (
    <div className="issue-actions">
      <LeadChatLink issue={issue} onOpen={actions.onOpenChat} onError={actions.onError} />
    </div>
  )
}



function IssueBoardCardView({
  card,
  onOpenIssue,
  onOpenChat,
  onError,
}: {
  card: IssueBoardCard
  onOpenIssue: (id: number) => void
  onOpenChat: (issueId: number) => Promise<void>
  onError: (error: unknown) => void
}) {
  const { t } = useI18n()
  const { entry, totalTasks, doneTasks, attentionCount, leadAttention } = card
  // The column heading already states the status, so repeating it on every card
  // spends the one line of meta on something the reader just read. Only what is
  // specific to this card goes here. A failed lead outranks task attention:
  // nothing else on this issue can move until it is running again.
  let signal = ""
  if (leadAttention) signal = leadFailureText(entry.issue.lead_attention_reason, t)
  else if (attentionCount) signal = t("kanban.issueNeedsYou")
  else if (totalTasks) signal = t("kanban.issueProgress", { done: doneTasks, total: totalTasks })

  return (
    <article
      className={`kanban-card issue-board-card${attentionCount || leadAttention ? " attention" : ""}`}
      aria-label={t("kanban.issueCardLabel", { title: entry.issue.title })}
    >
      <button
        type="button"
        className="kanban-card-issue issue-board-card-body"
        aria-label={t("kanban.openIssueBoard", { title: entry.issue.title })}
        onClick={() => onOpenIssue(entry.issue.id)}
      >
        <span className="kanban-card-issue-title">{entry.issue.title}</span>
      </button>
      <div className="issue-board-card-meta">
        <span className="issue-board-card-number">#{entry.issue.id}</span>
        {/* The action is one narrow icon in every state now, so the reason
            always has room; it no longer has to compete with a text button. */}
        {signal ? (
          // Long reasons must not push the row wider than the column; the full
          // text stays reachable on hover rather than being lost.
          <span className="issue-board-card-signal" title={signal}>{signal}</span>
        ) : null}
        <LeadChatLink
          issue={entry.issue}
          onOpen={onOpenChat}
          onError={onError}
          className="issue-board-lead-link"
          iconOnly
        />
      </div>
    </article>
  )
}

function IssueBoardColumn({
  status,
  cards,
  onOpenIssue,
  onOpenChat,
  onError,
}: {
  status: DirectionStatus
  cards: IssueBoardCard[]
  onOpenIssue: (id: number) => void
  onOpenChat: (issueId: number) => Promise<void>
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
            onOpenChat={onOpenChat}
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
                onOpenChat={actions.onOpenChat}
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
