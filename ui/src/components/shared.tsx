import * as React from "react"
import { MessageCircle } from "lucide-react"

import { Button, type buttonVariants } from "@/components/ui/button"
import { useI18n, type MessageKey } from "@/i18n"
import { hasHostBridge, requestThreadOpen } from "@/host-context"
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

export function openCodexThread(threadId: string): Promise<void> {
  if (!threadId) return Promise.reject(new Error("Thread id is required"))
  const request = requestThreadOpen(threadId)
  if (request) return request
  window.location.assign(codexThreadHref(threadId))
  return Promise.resolve()
}

export function ThreadLink({
  threadId,
  onError,
  label,
  pendingLabel,
  className,
}: {
  threadId: string
  onError?: (error: unknown) => void
  label?: string
  pendingLabel?: string
  className?: string
}) {
  const { t } = useI18n()
  const [pending, setPending] = React.useState(false)
  if (!threadId) return null
  return (
    <Button asChild variant="ghost" className={cn("thread-link", className)}>
      <a
        href={codexThreadHref(threadId)}
        aria-busy={pending}
        aria-disabled={pending}
        onClick={(event) => {
          if (!hasHostBridge()) return
          event.preventDefault()
          if (pending) return
          setPending(true)
          void openCodexThread(threadId)
            .catch(() => onError?.(new Error(t("err.threadOpen"))))
            .finally(() => setPending(false))
        }}
      >
        <MessageCircle aria-hidden="true" />
        {pending
          ? (pendingLabel ?? t("loading.openingThread"))
          : (label ?? t("dir.openThread"))}
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
