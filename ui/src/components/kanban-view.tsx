import * as React from "react"
import { ChevronRight, Flag, MessageCircle, Play, Plus, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/i18n"
import type { BoardEntry, Direction, DirectionStatus, Issue, Repo } from "@/types"
import { STATUSES } from "@/types"
import { AsyncButton, EmptyState, ThreadLink } from "./shared"

export interface WorkActions {
  onError: (error: unknown) => void
  onStartLead: (issue: Issue) => Promise<void>
  onStartTask: (direction: Direction) => Promise<void>
  onClearAttention: (direction: Direction) => Promise<void>
  onMoveTask: (id: number, status: DirectionStatus) => Promise<void>
  onMessageLead: (issue: Issue) => void
  onMessageTask: (direction: Direction) => void
  onNewTask: (issue: Issue) => void
  onMoveTaskDialog: (direction: Direction) => void
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
          <Button variant="ghost" onClick={() => actions.onMessageTask(direction)}>
            <Send aria-hidden="true" />
            {t("dir.msg")}
          </Button>
        </>
      )}
      <Button variant="ghost" onClick={() => actions.onMoveTaskDialog(direction)}>
        <ChevronRight aria-hidden="true" />
        {t("dir.move")}
      </Button>
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
      <Button variant="ghost" onClick={() => actions.onNewTask(issue)}>
        <Plus aria-hidden="true" />
        {t("issue.addDirection")}
      </Button>
    </div>
  )
}

function TaskCard({ direction, repos, actions }: { direction: Direction; repos: Repo[]; actions: WorkActions }) {
  const { t } = useI18n()
  return (
    <article
      className={`card${direction.attention ? " attention" : ""}`}
      draggable
      aria-label={t("dir.cardLabel", { name: direction.name })}
      onDragStart={(event) => event.dataTransfer.setData("text/plain", String(direction.id))}
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
  const [over, setOver] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const headingId = `issue-${issueId}-status-${status}`

  return (
    <section
      className={`col${over ? " over" : ""}`}
      aria-labelledby={headingId}
      aria-busy={busy}
      onDragOver={(event) => { event.preventDefault(); setOver(true) }}
      onDragLeave={() => setOver(false)}
      onDrop={async (event) => {
        event.preventDefault()
        setOver(false)
        const id = Number(event.dataTransfer.getData("text/plain"))
        if (!Number.isFinite(id) || busy) return
        setBusy(true)
        try {
          await actions.onMoveTask(id, status)
        } catch (error) {
          actions.onError(error)
        } finally {
          setBusy(false)
        }
      }}
    >
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
  return (
    <article className="issue">
      <header className="issue-head">
        <div className="issue-identity">
          <h2>
            <Button variant="ghost" className="issue-title-link" onClick={() => onOpenIssue(entry.issue.id)}>
              {entry.issue.title}
            </Button>
          </h2>
          <span className="meta">#{entry.issue.id} {entry.issue.slug}</span>
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
  onCreateIssue,
  onCreateWorkspace,
  onShowRepositories,
  onOpenIssue,
  showIssueCreate = true,
}: {
  workspaceId: number | null
  repos: Repo[]
  board: BoardEntry[]
  actions: WorkActions
  onCreateIssue: (title: string) => Promise<void>
  onCreateWorkspace: () => void
  onShowRepositories: () => void
  onOpenIssue: (id: number) => void
  showIssueCreate?: boolean
}) {
  const { t } = useI18n()
  const [title, setTitle] = React.useState("")
  const [error, setError] = React.useState("")
  const [pending, setPending] = React.useState(false)

  const submitIssue = async (event: React.FormEvent) => {
    event.preventDefault()
    if (pending) return
    if (!title.trim()) {
      setError(t("validation.issueTitle"))
      return
    }
    setPending(true)
    try {
      await onCreateIssue(title.trim())
      setTitle("")
    } catch (caught) {
      actions.onError(caught)
    } finally {
      setPending(false)
    }
  }

  let content: React.ReactNode
  if (!workspaceId) {
    content = <EmptyState titleKey="empty.workspaceTitle" bodyKey="empty.workspaceBody" actionKey="empty.workspaceAction" onAction={onCreateWorkspace} />
  } else if (!repos.length && !board.length) {
    content = <EmptyState titleKey="empty.reposTitle" bodyKey="empty.reposBody" actionKey="empty.reposAction" onAction={onShowRepositories} />
  } else if (!board.length) {
    content = <EmptyState titleKey="empty.issuesTitle" bodyKey="empty.issuesBody" />
  } else {
    content = board.map((entry) => <IssueBlock key={entry.issue.id} entry={entry} repos={repos} actions={actions} onOpenIssue={onOpenIssue} />)
  }

  return (
    <section className="view active" aria-labelledby="kanban-heading">
      <h1 id="kanban-heading" className="sr-only">{t("nav.kanban")}</h1>
      {showIssueCreate && workspaceId && repos.length ? (
        <form className="actions issue-create" noValidate onSubmit={submitIssue}>
          <label className="sr-only" htmlFor="new-issue-title">{t("issue.titleLabel")}</label>
          <Input
            id="new-issue-title"
            autoComplete="off"
            placeholder={t("issue.titlePh")}
            value={title}
            aria-invalid={Boolean(error)}
            aria-describedby="issue-form-error"
            onChange={(event) => { setTitle(event.target.value); setError("") }}
          />
          <Button type="submit" disabled={pending} aria-busy={pending}>
            <Plus aria-hidden="true" />
            {pending ? t("loading.creatingIssue") : t("issue.create")}
          </Button>
          {error ? <p id="issue-form-error" className="inline-error" role="alert">{error}</p> : null}
        </form>
      ) : null}
      <div id="issues">{content}</div>
    </section>
  )
}
