import * as React from "react"
import { X } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/i18n"
import type { DialogState, IssueKind, MessageIntent, RepoImportResponse } from "@/types"
import { ISSUE_KINDS } from "@/types"
import { Field } from "./shared"

interface DialogLayerProps {
  state: DialogState
  onClose: () => void
  onCreateWorkspace: (name: string) => Promise<void>
  onCreateIssue: (title: string, kind: IssueKind) => Promise<void>
  onImportRepositories: (paths: string[]) => Promise<RepoImportResponse>
  onSendMessage: (target: "lead" | "task", id: number, text: string, intent: MessageIntent) => Promise<void>
}

interface FormDialogProps {
  title: string
  description?: string
  submitLabel: string
  pendingLabel: string
  submitDisabled?: boolean
  onClose: () => void
  onSubmit: () => Promise<boolean | void>
  children: React.ReactNode
}

function FormDialog({
  title,
  description,
  submitLabel,
  pendingLabel,
  submitDisabled = false,
  onClose,
  onSubmit,
  children,
}: FormDialogProps) {
  const { t } = useI18n()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState("")

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (pending) return
    setError("")
    setPending(true)
    try {
      const submitted = await onSubmit()
      if (submitted === false) {
        setPending(false)
        return
      }
      onClose()
    } catch (caught) {
      if (caught instanceof TypeError) setError(t("err.network"))
      else if (caught instanceof Error) setError(caught.message)
      else setError(t("err.unknown"))
      setPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose() }}>
      <DialogContent className="modal-body">
        <form className="modal-form" noValidate onSubmit={submit}>
          <DialogHeader className="modal-header">
            <div className="modal-heading">
              <DialogTitle>{title}</DialogTitle>
              {description ? <DialogDescription>{description}</DialogDescription> : null}
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="modal-close"
                aria-label={t("modal.close")}
                title={t("modal.close")}
                disabled={pending}
              >
                <X aria-hidden="true" />
              </Button>
            </DialogClose>
          </DialogHeader>
          {children}
          {error ? <p className="modal-error" role="alert">{t("err.prefix")}{error}</p> : null}
          <div className="modal-actions">
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>{t("modal.cancel")}</Button>
            </DialogClose>
            <Button type="submit" disabled={pending || submitDisabled} aria-busy={pending}>
              {pending ? pendingLabel : submitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function WorkspaceDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (name: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [name, setName] = React.useState("")
  const [error, setError] = React.useState("")

  return (
    <FormDialog
      title={t("modal.workspaceTitle")}
      submitLabel={t("modal.createWorkspace")}
      pendingLabel={t("loading.creatingWorkspace")}
      submitDisabled={!name.trim()}
      onClose={onClose}
      onSubmit={async () => {
        if (!name.trim()) {
          setError(t("validation.workspaceName"))
          return false
        }
        await onCreate(name.trim())
      }}
    >
      <div className="form-stack">
        <Field label={t("field.name")} htmlFor="workspace-name" error={error}>
          <Input
            id="workspace-name"
            autoFocus
            maxLength={120}
            placeholder={t("workspace.namePlaceholder")}
            value={name}
            aria-invalid={Boolean(error)}
            onChange={(event) => { setName(event.target.value); setError("") }}
          />
        </Field>
      </div>
    </FormDialog>
  )
}

function IssueDialog({
  onClose,
  onCreate,
}: {
  onClose: () => void
  onCreate: (title: string, kind: IssueKind) => Promise<void>
}) {
  const { t } = useI18n()
  const [title, setTitle] = React.useState("")
  const [kind, setKind] = React.useState<IssueKind | "">("")

  return (
    <FormDialog
      title={t("modal.issueTitle")}
      description={t("modal.issueDescription")}
      submitLabel={t("modal.createIssue")}
      pendingLabel={t("loading.creatingIssue")}
      submitDisabled={!title.trim() || !kind}
      onClose={onClose}
      onSubmit={async () => {
        if (!title.trim() || !kind) return false
        await onCreate(title.trim(), kind)
      }}
    >
      <div className="form-stack">
        <Field label={t("issue.titleLabel")} htmlFor="issue-title">
          <Input
            id="issue-title"
            autoFocus
            autoComplete="off"
            maxLength={120}
            placeholder={t("issue.titlePh")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
          />
        </Field>
        <Field label={t("issue.kindLabel")} htmlFor="issue-kind">
          <NativeSelect
            className="w-full"
            id="issue-kind"
            value={kind}
            onChange={(event) => setKind(event.target.value as IssueKind)}
          >
            <NativeSelectOption value="" disabled>{t("issue.kindPlaceholder")}</NativeSelectOption>
            {ISSUE_KINDS.map((value) => (
              <NativeSelectOption key={value} value={value}>{t(`kind.${value}`)}</NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
      </div>
    </FormDialog>
  )
}

function RepositoryDialog({
  onClose,
  onImport,
}: {
  onClose: () => void
  onImport: (paths: string[]) => Promise<RepoImportResponse>
}) {
  const { t } = useI18n()
  const [value, setValue] = React.useState("")
  const [error, setError] = React.useState("")
  const [summary, setSummary] = React.useState("")

  const paths = React.useMemo(() => {
    const seen = new Set<string>()
    return value
      .split(/\r?\n/)
      .map((path) => path.trim())
      .filter((path) => {
        if (!path || seen.has(path)) return false
        seen.add(path)
        return true
      })
  }, [value])

  return (
    <FormDialog
      title={t("modal.repositoriesTitle")}
      description={t("modal.repositoriesDescription")}
      submitLabel={t("modal.addRepositories", { count: paths.length })}
      pendingLabel={t("loading.addingRepos")}
      submitDisabled={!paths.length}
      onClose={onClose}
      onSubmit={async () => {
        if (!paths.length) {
          setError(t("validation.repoPaths"))
          return false
        }
        const response = await onImport(paths)
        if (!response.failed) return
        const failures = response.results.filter((result) => result.status === "error")
        setValue(failures.map((result) => result.requested_path).join("\n"))
        setSummary(t("repo.importPartial", {
          added: response.added,
          existing: response.existing,
          failed: response.failed,
        }))
        setError(failures.map((result) => `${result.requested_path}: ${result.error ?? t("err.unknown")}`).join("\n"))
        return false
      }}
    >
      <div className="form-stack">
        <Field label={t("repo.pathsLabel")} htmlFor="repository-paths" error={error}>
          <Textarea
            id="repository-paths"
            autoFocus
            className="repo-paths-input"
            placeholder={t("repo.pathsPlaceholder")}
            value={value}
            aria-invalid={Boolean(error)}
            onChange={(event) => {
              setValue(event.target.value)
              setError("")
              setSummary("")
            }}
          />
        </Field>
        {summary ? <p className="import-summary" role="status">{summary}</p> : null}
        <p className="form-hint">{t("repo.analysisAutomatic")}</p>
      </div>
    </FormDialog>
  )
}

function MessageDialog({
  target,
  id,
  intent,
  onClose,
  onSend,
}: {
  target: "lead" | "task"
  id: number
  intent: MessageIntent
  onClose: () => void
  onSend: (target: "lead" | "task", id: number, text: string, intent: MessageIntent) => Promise<void>
}) {
  const { t } = useI18n()
  const [text, setText] = React.useState("")
  const [error, setError] = React.useState("")
  const continuing = intent === "continue"
  return (
    <FormDialog
      title={t(continuing ? "modal.continueTaskTitle" : "modal.messageTitle")}
      submitLabel={t(continuing ? "modal.continueTask" : "modal.sendMessage")}
      pendingLabel={t("loading.sendingMessage")}
      submitDisabled={!text.trim()}
      onClose={onClose}
      onSubmit={async () => {
        if (!text.trim()) {
          setError(t("validation.message"))
          return false
        }
        await onSend(target, id, text.trim(), intent)
      }}
    >
      <div className="form-stack">
        <Field label={t(continuing ? "field.nextInstruction" : "field.message")} htmlFor="message-text" error={error}>
          <Textarea
            id="message-text"
            autoFocus
            maxLength={20000}
            value={text}
            aria-invalid={Boolean(error)}
            onChange={(event) => { setText(event.target.value); setError("") }}
          />
        </Field>
      </div>
    </FormDialog>
  )
}

export function DialogLayer(props: DialogLayerProps) {
  const { state } = props
  if (!state) return null
  if (state.type === "workspace") {
    return <WorkspaceDialog onClose={props.onClose} onCreate={props.onCreateWorkspace} />
  }
  if (state.type === "issue") {
    return <IssueDialog onClose={props.onClose} onCreate={props.onCreateIssue} />
  }
  if (state.type === "repositories") {
    return <RepositoryDialog onClose={props.onClose} onImport={props.onImportRepositories} />
  }
  if (state.type === "message") {
    return <MessageDialog target={state.target} id={state.id} intent={state.intent} onClose={props.onClose} onSend={props.onSendMessage} />
  }
  return null
}
