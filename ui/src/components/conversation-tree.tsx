import { CornerDownRight, MessageCircle, Star } from "lucide-react"

import { AsyncButton } from "@/components/shared"
import { useI18n } from "@/i18n"
import type { BoardEntry, ThreadBinding } from "@/types"

export function branchesFor(entry: BoardEntry, directionId: number | null): ThreadBinding[] {
  return entry.threads.filter((binding) => binding.direction_id === directionId)
}

export function primaryBranch(entry: BoardEntry, directionId: number | null): ThreadBinding | undefined {
  return branchesFor(entry, directionId).find((binding) => binding.is_primary === 1)
}

export function branchTitle(binding: ThreadBinding, forkIndex: number, fallback: string): string {
  if (binding.is_primary === 1) return fallback
  const title = binding.title.trim()
  if (title) return title
  return `${fallback} ${forkIndex}`
}

export interface ConversationTreeRowProps {
  /** Present only on lead forks that can become the primary chat. */
  onPromote?: (threadId: string) => Promise<void>
  onError?: (error: unknown) => void
  label: string
  threadId: string
  active: boolean
  primary?: boolean
  nested?: boolean
  onOpen: (threadId: string) => void
}

export function ConversationTreeRow({
  label,
  threadId,
  active,
  primary = false,
  nested = false,
  onOpen,
  onPromote,
  onError,
}: ConversationTreeRowProps) {
  const { t } = useI18n()
  const row = (
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

export interface IssueConversationTreeProps {
  entry: BoardEntry
  activeThreadId: string | null
  onOpenThread: (threadId: string) => void
  onPromoteLead: (threadId: string) => Promise<void>
  onError: (error: unknown) => void
}

/**
 * The issue's conversation switcher: Lead group (primary + promotable forks),
 * then one row per task with its own forks nested underneath. Pure rendering —
 * the caller owns data loading, thread resolution and the promote mutation.
 */
export function IssueConversationTree({
  entry,
  activeThreadId,
  onOpenThread,
  onPromoteLead,
  onError,
}: IssueConversationTreeProps) {
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
            <ConversationTreeRow
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
            <ConversationTreeRow
              key={binding.thread_id}
              label={branchTitle(binding, index + 1, t("sidebar.forkChat"))}
              threadId={binding.thread_id}
              active={activeThreadId === binding.thread_id}
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
                  <ConversationTreeRow
                    label={direction.name}
                    threadId={taskPrimary.thread_id}
                    active={activeThreadId === taskPrimary.thread_id}
                    onOpen={onOpenThread}
                  />
                  {taskForks.map((binding, index) => (
                    <ConversationTreeRow
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
