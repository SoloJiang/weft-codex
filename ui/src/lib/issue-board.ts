import type { BoardEntry, Direction, DirectionStatus } from "../types.ts"
import { STATUSES } from "../types.ts"

export type IssueBoardStatus = DirectionStatus

export interface IssueBoardCard {
  entry: BoardEntry
  status: IssueBoardStatus
  totalTasks: number
  doneTasks: number
  attentionCount: number
  hasLead: boolean
}

const STATUS_RANK: Record<DirectionStatus, number> = {
  queued: 0,
  planning: 1,
  working: 2,
  review: 3,
  done: 4,
}

/**
 * Roll task statuses up to one issue-level column.
 *
 * The board is issue-primary: a card represents the issue, not a task. The
 * status is the most advanced non-done task when work remains; only an issue
 * whose every task is done lands in Done. Issues with no tasks stay in Queued
 * so empty leads remain visible.
 */
export function deriveIssueStatus(directions: readonly Direction[]): IssueBoardStatus {
  if (!directions.length) return "queued"
  if (directions.every((direction) => direction.status === "done")) return "done"
  let best: DirectionStatus = "queued"
  for (const direction of directions) {
    if (direction.status === "done") continue
    if (STATUS_RANK[direction.status] > STATUS_RANK[best]) best = direction.status
  }
  return best
}

export function toIssueBoardCard(entry: BoardEntry): IssueBoardCard {
  const totalTasks = entry.directions.length
  const doneTasks = entry.directions.filter((direction) => direction.status === "done").length
  const attentionCount = entry.directions.filter((direction) => Boolean(direction.attention)).length
  return {
    entry,
    status: deriveIssueStatus(entry.directions),
    totalTasks,
    doneTasks,
    attentionCount,
    hasLead: Boolean(entry.issue.lead_codex_thread_id),
  }
}

export function buildIssueBoard(board: readonly BoardEntry[]): IssueBoardCard[] {
  return board.map(toIssueBoardCard)
}

export function groupIssueBoard(
  cards: readonly IssueBoardCard[],
): Record<IssueBoardStatus, IssueBoardCard[]> {
  const groups = Object.fromEntries(STATUSES.map((status) => [status, [] as IssueBoardCard[]])) as Record<
    IssueBoardStatus,
    IssueBoardCard[]
  >
  for (const card of cards) groups[card.status].push(card)
  return groups
}
