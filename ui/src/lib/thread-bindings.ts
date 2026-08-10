import type { BoardEntry, ThreadBinding } from "@/types"

export function branchesFor(
  entry: BoardEntry,
  directionId: number | null,
): ThreadBinding[] {
  return entry.threads.filter((binding) => binding.direction_id === directionId)
}

export function primaryBranch(
  entry: BoardEntry,
  directionId: number | null,
): ThreadBinding | undefined {
  return branchesFor(entry, directionId).find((binding) => binding.is_primary === 1)
}

export function branchTitle(
  binding: ThreadBinding,
  forkIndex: number,
  fallback: string,
): string {
  if (binding.is_primary === 1) return fallback
  const title = binding.title.trim()
  if (title) return title
  return `${fallback} ${forkIndex}`
}
