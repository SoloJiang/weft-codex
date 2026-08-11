import * as React from "react"

import { DialogLayer } from "@/components/dialogs"
import {
  dismissHostDialog,
  requestHostAction,
  useHostDialogState,
} from "@/host-context"
import { useI18n } from "@/i18n"
import { createSurfaceChannel } from "@/surface-channel"
import type {
  DialogSubmission,
  RepoImportResponse,
} from "@/types"

interface PendingSubmission {
  resolve(result: RepoImportResponse | undefined): void
  reject(error: Error): void
  timeout: number
}

function requestId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Dedicated full-window modal surface. It owns presentation and form state;
 * the workspace surface remains the single owner of mutations and navigation. */
export default function ModalApp({ hostContextReady }: { hostContextReady: boolean }) {
  const dialog = useHostDialogState()
  const { t } = useI18n()
  const channel = React.useMemo(createSurfaceChannel, [])
  const pending = React.useRef(new Map<string, PendingSubmission>())

  React.useEffect(() => {
    if (!channel) return
    const unsubscribe = channel.subscribe((message) => {
      if (message.type !== "dialog.result") return
      const entry = pending.current.get(message.requestId)
      if (!entry) return
      pending.current.delete(message.requestId)
      window.clearTimeout(entry.timeout)
      if (message.ok) entry.resolve(message.result)
      else entry.reject(new Error(message.error))
    })
    channel.post({ type: "surface.ready", surface: "modal" })
    return unsubscribe
  }, [channel])

  React.useEffect(() => {
    return () => {
      for (const entry of pending.current.values()) {
        window.clearTimeout(entry.timeout)
        entry.reject(new Error(t("err.unknown")))
      }
      pending.current.clear()
      channel?.close()
    }
  }, [channel, t])

  React.useLayoutEffect(() => {
    if (!dialog || !hostContextReady) return
    requestHostAction({ action: "dialog.mounted" })
    const frame = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>("[autofocus]")?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [dialog, hostContextReady])

  const submit = React.useCallback((submission: DialogSubmission) => {
    if (!channel) return Promise.reject(new Error(t("err.unknown")))
    const id = requestId()
    return new Promise<RepoImportResponse | undefined>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.current.delete(id)
        reject(new Error(t("err.network")))
      }, 120_000)
      pending.current.set(id, { resolve, reject, timeout })
      channel.post({ type: "dialog.submit", requestId: id, submission })
    })
  }, [channel, t])

  const close = React.useCallback(() => {
    dismissHostDialog()
  }, [])

  if (!dialog || !hostContextReady) return null

  return (
    <DialogLayer
      state={dialog}
      onClose={close}
      onCreateWorkspace={async (name) => {
        await submit({ type: "workspace", name })
      }}
      onCreateIssue={async (title, kind) => {
        await submit({ type: "issue", title, kind })
      }}
      onImportRepositories={async (paths) => {
        const result = await submit({ type: "repositories", paths })
        if (!result) throw new Error(t("err.unknown"))
        return result
      }}
      onSendMessage={async (target, id, text, intent) => {
        await submit({ type: "message", target, id, text, intent })
      }}
    />
  )
}
