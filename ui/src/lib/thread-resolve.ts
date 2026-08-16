/** Bounded waits while a native thread is matched to a Weft binding. */
export const THREAD_RESOLVE_DELAYS_MS = [0, 250, 750] as const

export type ThreadLinkStatus = "idle" | "linking" | "unbound"

/**
 * What the sidebar should say about the native thread that is currently open.
 *
 * Bound threads and the workspace view are silent. An unknown thread is
 * "linking" until the resolve loop has spent its retries, then "unbound".
 */
export function threadLinkStatus(
  kind: "workspace" | "bound-thread" | "unbound-thread",
  resolveExhausted: boolean,
): ThreadLinkStatus {
  if (kind !== "unbound-thread") return "idle"
  if (resolveExhausted) return "unbound"
  return "linking"
}

export type SidebarFooter =
  | { kind: "retry"; threadId: string }
  | { kind: "linking" }
  | { kind: "unbound" }
  | { kind: "none" }

export function sidebarFooter(
  failedThreadId: string | null,
  linkStatus: ThreadLinkStatus,
): SidebarFooter {
  if (failedThreadId) return { kind: "retry", threadId: failedThreadId }
  if (linkStatus === "linking") return { kind: "linking" }
  if (linkStatus === "unbound") return { kind: "unbound" }
  return { kind: "none" }
}
