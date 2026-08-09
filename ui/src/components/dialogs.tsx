import * as React from "react"
import { ChevronDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { Textarea } from "@/components/ui/textarea"
import { useI18n } from "@/i18n"
import type { DialogState, DirectionStatus, Repo } from "@/types"
import { STATUSES } from "@/types"
import { Field } from "./shared"

export interface TaskInput {
  name: string
  repoId: number
  spec: string
  mandate: string
  baseBranch: string
}

interface DialogLayerProps {
  state: DialogState
  repos: Repo[]
  onClose: () => void
  onCreateWorkspace: (name: string) => Promise<void>
  onCreateTask: (issueId: number, input: TaskInput) => Promise<void>
  onSendMessage: (target: "lead" | "task", id: number, text: string) => Promise<void>
  onMoveTask: (id: number, status: DirectionStatus) => Promise<void>
}

interface FormDialogProps {
  title: string
  submitLabel: string
  pendingLabel: string
  onClose: () => void
  onSubmit: () => Promise<boolean | void>
  children: React.ReactNode
}

function FormDialog({
  title,
  submitLabel,
  pendingLabel,
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
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          {children}
          {error ? <p className="modal-error" role="alert">{t("err.prefix")}{error}</p> : null}
          <div className="modal-actions">
            <DialogClose asChild>
              <Button type="button" variant="ghost" disabled={pending}>{t("modal.cancel")}</Button>
            </DialogClose>
            <Button type="submit" disabled={pending} aria-busy={pending}>
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
            value={name}
            aria-invalid={Boolean(error)}
            onChange={(event) => { setName(event.target.value); setError("") }}
          />
        </Field>
      </div>
    </FormDialog>
  )
}

function TaskDialog({
  issueId,
  repos,
  onClose,
  onCreate,
}: {
  issueId: number
  repos: Repo[]
  onClose: () => void
  onCreate: (issueId: number, input: TaskInput) => Promise<void>
}) {
  const { t } = useI18n()
  const [name, setName] = React.useState("")
  const [spec, setSpec] = React.useState("")
  const [repoId, setRepoId] = React.useState(repos[0]?.id ?? 0)
  const selectedRepo = repos.find((repo) => repo.id === repoId) ?? repos[0]
  const [mandate, setMandate] = React.useState("plan+impl")
  const [baseBranch, setBaseBranch] = React.useState(selectedRepo?.base_ref ?? "")
  const [error, setError] = React.useState("")

  const changeRepo = (nextId: number) => {
    setRepoId(nextId)
    const repo = repos.find((candidate) => candidate.id === nextId)
    setBaseBranch(repo?.base_ref ?? "")
  }

  return (
    <FormDialog
      title={t("modal.directionTitle")}
      submitLabel={t("modal.createTask")}
      pendingLabel={t("loading.creatingTask")}
      onClose={onClose}
      onSubmit={async () => {
        if (!name.trim()) {
          setError(t("validation.taskName"))
          return false
        }
        if (!selectedRepo) throw new Error(t("task.noRepo"))
        await onCreate(issueId, {
          name: name.trim(),
          repoId: selectedRepo.id,
          spec,
          mandate,
          baseBranch: baseBranch.trim() || selectedRepo.base_ref || "",
        })
      }}
    >
      <div className="form-stack">
        <Field label={t("field.name")} htmlFor="task-name" error={error}>
          <Input
            id="task-name"
            autoFocus
            maxLength={120}
            value={name}
            aria-invalid={Boolean(error)}
            onChange={(event) => { setName(event.target.value); setError("") }}
          />
        </Field>
        {repos.length > 1 ? (
          <Field label={t("field.repo")} htmlFor="task-repo">
            <NativeSelect className="w-full" id="task-repo" value={repoId} onChange={(event) => changeRepo(Number(event.target.value))}>
              {repos.map((repo) => <NativeSelectOption key={repo.id} value={repo.id}>{repo.name}</NativeSelectOption>)}
            </NativeSelect>
          </Field>
        ) : null}
        <Field label={t("field.spec")} htmlFor="task-spec">
          <Textarea id="task-spec" maxLength={20000} value={spec} onChange={(event) => setSpec(event.target.value)} />
        </Field>
        <details className="advanced">
          <summary>
            <ChevronDown aria-hidden="true" />
            {t("field.advanced")}
          </summary>
          <div className="form-stack">
            <Field label={t("field.mandate")} htmlFor="task-mandate">
              <NativeSelect className="w-full" id="task-mandate" value={mandate} onChange={(event) => setMandate(event.target.value)}>
                <NativeSelectOption value="plan+impl">{t("mandate.planImpl")}</NativeSelectOption>
                <NativeSelectOption value="impl-only">{t("mandate.implOnly")}</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field label={t("field.baseBranch")} htmlFor="task-base-branch">
              <Input id="task-base-branch" maxLength={255} value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} />
            </Field>
          </div>
        </details>
      </div>
    </FormDialog>
  )
}

function MessageDialog({
  target,
  id,
  onClose,
  onSend,
}: {
  target: "lead" | "task"
  id: number
  onClose: () => void
  onSend: (target: "lead" | "task", id: number, text: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [text, setText] = React.useState("")
  const [error, setError] = React.useState("")
  return (
    <FormDialog
      title={t("modal.messageTitle")}
      submitLabel={t("modal.sendMessage")}
      pendingLabel={t("loading.sendingMessage")}
      onClose={onClose}
      onSubmit={async () => {
        if (!text.trim()) {
          setError(t("validation.message"))
          return false
        }
        await onSend(target, id, text.trim())
      }}
    >
      <div className="form-stack">
        <Field label={t("field.message")} htmlFor="message-text" error={error}>
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

function MoveDialog({
  id,
  initialStatus,
  onClose,
  onMove,
}: {
  id: number
  initialStatus: DirectionStatus
  onClose: () => void
  onMove: (id: number, status: DirectionStatus) => Promise<void>
}) {
  const { t } = useI18n()
  const [status, setStatus] = React.useState<DirectionStatus>(initialStatus)
  return (
    <FormDialog
      title={t("modal.moveTaskTitle")}
      submitLabel={t("modal.moveTask")}
      pendingLabel={t("loading.movingTask")}
      onClose={onClose}
      onSubmit={() => onMove(id, status)}
    >
      <div className="form-stack">
        <Field label={t("field.status")} htmlFor="task-status">
          <NativeSelect className="w-full" id="task-status" autoFocus value={status} onChange={(event) => setStatus(event.target.value as DirectionStatus)}>
            {STATUSES.map((item) => <NativeSelectOption key={item} value={item}>{t(`status.${item}`)}</NativeSelectOption>)}
          </NativeSelect>
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
  if (state.type === "task") {
    return <TaskDialog issueId={state.issueId} repos={props.repos} onClose={props.onClose} onCreate={props.onCreateTask} />
  }
  if (state.type === "message") {
    return <MessageDialog target={state.target} id={state.id} onClose={props.onClose} onSend={props.onSendMessage} />
  }
  return <MoveDialog id={state.direction.id} initialStatus={state.direction.status} onClose={props.onClose} onMove={props.onMoveTask} />
}
