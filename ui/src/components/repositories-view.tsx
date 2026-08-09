import * as React from "react"
import { Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useI18n } from "@/i18n"
import type { RepoMap, RepoMapEntry } from "@/types"
import { AsyncButton, EmptyState, parseStack } from "./shared"

function RepositoryCard({
  entry,
  onAnalyze,
  onError,
}: {
  entry: RepoMapEntry
  onAnalyze: (id: number) => Promise<void>
  onError: (error: unknown) => void
}) {
  const { t } = useI18n()
  const { repo, profile } = entry
  const stateKey = profile ? `repo.state.${profile.run_state}` as const : "repo.state.notAnalyzed" as const
  return (
    <article className="repo">
      <header className="repo-head">
        <div className="repo-identity">
          <h2>{repo.name}</h2>
          <code className="path">{repo.path}</code>
        </div>
        <div className="repo-actions">
          <span className={`runstate runstate-${profile?.run_state ?? "idle"}`}>{t(stateKey)}</span>
          <AsyncButton
            variant="ghost"
            label={t("repo.analyze")}
            pendingLabel={t("loading.analyzingRepo")}
            onAction={() => onAnalyze(repo.id)}
            onError={onError}
          />
        </div>
      </header>
      {profile?.run_error ? <p className="repo-error">{profile.run_error}</p> : null}
      {profile?.summary ? <p className="summary">{profile.summary}</p> : null}
      {profile ? (
        <div className="tags">
          {profile.tier ? <span className="tag">{profile.tier}</span> : null}
          {profile.layer ? <span className="tag layer">{profile.layer} #{profile.layer_rank}</span> : null}
          {parseStack(profile.stack).map((item) => <span key={item} className="tag">{item}</span>)}
        </div>
      ) : null}
    </article>
  )
}

export function RepositoriesView({
  workspaceId,
  repoMap,
  onCreateWorkspace,
  onAddRepository,
  onAnalyzeRepository,
  onAnalyzeWorkspace,
  onAnalyzeRelations,
  onError,
}: {
  workspaceId: number | null
  repoMap: RepoMap | null
  onCreateWorkspace: () => void
  onAddRepository: (name: string, path: string) => Promise<void>
  onAnalyzeRepository: (id: number) => Promise<void>
  onAnalyzeWorkspace: () => Promise<void>
  onAnalyzeRelations: () => Promise<void>
  onError: (error: unknown) => void
}) {
  const { t } = useI18n()
  const [name, setName] = React.useState("")
  const [path, setPath] = React.useState("")
  const [error, setError] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const entries = repoMap?.repos ?? []
  const hasRepos = entries.length > 0

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (pending || !workspaceId) return
    if (!name.trim()) {
      setError(t("validation.repoName"))
      return
    }
    if (!path.trim()) {
      setError(t("validation.repoPath"))
      return
    }
    setPending(true)
    try {
      await onAddRepository(name.trim(), path.trim())
      setName("")
      setPath("")
    } catch (caught) {
      onError(caught)
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="view active" aria-labelledby="repos-heading">
      <h1 id="repos-heading" className="sr-only">{t("nav.repos")}</h1>
      {workspaceId ? (
        <div className="repo-toolbar">
          <form className="actions repo-register" noValidate onSubmit={submit}>
            <label className="sr-only" htmlFor="new-repo-name">{t("repo.nameLabel")}</label>
            <Input id="new-repo-name" autoComplete="off" placeholder={t("repo.namePh")} value={name} aria-invalid={Boolean(error && !name.trim())} onChange={(event) => { setName(event.target.value); setError("") }} />
            <label className="sr-only" htmlFor="new-repo-path">{t("repo.pathLabel")}</label>
            <Input id="new-repo-path" autoComplete="off" placeholder={t("repo.pathPh")} value={path} aria-invalid={Boolean(error && name.trim() && !path.trim())} onChange={(event) => { setPath(event.target.value); setError("") }} />
            <Button type="submit" disabled={pending} aria-busy={pending}>
              <Plus aria-hidden="true" />
              {pending ? t("loading.addingRepo") : t("repo.add")}
            </Button>
            {error ? <p className="inline-error" role="alert">{error}</p> : null}
          </form>
          <div className="analysis-actions" role="group" aria-label={t("repo.analysisActions")}>
            <AsyncButton
              variant="ghost"
              disabled={!hasRepos}
              label={t("repo.analyzeAll")}
              pendingLabel={t("loading.analyzingWorkspace")}
              onAction={onAnalyzeWorkspace}
              onError={onError}
            />
            <AsyncButton
              variant="ghost"
              disabled={!hasRepos}
              label={t("repo.analyzeRelations")}
              pendingLabel={t("loading.analyzingRelations")}
              onAction={onAnalyzeRelations}
              onError={onError}
            />
          </div>
        </div>
      ) : null}

      <div id="repo-list">
        {!workspaceId ? (
          <EmptyState titleKey="empty.workspaceTitle" bodyKey="empty.workspaceBody" actionKey="empty.workspaceAction" onAction={onCreateWorkspace} />
        ) : null}
        {workspaceId && !hasRepos ? <EmptyState titleKey="empty.reposTitle" bodyKey="empty.reposBody" /> : null}
        {entries.map((entry) => <RepositoryCard key={entry.repo.id} entry={entry} onAnalyze={onAnalyzeRepository} onError={onError} />)}
        {repoMap?.relations.length ? (
          <section className="relations">
            <h2 className="section-title">{t("repo.relations")}</h2>
            {repoMap.relations.map((relation) => (
              <div key={relation.id} className="rel">
                {relation.from_repo} → {relation.to_repo} · {relation.kind} · {relation.confidence} · {relation.rationale}
              </div>
            ))}
          </section>
        ) : null}
      </div>

      {workspaceId && hasRepos ? (
        <section className="repo-map-section" aria-labelledby="repo-map-heading">
          <h2 id="repo-map-heading">{t("repo.mapDoc")}</h2>
          {repoMap?.repoMap ? <pre id="repo-map-doc">{repoMap.repoMap}</pre> : <p className="meta">{t("repo.mapEmpty")}</p>}
        </section>
      ) : null}
    </section>
  )
}
