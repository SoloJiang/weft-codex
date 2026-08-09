import * as React from "react"
import { Check, Flag, MessageCircle, Play, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/i18n"
import type { BoardEntry, Direction, DirectionStatus, Issue, Repo } from "@/types"
import { STATUSES } from "@/types"
import { AsyncButton, EmptyState, ThreadLink } from "./shared"

export interface WorkActions {
  onError: (error: unknown) => void
  onStartLead: (issue: Issue) => Promise<void>
  onStartTask: (direction: Direction) => Promise<void>
  onCompleteTask: (direction: Direction) => Promise<void>
  onClearAttention: (direction: Direction) => Promise<void>
  onMessageLead: (issue: Issue) => void
  onMessageTask: (direction: Direction) => void
  onContinueTask: (direction: Direction) => void
}

function mandateLabel(value: string, t: ReturnType<typeof useI18n>["t"]): string {
  if (value === "impl-only") return t("mandate.implOnlyShort")
  return t("mandate.planImplShort")
}

export function directionMeta(
  direction: Direction,
  repos: Repo[],
  t: ReturnType<typeof useI18n>["t"],
): string {
  const repo = repos.find((candidate) => candidate.id === direction.repo_id)
  const parts: Array<string | number> = [repo?.name ?? direction.repo_id, mandateLabel(direction.mandate, t)]
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
  return (
    <div className="btns">
      {!direction.codex_thread_id ? (
        <AsyncButton
          variant="ghost"
          label={t("dir.spawn")}
          pendingLabel={t("loading.startingTask")}
          onAction={() => actions.onStartTask(direction)}
          onError={actions.onError}
        >
          <Play aria-hidden="true" />
        </AsyncButton>
      ) : (
        <>
          <ThreadLink threadId={direction.codex_thread_id} />
          <Button
            variant="ghost"
            onClick={() => {
              if (canContinue) actions.onContinueTask(direction)
              else actions.onMessageTask(direction)
            }}
          >
            <Send aria-hidden="true" />
            {t(canContinue ? "dir.continue" : "dir.msg")}
          </Button>
        </>
      )}
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
      {Boolean(direction.attention) ? (
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
        <>
          <ThreadLink threadId={issue.lead_codex_thread_id} />
          <Button variant="ghost" onClick={() => actions.onMessageLead(issue)}>
            <MessageCircle aria-hidden="true" />
            {t("issue.msgLead")}
          </Button>
        </>
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
          <span className="badge">{direction.attention_reason || t("dir.attention")}</span>
        ) : null}
      </div>
      <div className="sub">{directionMeta(direction, repos, t)}</div>
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
