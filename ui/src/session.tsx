import * as React from "react"

import type { WeftHost, HeaderActions, HostView } from "@/host"
import { readInitialRoute, readInitialWorkspaceId, type SurfaceRoute } from "@/route"
import type { ActiveDialogState, DialogState, DialogSubmission, RepoImportResponse } from "@/types"

export type DialogSubmit = (submission: DialogSubmission) => Promise<RepoImportResponse | undefined>

export interface WeftSession {
  workspaceId: number | null
  setWorkspaceId: (id: number | null) => void
  selectWorkspace: (id: number) => void
  route: SurfaceRoute
  navigate: (route: SurfaceRoute) => void
  dialog: DialogState
  openDialog: (dialog: ActiveDialogState) => void
  closeDialog: () => void
  registerDialogSubmit: (handler: DialogSubmit) => void
  submitDialog: DialogSubmit
  host: WeftHost
  hostView: HostView
  threadId?: string
  headerActions: HeaderActions
}

const SessionContext = React.createContext<WeftSession | null>(null)

export function WeftSessionProvider({
  host,
  children,
}: {
  host: WeftHost
  children: React.ReactNode
}) {
  const [workspaceId, setWorkspaceId] = React.useState<number | null>(readInitialWorkspaceId)
  const [route, setRoute] = React.useState<SurfaceRoute>(readInitialRoute)
  const [dialog, setDialog] = React.useState<DialogState>(null)
  const [hostView, setHostView] = React.useState<HostView>(host.view)
  const [threadId, setThreadId] = React.useState<string | undefined>(host.threadId)
  const [headerActions, setHeaderActions] = React.useState<HeaderActions>(host.headerActions)
  const submitRef = React.useRef<DialogSubmit | null>(null)

  React.useEffect(() => {
    return host.onView((view, nextThreadId) => {
      setHostView(view)
      setThreadId(nextThreadId)
    })
  }, [host])

  React.useEffect(() => {
    const sync = () => setHeaderActions(host.headerActions)
    sync()
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-weft-codex-header-actions"],
    })
    return () => observer.disconnect()
  }, [host])

  const selectWorkspace = React.useCallback((id: number) => {
    host.showWorkspace()
    setWorkspaceId(id)
    setRoute({ view: "kanban", issueId: null })
  }, [host])

  const navigate = React.useCallback((next: SurfaceRoute) => {
    host.showWorkspace()
    setRoute(next)
  }, [host])

  const openDialog = React.useCallback((next: ActiveDialogState) => {
    setDialog(next)
  }, [])

  const closeDialog = React.useCallback(() => {
    setDialog(null)
  }, [])

  const registerDialogSubmit = React.useCallback((handler: DialogSubmit) => {
    submitRef.current = handler
  }, [])

  const submitDialog = React.useCallback<DialogSubmit>(async (submission) => {
    if (!submitRef.current) throw new Error("Dialog handler is not registered")
    return submitRef.current(submission)
  }, [])

  const value = React.useMemo<WeftSession>(() => ({
    workspaceId,
    setWorkspaceId,
    selectWorkspace,
    route,
    navigate,
    dialog,
    openDialog,
    closeDialog,
    registerDialogSubmit,
    submitDialog,
    host,
    hostView,
    threadId,
    headerActions,
  }), [
    workspaceId,
    selectWorkspace,
    route,
    navigate,
    dialog,
    openDialog,
    closeDialog,
    registerDialogSubmit,
    submitDialog,
    host,
    hostView,
    threadId,
    headerActions,
  ])

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
}

export function useWeftSession(): WeftSession {
  const value = React.useContext(SessionContext)
  if (!value) throw new Error("useWeftSession must be used inside WeftSessionProvider")
  return value
}
