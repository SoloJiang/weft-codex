import * as React from "react"
import { Check, Flag, Play, RotateCcw, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/i18n"
import type { BoardEntry, Direction, DirectionStatus, Issue, Repo } from "@/types"
import { STATUSES } from "@/types"
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
  const parts: Array<string | number> = [repo?.name ?? direction.repo_id]
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
  const canContinue = direction.status === "review" || direction.status === "done"
  const canRetryStart = !direction.codex_thread_id && Boolean(direction.attention)
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
      ) : direction.codex_thread_id ? (
        <>
          <ThreadLink threadId={direction.codex_thread_id} />
          {canContinue ? (
            <Button variant="ghost" onClick={() => actions.onContinueTask(direction)}>
              <Send aria-hidden="true" />
              {t("dir.continue")}
            </Button>
          ) : null}
        </>
      ) : null}
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
        <ThreadLink threadId={issue.lead_codex_thread_id} />
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

function TaskCard({ direction, repos, actions }: { direction: Direction; repos: Repo[]; actions: WorkActions }) {
  const { t } = useI18n()
  return (
    <article
      className={`card${direction.attention ? " attention" : ""}`}
      aria-label={t("dir.cardLabel", { name: direction.name })}
    >
      <div className="name">
        {direction.name}
        {direction.attention ? (
          <span className="badge">{attentionLabel(direction, t)}</span>
        ) : null}
      </div>
      <div className="sub">{directionMeta(direction, repos)}</div>
      <DirectionActions direction={direction} actions={actions} />
    </article>
  )
}

function KanbanColumn({
  issueId,
  status,
  directions,
  repos,
  actions,
}: {
  issueId: number
  status: DirectionStatus
  directions: Direction[]
  repos: Repo[]
  actions: WorkActions
}) {
  const { t } = useI18n()
  const headingId = `issue-${issueId}-status-${status}`

  return (
    <section className="col" aria-labelledby={headingId}>
      <h3 id={headingId}>{t(`status.${status}`)}</h3>
      {directions.filter((direction) => direction.status === status).map((direction) => (
        <TaskCard key={direction.id} direction={direction} repos={repos} actions={actions} />
      ))}
    </section>
  )
}

function IssueBlock({
  entry,
  repos,
  actions,
  onOpenIssue,
}: {
  entry: BoardEntry
  repos: Repo[]
  actions: WorkActions
  onOpenIssue: (id: number) => void
}) {
  const { t } = useI18n()
  return (
    <article className="issue">
      <header className="issue-head">
        <div className="issue-identity">
          <h2>
            <Button variant="ghost" className="issue-title-link" onClick={() => onOpenIssue(entry.issue.id)}>
              {entry.issue.title}
            </Button>
          </h2>
          <div className="issue-context">
            <span className="issue-kind">{t(`kind.${entry.issue.kind}`)}</span>
            <span className="meta">#{entry.issue.id}</span>
          </div>
        </div>
        <IssueActions issue={entry.issue} actions={actions} />
      </header>
      <div className="columns">
        {STATUSES.map((status) => (
          <KanbanColumn
            key={status}
            issueId={entry.issue.id}
            status={status}
            directions={entry.directions}
            repos={repos}
            actions={actions}
          />
        ))}
      </div>
    </article>
  )
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

  let content: React.ReactNode
  if (!workspaceId) {
    content = <EmptyState titleKey="empty.workspaceTitle" bodyKey="empty.workspaceBody" actionKey="empty.workspaceAction" onAction={onCreateWorkspace} />
  } else if (!board.length) {
    content = <EmptyState titleKey="empty.issuesTitle" bodyKey="empty.issuesBody" actionKey="empty.issuesAction" onAction={onOpenCreateIssue} />
  } else {
    content = board.map((entry) => <IssueBlock key={entry.issue.id} entry={entry} repos={repos} actions={actions} onOpenIssue={onOpenIssue} />)
  }

  return (
    <section className="view active" aria-labelledby="kanban-heading">
      <h1 id="kanban-heading" className="sr-only">{t("nav.kanban")}</h1>
      <div id="issues">{content}</div>
    </section>
  )
}
