import * as React from "react"
import { MessageCircle } from "lucide-react"

import { Button, type buttonVariants } from "@/components/ui/button"
import { useI18n, type MessageKey } from "@/i18n"
import { requestHostAction } from "@/host-context"
import { cn } from "@/lib/utils"
import type { VariantProps } from "class-variance-authority"
import type { RepoComponent } from "@/types"

interface AsyncButtonProps
  extends Omit<React.ComponentProps<typeof Button>, "onClick">,
    VariantProps<typeof buttonVariants> {
  label: string
  pendingLabel: string
  onAction: () => Promise<void>
  onError: (error: unknown) => void
}

export function AsyncButton({
  label,
  pendingLabel,
  onAction,
  onError,
  disabled,
  children,
  ...props
}: AsyncButtonProps) {
  const [pending, setPending] = React.useState(false)

  const run = async () => {
    if (pending || disabled) return
    setPending(true)
    try {
      await onAction()
    } catch (error) {
      onError(error)
    } finally {
      setPending(false)
    }
  }

  return (
    <Button
      {...props}
      disabled={pending || disabled}
      aria-busy={pending}
      onClick={run}
    >
      {children}
      {pending ? pendingLabel : label}
    </Button>
  )
}

export function codexThreadHref(threadId: string): string {
  return `codex://threads/${encodeURIComponent(threadId)}`
}

export function openCodexThread(threadId: string): void {
  if (!threadId) return
  if (requestHostAction({ action: "thread.open", threadId })) return
  window.location.assign(codexThreadHref(threadId))
}

export function ThreadLink({ threadId }: { threadId: string }) {
  const { t } = useI18n()
  if (!threadId) return null
  return (
    <Button asChild variant="ghost" className="thread-link">
      <a
        href={codexThreadHref(threadId)}
        onClick={(event) => {
          if (requestHostAction({ action: "thread.open", threadId })) event.preventDefault()
        }}
      >
        <MessageCircle aria-hidden="true" />
        {t("dir.openThread")}
      </a>
    </Button>
  )
}

export function EmptyState({
  titleKey,
  bodyKey,
  actionKey,
  onAction,
}: {
  titleKey: MessageKey
  bodyKey: MessageKey
  actionKey?: MessageKey
  onAction?: () => void
}) {
  const { t } = useI18n()
  return (
    <section className="empty-state">
      <h2>{t(titleKey)}</h2>
      <p>{t(bodyKey)}</p>
      {actionKey && onAction ? <Button onClick={onAction}>{t(actionKey)}</Button> : null}
    </section>
  )
}

export function Field({
  label,
  htmlFor,
  error,
  children,
  className,
}: {
  label: string
  htmlFor: string
  error?: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("form-field", className)}>
      <label htmlFor={htmlFor}>{label}</label>
      {children}
      {error ? <p className="field-error" role="alert">{error}</p> : null}
    </div>
  )
}

export function parseStack(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is string => typeof item === "string")
  } catch {
    return []
  }
}

export function parseComponents(value: string): RepoComponent[] {
  try {
    const parsed: unknown = JSON.parse(value || "[]")
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return []
      const candidate = item as Partial<RepoComponent>
      if (typeof candidate.name !== "string" || typeof candidate.path !== "string") return []
      return [{
        name: candidate.name,
        path: candidate.path,
        summary: typeof candidate.summary === "string" ? candidate.summary : "",
      }]
    })
  } catch {
    return []
  }
}
