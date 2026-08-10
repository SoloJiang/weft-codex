import * as React from "react"
import { ArrowLeft, RefreshCw, Save } from "lucide-react"

import { ApiError, api } from "@/api"
import { Button } from "@/components/ui/button"
import { useI18n, type MessageKey } from "@/i18n"
import type { Artifact, ArtifactErrorBody } from "@/types"
import { AsyncButton, EmptyState } from "./shared"

/**
 * Distinguish a revision conflict from every other failure.
 *
 * The API answers with a typed `code`; matching on it is the whole point of
 * that contract, and it is what lets the conflict get its own recovery path
 * instead of a generic red banner.
 */
function conflictOf(error: unknown): ArtifactErrorBody | null {
  if (!(error instanceof ApiError)) return null
  const body = error.body as unknown as ArtifactErrorBody
  return body?.code === "revision_conflict" ? body : null
}

/** Dynamic keys would defeat the typed message table, so both are explicit. */
const KIND_LABELS: Record<string, MessageKey> = {
  test_cases: "artifact.kind.testCases",
  requirements: "artifact.kind.requirements",
  plan: "artifact.kind.plan",
  change_set_summary: "artifact.kind.changeSet",
}

const STATUS_LABELS: Record<string, MessageKey> = {
  draft: "artifact.status.draft",
  ready: "artifact.status.ready",
  stale: "artifact.status.stale",
  superseded: "artifact.status.superseded",
}

export function kindLabel(kind: string, t: ReturnType<typeof useI18n>["t"]): string {
  const key = KIND_LABELS[kind]
  return key ? t(key) : t("artifact.kind.other")
}

export function statusLabel(status: string, t: ReturnType<typeof useI18n>["t"]): string {
  const key = STATUS_LABELS[status]
  return key ? t(key) : status
}

export function ArtifactView({
  artifactId,
  onBack,
  onError,
}: {
  artifactId: number
  onBack: () => void
  onError: (error: unknown) => void
}) {
  const { t } = useI18n()
  const [artifact, setArtifact] = React.useState<Artifact | null>(null)
  const [draft, setDraft] = React.useState("")
  const [loading, setLoading] = React.useState(true)
  const [conflict, setConflict] = React.useState<ArtifactErrorBody | null>(null)

  const load = React.useCallback(async () => {
    const row = await api<Artifact>(`/api/artifacts/${artifactId}`)
    setArtifact(row)
    setDraft(row.content)
    setConflict(null)
    return row
  }, [artifactId])

  React.useEffect(() => {
    let active = true
    setLoading(true)
    load()
      .catch((error) => { if (active) onError(error) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [load, onError])

  const dirty = Boolean(artifact) && draft !== artifact?.content

  const save = async () => {
    if (!artifact) return
    try {
      const saved = await api<Artifact>(`/api/artifacts/${artifact.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expected_revision: artifact.revision,
          content: draft,
          title: artifact.title,
          source: "user",
        }),
      })
      setArtifact(saved)
      setDraft(saved.content)
      setConflict(null)
    } catch (error) {
      // Someone (the lead, or another window) wrote first. Keep the user's text
      // — discarding it here would lose work — and offer to reload instead.
      const detail = conflictOf(error)
      if (!detail) throw error
      setConflict(detail)
    }
  }

  if (loading) return <div className="app-loading" role="status">{t("app.loading")}</div>
  if (!artifact) return <EmptyState titleKey="artifact.missing" bodyKey="artifact.missingBody" />

  return (
    <section className="artifact-view" aria-label={t("artifact.viewLabel", { title: artifact.title })}>
      <header className="artifact-header">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          {t("artifact.back")}
        </Button>
        <div className="artifact-heading">
          <h2>{artifact.title || kindLabel(artifact.kind, t)}</h2>
          <p className="artifact-meta">
            {statusLabel(artifact.status, t)}
            {" · "}
            {t("artifact.revision", { revision: artifact.revision })}
          </p>
        </div>
      </header>

      {artifact.stale_reason ? (
        <p className="artifact-stale" role="status">{artifact.stale_reason}</p>
      ) : null}

      {conflict ? (
        <div className="artifact-conflict" role="alert">
          <p>
            {t("artifact.conflict", {
              expected: conflict.expectedRevision ?? artifact.revision,
              actual: conflict.actualRevision ?? artifact.revision,
            })}
          </p>
          <AsyncButton
            label={t("artifact.reload")}
            pendingLabel={t("artifact.reloading")}
            onAction={async () => { await load() }}
            onError={onError}
          >
            <RefreshCw aria-hidden="true" />
          </AsyncButton>
        </div>
      ) : null}

      <label className="sr-only" htmlFor="artifact-content">{t("artifact.contentLabel")}</label>
      <textarea
        id="artifact-content"
        className="artifact-content"
        value={draft}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
      />

      <footer className="artifact-actions">
        <AsyncButton
          label={t("artifact.save")}
          pendingLabel={t("artifact.saving")}
          disabled={!dirty}
          onAction={save}
          onError={onError}
        >
          <Save aria-hidden="true" />
        </AsyncButton>
      </footer>
    </section>
  )
}
