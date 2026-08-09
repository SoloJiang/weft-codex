import { createRoot } from "react-dom/client"

import App from "@/App"
import { useHostLanguage } from "@/host-context"
import { I18nProvider } from "@/i18n"
import "@/index.css"

function Root() {
  const lang = useHostLanguage()
  return (
    <I18nProvider lang={lang}>
      <App />
    </I18nProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Root />)
