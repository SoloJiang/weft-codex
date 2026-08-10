import * as React from "react"
import { CornerDownRight, MessageCircle, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useI18n } from "@/i18n"
import { branchTitle, branchesFor } from "@/lib/thread-bindings"
import type { BoardEntry, ThreadBinding } from "@/types"

interface ThreadRowProps {
  label: string
  threadId: string
  active: boolean
  primary?: boolean
  nested?: boolean
  onOpen: (threadId: string) => void
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

function forkRows(
  bindings: ThreadBinding[],
  activeThreadId: string | null,
  fallback: string,
  onOpenThread: (threadId: string) => void,
) {
  return bindings.map((binding, index) => (
    <ThreadRow
      key={binding.thread_id}
      label={branchTitle(binding, index + 1, fallback)}
      threadId={binding.thread_id}
      active={activeThreadId === binding.thread_id}
      nested
      onOpen={onOpenThread}
    />
  ))
}

export function IssueConversationTree({
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
          {forkRows(leadForks, activeThreadId, t("sidebar.forkChat"), onOpenThread)}
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
                  {forkRows(taskForks, activeThreadId, t("sidebar.forkChat"), onOpenThread)}
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

export function IssueConversationCard({
  entry,
  activeThreadId,
  onOpenThread,
  onClose,
  onSizeChange,
  autoFocus = false,
}: {
  entry: BoardEntry
  activeThreadId: string | null
  onOpenThread: (threadId: string) => void
  onClose: () => void
  onSizeChange?: (height: number) => void
  autoFocus?: boolean
}) {
  const { t } = useI18n()
  const cardRef = React.useRef<HTMLElement>(null)

  React.useLayoutEffect(() => {
    const card = cardRef.current
    if (!card || !onSizeChange) return
    const measure = () => onSizeChange(Math.ceil(card.getBoundingClientRect().height + 16))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(card)
    return () => observer.disconnect()
  }, [entry, onSizeChange])

  React.useEffect(() => {
    if (autoFocus) cardRef.current?.focus()
  }, [autoFocus])

  return (
    <section
      ref={cardRef}
      className="issue-conversation-card"
      role="dialog"
      aria-label={t("sidebar.conversationsFor", { title: entry.issue.title })}
      tabIndex={-1}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return
        event.preventDefault()
        onClose()
      }}
    >
      <header className="issue-conversation-card-header">
        <h2 title={entry.issue.title}>{entry.issue.title}</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="issue-conversation-close"
          aria-label={t("sidebar.closeConversations")}
          title={t("sidebar.closeConversations")}
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      <div className="issue-conversation-scroll">
        <IssueConversationTree
          entry={entry}
          activeThreadId={activeThreadId}
          onOpenThread={onOpenThread}
        />
      </div>
    </section>
  )
}
