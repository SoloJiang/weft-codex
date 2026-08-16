import * as React from "react"
import { createPortal } from "react-dom"

import App from "@/App"
import { DialogLayer } from "@/components/dialogs"
import { HostProvider, type WeftHost } from "@/host"
import { I18nProvider, languageFromLocale } from "@/i18n"
import { PortalProvider } from "@/portal"
import { WeftSessionProvider, useWeftSession } from "@/session"
import SidebarApp from "@/SidebarApp"

function OverlayDialogs() {
  const session = useWeftSession()
  return (
    <DialogLayer
      state={session.dialog}
      onClose={session.closeDialog}
      onCreateWorkspace={async (name) => {
        await session.submitDialog({ type: "workspace", name })
      }}
      onCreateIssue={async (title, kind) => {
        await session.submitDialog({ type: "issue", title, kind })
      }}
      onImportRepositories={async (paths) => {
        const result = await session.submitDialog({ type: "repositories", paths })
        if (!result) throw new Error("Repository import returned no result")
        return result
      }}
      onSendMessage={async (target, id, text, intent) => {
        await session.submitDialog({ type: "message", target, id, text, intent })
      }}
    />
  )
}

function HostedShell({
  sidebarTarget,
  mainTarget,
  overlayTarget,
}: {
  sidebarTarget: HTMLElement
  mainTarget: HTMLElement
  overlayTarget: HTMLElement
}) {
  // Keep App mounted while view=thread. The workspace root is hidden by the
  // agent; unmounting would drop the dialog submit handler the overlay still
  // calls, and would refetch the board on every return from a native thread.
  return (
    <>
      {createPortal(<SidebarApp />, sidebarTarget)}
      {createPortal(<App />, mainTarget)}
      {createPortal(<OverlayDialogs />, overlayTarget)}
    </>
  )
}

function PreviewShell() {
  return (
    <div className="preview-shell">
      <div className="preview-sidebar">
        <SidebarApp />
      </div>
      <div className="preview-main">
        <App />
      </div>
      <OverlayDialogs />
    </div>
  )
}

export function WeftApp({
  host,
  layout,
  sidebarTarget,
  mainTarget,
  overlayTarget,
}: {
  host: WeftHost
  layout: "preview" | "hosted"
  sidebarTarget?: HTMLElement
  mainTarget?: HTMLElement
  overlayTarget?: HTMLElement
}) {
  const [locale, setLocale] = React.useState(host.locale)

  React.useEffect(() => {
    const sync = () => setLocale(document.documentElement.lang || host.locale)
    const observer = new MutationObserver(sync)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] })
    return () => observer.disconnect()
  }, [host])

  const lang = languageFromLocale(locale)
  const portalContainer = overlayTarget ?? null

  return (
    <HostProvider host={host}>
      <I18nProvider lang={lang}>
        <PortalProvider container={portalContainer}>
          <WeftSessionProvider host={host}>
            {layout === "hosted" && sidebarTarget && mainTarget && overlayTarget ? (
              <HostedShell
                sidebarTarget={sidebarTarget}
                mainTarget={mainTarget}
                overlayTarget={overlayTarget}
              />
            ) : (
              <PreviewShell />
            )}
          </WeftSessionProvider>
        </PortalProvider>
      </I18nProvider>
    </HostProvider>
  )
}
