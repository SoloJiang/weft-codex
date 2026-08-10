import { createRoot } from "react-dom/client"

import App from "@/App"
import IssuePanelApp from "@/IssuePanelApp"
import SidebarApp from "@/SidebarApp"
import { useHostContext } from "@/host-context"
import { I18nProvider } from "@/i18n"
import { readUiSurface } from "@/surface"
import "@/index.css"

const surface = readUiSurface()
document.documentElement.dataset.uiSurface = surface

function Root() {
  const { lang, context } = useHostContext()
  let content = <App />
  if (surface === "sidebar") content = <SidebarApp hostContext={context} />
  if (surface === "workspace") content = <App embedded />
  if (surface === "issue-panel") {
    const activeThreadId = context?.view === "thread" ? context.threadId ?? null : null
    content = <IssuePanelApp activeThreadId={activeThreadId} />
  }
  return (
    <I18nProvider lang={lang}>
      {content}
    </I18nProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Root />)
