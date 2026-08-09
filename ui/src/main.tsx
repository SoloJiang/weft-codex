import { createRoot } from "react-dom/client"

import App from "@/App"
import SidebarApp from "@/SidebarApp"
import { useHostLanguage } from "@/host-context"
import { I18nProvider } from "@/i18n"
import { readUiSurface } from "@/surface"
import "@/index.css"

const surface = readUiSurface()
document.documentElement.dataset.uiSurface = surface

function Root() {
  const lang = useHostLanguage()
  let content = <App />
  if (surface === "sidebar") content = <SidebarApp />
  if (surface === "workspace") content = <App embedded />
  return (
    <I18nProvider lang={lang}>
      {content}
    </I18nProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Root />)
