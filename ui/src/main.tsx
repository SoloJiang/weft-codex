import * as React from "react"
import { createRoot } from "react-dom/client"

import App from "@/App"
import ModalApp from "@/ModalApp"
import SidebarApp from "@/SidebarApp"
import { hasRequiredHostTokens, requestHostAction, useHostContext } from "@/host-context"
import { I18nProvider, useI18n } from "@/i18n"
import { readUiSurface, type UiSurface } from "@/surface"
import "@/index.css"

const surface = readUiSurface()
document.documentElement.dataset.uiSurface = surface

function SurfaceFrameTitle({ surface }: { surface: UiSurface }) {
  const { t } = useI18n()
  let title = t("surface.workspaceTitle")
  if (surface === "sidebar") title = t("surface.sidebarTitle")
  else if (surface === "modal") title = t("surface.modalTitle")

  React.useEffect(() => {
    document.title = title
    requestHostAction({ action: "surface.label", label: title })
  }, [title])

  return null
}

function Root() {
  const { lang, context } = useHostContext()
  let content = <App />
  if (surface === "sidebar") content = <SidebarApp hostContext={context} />
  if (surface === "workspace") content = <App embedded />
  if (surface === "modal") content = <ModalApp hostContextReady={hasRequiredHostTokens(context)} />
  return (
    <I18nProvider lang={lang}>
      <SurfaceFrameTitle surface={surface} />
      {content}
    </I18nProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Root />)
