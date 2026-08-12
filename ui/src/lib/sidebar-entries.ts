import type { BoardEntry, Repo } from "@/types"

/**
 * What the sidebar's two header entries show.
 *
 * Both work off the board the sidebar already holds. `/api/issues` returns
 * issues, directions, threads and artifacts in one payload, so workspace search
 * needs no endpoint of its own — reaching for the network here would add a
 * round trip to answer a question the client can already answer.
 */

export type SearchHitKind = "issue" | "direction" | "artifact" | "thread"

export interface SearchHit {
  key: string
  kind: SearchHitKind
  issueId: number
  title: string
  meta: string
  threadId?: string
  artifactId?: number
}

export type InboxItemKind = "attention" | "delivery" | "lead"

export interface InboxItem {
  key: string
  kind: InboxItemKind
  issueId: number
  title: string
  meta: string
  directionId?: number
  /** Present on delivery items: identifies the failure to drop once acted on. */
  failureKey?: string
}

/** A `bus.undelivered` event seen this session, keyed by issue and party. */
export interface DeliveryFailure {
  issueId: number
  party: string
  reason: string
}

export function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase()
}

function matches(query: string, ...values: (string | number)[]): boolean {
  return values.some((value) => String(value).toLocaleLowerCase().includes(query))
}

function repoName(repos: Repo[], repoId: number): string {
  return repos.find((repo) => repo.id === repoId)?.name ?? ""
}

/**
 * Ranked by kind, not by score: an issue is the coarsest handle on a piece of
 * work and the one a human most often means, so issues lead regardless of where
 * in the string the match landed. Within a kind, board order is preserved.
 */
const KIND_ORDER: Record<SearchHitKind, number> = {
  issue: 0,
  direction: 1,
  artifact: 2,
  thread: 3,
}

export function searchBoard(
  board: BoardEntry[],
  repos: Repo[],
  rawQuery: string,
  limit = 40,
): SearchHit[] {
  const query = normalizeQuery(rawQuery)
  if (!query) return []

  const hits: SearchHit[] = []
  for (const entry of board) {
    const issue = entry.issue
    if (matches(query, issue.title, issue.id, issue.slug, issue.kind)) {
      hits.push({
        key: `issue:${issue.id}`,
        kind: "issue",
        issueId: issue.id,
        title: issue.title,
        meta: `#${issue.id}`,
      })
    }

    for (const direction of entry.directions) {
      const repo = repoName(repos, direction.repo_id)
      if (!matches(query, direction.name, direction.branch, repo)) continue
      const primary = entry.threads.find(
        (binding) => binding.direction_id === direction.id && binding.is_primary === 1,
      )
      hits.push({
        key: `direction:${direction.id}`,
        kind: "direction",
        issueId: issue.id,
        title: direction.name,
        meta: [repo, direction.branch].filter(Boolean).join(" · ") || issue.title,
        ...(primary ? { threadId: primary.thread_id } : {}),
      })
    }

    for (const artifact of entry.artifacts ?? []) {
      if (!matches(query, artifact.title, artifact.kind)) continue
      hits.push({
        key: `artifact:${artifact.id}`,
        kind: "artifact",
        issueId: issue.id,
        title: artifact.title || artifact.kind,
        meta: issue.title,
        artifactId: artifact.id,
      })
    }

    for (const binding of entry.threads) {
      // A primary thread is already reachable through its issue or direction
      // row; listing it again would just push distinct results off the limit.
      if (binding.is_primary === 1) continue
      if (!matches(query, binding.title)) continue
      hits.push({
        key: `thread:${binding.thread_id}`,
        kind: "thread",
        issueId: issue.id,
        title: binding.title,
        meta: issue.title,
        threadId: binding.thread_id,
      })
    }
  }

  hits.sort((left, right) => KIND_ORDER[left.kind] - KIND_ORDER[right.kind])
  return hits.slice(0, limit)
}

/**
 * `bus.parked` is deliberately absent.
 *
 * Parking means a human is mid-turn on that thread and the backlog flushes by
 * itself when the turn ends — nothing is asked of anyone. Listing it would fill
 * the inbox with entries that resolve while you read them, which is how an
 * inbox stops being read at all. `bus.undelivered` is the opposite: delivery
 * actually failed and the message is sitting there.
 */
export function buildInbox(board: BoardEntry[], failures: DeliveryFailure[]): InboxItem[] {
  const items: InboxItem[] = []
  for (const entry of board) {
    // A stalled lead blocks everything under it, so it leads the list.
    if (entry.issue.lead_attention) {
      items.push({
        key: `lead:${entry.issue.id}`,
        kind: "lead",
        issueId: entry.issue.id,
        title: entry.issue.title,
        meta: entry.issue.lead_attention_reason,
      })
    }
    for (const direction of entry.directions) {
      if (!direction.attention) continue
      items.push({
        key: `attention:${direction.id}`,
        kind: "attention",
        issueId: entry.issue.id,
        title: direction.name,
        meta: direction.attention_reason || entry.issue.title,
        directionId: direction.id,
      })
    }
  }

  for (const failure of failures) {
    const entry = board.find((candidate) => candidate.issue.id === failure.issueId)
    if (!entry) continue
    const directionId = Number.parseInt(failure.party, 10)
    const direction = Number.isNaN(directionId)
      ? undefined
      : entry.directions.find((candidate) => candidate.id === directionId)
    // A direction already flagged for attention says the same thing in a more
    // actionable way; the raw delivery failure would only duplicate the row.
    if (direction?.attention) continue
    items.push({
      key: `delivery:${deliveryFailureKey(failure)}`,
      kind: "delivery",
      issueId: failure.issueId,
      title: direction?.name ?? entry.issue.title,
      meta: failure.reason,
      failureKey: deliveryFailureKey(failure),
      ...(direction ? { directionId: direction.id } : {}),
    })
  }

  return items
}

export function deliveryFailureKey(failure: DeliveryFailure): string {
  return `${failure.issueId}:${failure.party}`
}
