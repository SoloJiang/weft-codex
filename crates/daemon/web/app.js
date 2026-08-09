// weft-codex web app — vanilla JS over the weftd API. Events arrive via
// SSE /api/events and trigger a debounced refetch (events are advisory;
// the API is the truth).

"use strict";

const STATUSES = ["queued", "planning", "working", "review", "done"];

function detectLang() {
  const host = document.documentElement.lang || "";
  const raw = host || navigator.language || "en";
  return raw.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const state = {
  lang: detectLang(),
  workspaces: [],
  workspaceId: null,
  repos: [],
  board: [],
  repoMap: null,
  view: "kanban",
  detailIssueId: null,
};

let fieldSequence = 0;

// ── i18n ────────────────────────────────────────────────────────────────

function t(key, values = {}) {
  const table = window.I18N[state.lang] || window.I18N.en;
  let text = table[key] || window.I18N.en[key] || key;
  for (const [name, value] of Object.entries(values)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    node.textContent = t(node.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((node) => {
    node.placeholder = t(node.dataset.i18nPh);
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((node) => {
    node.setAttribute("aria-label", t(node.dataset.i18nAriaLabel));
  });
  document.documentElement.lang = state.lang;
  document.title = t("app.title");
}

// ── helpers ─────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `HTTP ${response.status}`);
  }
  return body;
}

function errorMessage(error) {
  if (error instanceof TypeError) return t("err.network");
  if (error && error.message) return error.message;
  return t("err.unknown");
}

function notify(message, kind = "info") {
  const notifications = document.getElementById("notifications");
  const role = kind === "error" ? "alert" : "status";
  const node = el("div", { class: `toast toast-${kind}`, role, text: message });
  notifications.appendChild(node);
  setTimeout(() => node.remove(), 6000);
}

function notifyError(error) {
  notify(t("err.prefix") + errorMessage(error), "error");
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function slugify(value) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  );
}

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  chat: '<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z"/>',
  back: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  chevron: '<path d="M9 18l6-6-6-6"/>',
  play: '<path d="M6 4l14 8-14 8z" fill="currentColor" stroke="none"/>',
  send: '<path d="M22 2 11 13M22 2l-7 20-4-9-9-4z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 5 2 3-1 3-2V3s-1 1-4 1-5-2-5-2-3 1-3 2z"/><path d="M4 22v-7"/>',
  kanban: '<rect x="3" y="3" width="7" height="18" rx="1"/><rect x="14" y="3" width="7" height="12" rx="1"/>',
  repo: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
};

function icon(name) {
  const span = document.createElement("span");
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  return span.firstChild;
}

function setButtonContent(node, label) {
  node.replaceChildren();
  if (node.dataset.icon) node.appendChild(icon(node.dataset.icon));
  node.appendChild(document.createTextNode(label));
}

function withIcon(node, name) {
  const label = node.textContent;
  node.dataset.icon = name;
  setButtonContent(node, label);
  return node;
}

function threadLink(threadId) {
  if (!threadId) return null;
  const link = el("a", {
    href: `codex://threads/${threadId}`,
    class: "thread-link",
    text: t("dir.openThread"),
  });
  return withIcon(link, "chat");
}

async function withPending(button, loadingKey, action) {
  if (button.disabled) return undefined;
  const originalLabel = button.textContent.trim();
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.classList.add("loading");
  setButtonContent(button, t(loadingKey));
  try {
    return await action();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.classList.remove("loading");
    setButtonContent(button, originalLabel);
  }
}

function clearInlineError(input, errorNode) {
  input.removeAttribute("aria-invalid");
  errorNode.hidden = true;
  errorNode.textContent = "";
}

function showInlineError(input, errorNode, message) {
  input.setAttribute("aria-invalid", "true");
  errorNode.textContent = message;
  errorNode.hidden = false;
  input.focus();
}

function emptyState(titleKey, bodyKey, actionKey, onAction) {
  const section = el("section", { class: "empty-state" });
  section.appendChild(el("h2", { text: t(titleKey) }));
  section.appendChild(el("p", { text: t(bodyKey) }));
  if (actionKey && onAction) {
    const button = el("button", { type: "button", class: "primary", text: t(actionKey) });
    button.onclick = onAction;
    section.appendChild(button);
  }
  return section;
}

// ── modal and fields ────────────────────────────────────────────────────

function formFields(fields) {
  const wrap = el("div", { class: "form-stack" });
  const inputs = {};
  const definitions = [];

  for (const field of fields) {
    fieldSequence += 1;
    const id = `modal-field-${fieldSequence}`;
    const errorId = `${id}-error`;
    const fieldWrap = el("div", { class: "form-field" });
    const label = el("label", { for: id, text: t(field.label) });
    let control;

    if (field.type === "select") {
      control = el("select", { id });
      for (const [value, optionLabel] of field.options) {
        control.appendChild(el("option", { value, text: optionLabel }));
      }
    } else if (field.type === "textarea") {
      control = el("textarea", { id });
    } else {
      control = el("input", { id, type: field.type || "text" });
    }

    if (field.required) control.required = true;
    if (field.maxLength) control.maxLength = field.maxLength;
    if (field.value !== undefined) control.value = field.value;
    control.setAttribute("aria-describedby", errorId);

    const errorNode = el("p", { id: errorId, class: "field-error", role: "alert", hidden: true });
    control.addEventListener("input", () => clearInlineError(control, errorNode));
    control.addEventListener("change", () => clearInlineError(control, errorNode));

    fieldWrap.appendChild(label);
    fieldWrap.appendChild(control);
    fieldWrap.appendChild(errorNode);
    wrap.appendChild(fieldWrap);
    inputs[field.key] = control;
    definitions.push({ field, control, errorNode });
  }

  const validate = () => {
    let firstInvalid = null;
    for (const definition of definitions) {
      const { field, control, errorNode } = definition;
      clearInlineError(control, errorNode);
      if (field.required && !control.value.trim()) {
        control.setAttribute("aria-invalid", "true");
        errorNode.textContent = t(field.error);
        errorNode.hidden = false;
        if (!firstInvalid) firstInvalid = control;
      }
    }
    if (firstInvalid) firstInvalid.focus();
    return firstInvalid === null;
  };

  const read = () => Object.fromEntries(Object.entries(inputs).map(([key, node]) => [key, node.value]));
  return { wrap, inputs, read, validate };
}

function openModal(options) {
  const {
    titleKey,
    submitKey,
    loadingKey,
    contentNode,
    initialFocus,
    validate,
    onSubmit,
  } = options;

  return new Promise((resolve) => {
    const modal = document.getElementById("modal");
    const body = modal.querySelector(".modal-body");
    const form = document.getElementById("modal-form");
    const content = document.getElementById("modal-content");
    const errorNode = document.getElementById("modal-error");
    const submit = document.getElementById("modal-submit");
    const cancel = document.getElementById("modal-cancel");
    const opener = document.activeElement;
    let busy = false;
    let finished = false;

    document.getElementById("modal-title").textContent = t(titleKey);
    content.replaceChildren(contentNode);
    setButtonContent(submit, t(submitKey));
    submit.disabled = false;
    cancel.disabled = false;
    modal.removeAttribute("aria-busy");
    errorNode.hidden = true;
    errorNode.textContent = "";

    const setBusy = (value) => {
      busy = value;
      submit.disabled = value;
      cancel.disabled = value;
      modal.setAttribute("aria-busy", String(value));
      if (value) setButtonContent(submit, t(loadingKey));
      else setButtonContent(submit, t(submitKey));
    };

    const cleanup = () => {
      modal.removeEventListener("cancel", onCancel);
      modal.removeEventListener("click", onBackdropClick);
      modal.removeEventListener("keydown", onKeyDown);
      form.onsubmit = null;
      cancel.onclick = null;
    };

    const done = (value) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (modal.open) modal.close();
      content.replaceChildren();
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus();
      } else {
        const fallback = document.querySelector(".view.active button, .view.active input, .nav-btn.active");
        if (fallback instanceof HTMLElement) fallback.focus();
      }
      resolve(value);
    };

    const onCancel = (event) => {
      event.preventDefault();
      if (!busy) done(false);
    };

    const onBackdropClick = (event) => {
      if (busy || event.target !== modal) return;
      const rect = body.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
      if (!inside) done(false);
    };

    const onKeyDown = (event) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      done(false);
    };

    form.onsubmit = async (event) => {
      event.preventDefault();
      errorNode.hidden = true;
      errorNode.textContent = "";
      if (validate && !validate()) return;
      setBusy(true);
      try {
        await onSubmit();
        done(true);
      } catch (error) {
        errorNode.textContent = t("err.prefix") + errorMessage(error);
        errorNode.hidden = false;
        setBusy(false);
      }
    };
    cancel.onclick = () => {
      if (!busy) done(false);
    };
    modal.addEventListener("cancel", onCancel);
    modal.addEventListener("click", onBackdropClick);
    modal.addEventListener("keydown", onKeyDown);
    modal.showModal();
    requestAnimationFrame(() => {
      if (initialFocus instanceof HTMLElement) initialFocus.focus();
    });
  });
}

async function openWorkspaceDialog() {
  const form = formFields([
    {
      key: "name",
      label: "field.name",
      required: true,
      error: "validation.workspaceName",
      maxLength: 120,
    },
  ]);
  let createdId = null;
  const created = await openModal({
    titleKey: "modal.workspaceTitle",
    submitKey: "modal.createWorkspace",
    loadingKey: "loading.creatingWorkspace",
    contentNode: form.wrap,
    initialFocus: form.inputs.name,
    validate: form.validate,
    onSubmit: async () => {
      const { name } = form.read();
      const result = await api("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({ name: name.trim(), slug: slugify(name) }),
      });
      createdId = result.id;
    },
  });
  if (!created) return;
  state.workspaceId = createdId;
  await loadWorkspaces();
  state.repos = await api(`/api/workspaces/${state.workspaceId}/repos`);
  await refresh();
  notify(t("success.workspaceCreated"), "success");
}

// ── data loading ────────────────────────────────────────────────────────

function updateWorkspaceAvailability() {
  const hasWorkspace = Boolean(state.workspaceId);
  const canCreateIssue = hasWorkspace && state.repos.length > 0;
  document.getElementById("issue-create-form").hidden = !canCreateIssue;
  document.querySelector(".repo-toolbar").hidden = !hasWorkspace;
  document.getElementById("workspace-select").disabled = !state.workspaces.length;
}

async function loadWorkspaces() {
  state.workspaces = await api("/api/workspaces");
  const select = document.getElementById("workspace-select");
  select.replaceChildren();

  if (!state.workspaces.length) {
    state.workspaceId = null;
    select.appendChild(el("option", { value: "", text: t("workspace.none") }));
  } else {
    for (const workspace of state.workspaces) {
      select.appendChild(el("option", { value: workspace.id, text: workspace.name }));
    }
    const selectedExists = state.workspaces.some((workspace) => workspace.id === state.workspaceId);
    if (!selectedExists) state.workspaceId = state.workspaces[0].id;
    select.value = state.workspaceId;
  }
  updateWorkspaceAvailability();
}

async function loadKanban() {
  updateWorkspaceAvailability();
  if (!state.workspaceId) {
    state.board = [];
    renderKanban();
    return;
  }
  state.board = await api(`/api/issues?workspace_id=${state.workspaceId}`);
  renderKanban();
}

async function loadRepos() {
  if (!state.workspaceId) {
    state.repos = [];
    state.repoMap = null;
    renderRepos();
    return;
  }
  state.repos = await api(`/api/workspaces/${state.workspaceId}/repos`);
  state.repoMap = await api(`/api/workspaces/${state.workspaceId}/repo-map`);
  renderRepos();
}

async function refresh() {
  try {
    if (state.view === "kanban") await loadKanban();
    else if (state.view === "issue") await loadIssueDetail();
    else await loadRepos();
  } catch (error) {
    notifyError(error);
  }
}

async function reloadCurrent() {
  if (state.view === "issue") await loadIssueDetail();
  else await loadKanban();
}

// ── kanban ──────────────────────────────────────────────────────────────

function mandateLabel(value) {
  if (value === "impl-only") return t("mandate.implOnlyShort");
  return t("mandate.planImplShort");
}

function directionMeta(dir) {
  const repo = state.repos.find((candidate) => candidate.id === dir.repo_id);
  const parts = [repo ? repo.name : dir.repo_id, mandateLabel(dir.mandate)];
  if (dir.branch) parts.push(dir.branch);
  return parts.join(" · ");
}

function directionActions(dir) {
  const actions = el("div", { class: "btns" });
  if (!dir.codex_thread_id) {
    const spawn = withIcon(el("button", { type: "button", text: t("dir.spawn") }), "play");
    spawn.onclick = () =>
      withPending(spawn, "loading.startingTask", async () => {
        await api(`/api/directions/${dir.id}/spawn`, { method: "POST", body: "{}" });
        await reloadCurrent();
      }).catch(notifyError);
    actions.appendChild(spawn);
  } else {
    const link = threadLink(dir.codex_thread_id);
    if (link) actions.appendChild(link);
    const message = withIcon(el("button", { type: "button", text: t("dir.msg") }), "send");
    message.onclick = () =>
      messageDialog((text) =>
        api(`/api/directions/${dir.id}/message`, {
          method: "POST",
          body: JSON.stringify({ text }),
        })
      );
    actions.appendChild(message);
  }

  const move = withIcon(el("button", { type: "button", text: t("dir.move") }), "chevron");
  move.onclick = () => moveDirectionDialog(dir);
  actions.appendChild(move);

  if (dir.attention) {
    const clear = withIcon(el("button", { type: "button", text: t("dir.clearAttention") }), "flag");
    clear.onclick = () =>
      withPending(clear, "loading.clearingFlag", async () => {
        await api(`/api/directions/${dir.id}/attention/clear`, { method: "POST", body: "{}" });
        await reloadCurrent();
      }).catch(notifyError);
    actions.appendChild(clear);
  }
  return actions;
}

function directionCard(dir) {
  const card = el("article", {
    class: `card${dir.attention ? " attention" : ""}`,
    draggable: "true",
    "aria-label": t("dir.cardLabel", { name: dir.name }),
  });
  card.dataset.directionId = dir.id;
  const name = el("div", { class: "name", text: dir.name });
  if (dir.attention) {
    name.appendChild(el("span", { class: "badge", text: dir.attention_reason || t("dir.attention") }));
  }
  card.appendChild(name);
  card.appendChild(el("div", { class: "sub", text: directionMeta(dir) }));
  card.appendChild(directionActions(dir));
  card.ondragstart = (event) => event.dataTransfer.setData("text/plain", String(dir.id));
  return card;
}

function kanbanColumn(status, directions) {
  const column = el("section", { class: "col", "aria-labelledby": `status-${status}` });
  column.dataset.status = status;
  column.appendChild(el("h3", { id: `status-${status}`, text: t(`status.${status}`) }));
  for (const dir of directions.filter((candidate) => candidate.status === status)) {
    column.appendChild(directionCard(dir));
  }
  column.ondragover = (event) => {
    event.preventDefault();
    column.classList.add("over");
  };
  column.ondragleave = () => column.classList.remove("over");
  column.ondrop = async (event) => {
    event.preventDefault();
    column.classList.remove("over");
    const id = event.dataTransfer.getData("text/plain");
    if (!id) return;
    column.setAttribute("aria-busy", "true");
    try {
      await api(`/api/directions/${id}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      await loadKanban();
      notify(t("success.taskMoved", { status: t(`status.${status}`) }), "success");
    } catch (error) {
      notifyError(error);
    } finally {
      column.removeAttribute("aria-busy");
    }
  };
  return column;
}

function issueActions(issue) {
  const actions = el("div", { class: "issue-actions" });
  if (issue.lead_codex_thread_id) {
    const link = threadLink(issue.lead_codex_thread_id);
    if (link) actions.appendChild(link);
    const message = withIcon(el("button", { type: "button", text: t("issue.msgLead") }), "send");
    message.onclick = () =>
      messageDialog((text) =>
        api(`/api/issues/${issue.id}/message`, {
          method: "POST",
          body: JSON.stringify({ text }),
        })
      );
    actions.appendChild(message);
  } else {
    const spawn = withIcon(el("button", { type: "button", text: t("issue.spawnLead") }), "play");
    spawn.onclick = () =>
      withPending(spawn, "loading.startingLead", async () => {
        await api(`/api/issues/${issue.id}/spawn-lead`, { method: "POST", body: "{}" });
        await reloadCurrent();
      }).catch(notifyError);
    actions.appendChild(spawn);
  }
  const addTask = withIcon(el("button", { type: "button", text: t("issue.addDirection") }), "plus");
  addTask.onclick = () => directionDialog(issue.id);
  actions.appendChild(addTask);
  return actions;
}

function issueBlock(entry) {
  const { issue, directions } = entry;
  const block = el("article", { class: "issue" });
  const head = el("header", { class: "issue-head" });
  const identity = el("div", { class: "issue-identity" });
  const heading = el("h2");
  const title = el("button", { type: "button", class: "issue-title-link", text: issue.title });
  title.onclick = () => openIssueDetail(issue.id);
  heading.appendChild(title);
  identity.appendChild(heading);
  identity.appendChild(el("span", { class: "meta", text: `#${issue.id} ${issue.slug}` }));
  head.appendChild(identity);
  head.appendChild(issueActions(issue));
  block.appendChild(head);

  const columns = el("div", { class: "columns" });
  for (const status of STATUSES) columns.appendChild(kanbanColumn(status, directions));
  block.appendChild(columns);
  return block;
}

function renderKanban() {
  const root = document.getElementById("issues");
  root.replaceChildren();
  if (!state.workspaceId) {
    root.appendChild(emptyState("empty.workspaceTitle", "empty.workspaceBody", "empty.workspaceAction", openWorkspaceDialog));
    return;
  }
  if (!state.repos.length && !state.board.length) {
    root.appendChild(
      emptyState("empty.reposTitle", "empty.reposBody", "empty.reposAction", () => {
        switchView("repos");
        requestAnimationFrame(() => document.getElementById("new-repo-name").focus());
      })
    );
    return;
  }
  if (!state.board.length) {
    root.appendChild(emptyState("empty.issuesTitle", "empty.issuesBody"));
    return;
  }
  for (const entry of state.board) root.appendChild(issueBlock(entry));
}

async function messageDialog(send) {
  const form = formFields([
    {
      key: "text",
      label: "field.message",
      type: "textarea",
      required: true,
      error: "validation.message",
      maxLength: 20000,
    },
  ]);
  const sent = await openModal({
    titleKey: "modal.messageTitle",
    submitKey: "modal.sendMessage",
    loadingKey: "loading.sendingMessage",
    contentNode: form.wrap,
    initialFocus: form.inputs.text,
    validate: form.validate,
    onSubmit: async () => {
      const { text } = form.read();
      await send(text.trim());
      await reloadCurrent();
    },
  });
  if (sent) notify(t("success.messageSent"), "success");
}

async function directionDialog(issueId) {
  if (!state.repos.length) {
    notify(t("task.noRepo"), "error");
    return;
  }

  const hasMultipleRepos = state.repos.length > 1;
  const mainFields = [
    {
      key: "name",
      label: "field.name",
      required: true,
      error: "validation.taskName",
      maxLength: 120,
    },
  ];
  if (hasMultipleRepos) {
    mainFields.push({
      key: "repo_id",
      label: "field.repo",
      type: "select",
      options: state.repos.map((repo) => [repo.id, repo.name]),
    });
  }
  mainFields.push({ key: "spec", label: "field.spec", type: "textarea", maxLength: 20000 });
  const mainForm = formFields(mainFields);

  const repoFor = () => {
    if (!hasMultipleRepos) return state.repos[0];
    const id = Number(mainForm.inputs.repo_id.value);
    return state.repos.find((repo) => repo.id === id);
  };

  const advancedForm = formFields([
    {
      key: "mandate",
      label: "field.mandate",
      type: "select",
      value: "plan+impl",
      options: [
        ["plan+impl", t("mandate.planImpl")],
        ["impl-only", t("mandate.implOnly")],
      ],
    },
    {
      key: "base_branch",
      label: "field.baseBranch",
      value: (repoFor() || {}).base_ref || "",
      maxLength: 255,
    },
  ]);
  const advanced = el("details", { class: "advanced" });
  advanced.appendChild(el("summary", { text: t("field.advanced") }));
  advanced.appendChild(advancedForm.wrap);
  mainForm.wrap.appendChild(advanced);

  if (hasMultipleRepos) {
    mainForm.inputs.repo_id.onchange = () => {
      advancedForm.inputs.base_branch.value = (repoFor() || {}).base_ref || "";
    };
  }

  const created = await openModal({
    titleKey: "modal.directionTitle",
    submitKey: "modal.createTask",
    loadingKey: "loading.creatingTask",
    contentNode: mainForm.wrap,
    initialFocus: mainForm.inputs.name,
    validate: mainForm.validate,
    onSubmit: async () => {
      const main = mainForm.read();
      const advancedValues = advancedForm.read();
      const repo = repoFor();
      if (!repo) throw new Error(t("task.noRepo"));
      await api(`/api/issues/${issueId}/directions`, {
        method: "POST",
        body: JSON.stringify({
          name: main.name.trim(),
          slug: slugify(main.name),
          repo_id: repo.id,
          spec: main.spec,
          mandate: advancedValues.mandate,
          base_branch: advancedValues.base_branch.trim() || repo.base_ref || "",
        }),
      });
      await reloadCurrent();
    },
  });
  if (created) notify(t("success.taskCreated"), "success");
}

async function moveDirectionDialog(dir) {
  const form = formFields([
    {
      key: "status",
      label: "field.status",
      type: "select",
      value: dir.status,
      options: STATUSES.map((status) => [status, t(`status.${status}`)]),
    },
  ]);
  const moved = await openModal({
    titleKey: "modal.moveTaskTitle",
    submitKey: "modal.moveTask",
    loadingKey: "loading.movingTask",
    contentNode: form.wrap,
    initialFocus: form.inputs.status,
    validate: form.validate,
    onSubmit: async () => {
      const { status } = form.read();
      await api(`/api/directions/${dir.id}/status`, {
        method: "POST",
        body: JSON.stringify({ status }),
      });
      await reloadCurrent();
    },
  });
  if (moved) {
    const { status } = form.read();
    notify(t("success.taskMoved", { status: t(`status.${status}`) }), "success");
  }
}

// ── issue detail ────────────────────────────────────────────────────────

function openIssueDetail(issueId) {
  state.detailIssueId = issueId;
  switchView("issue");
}

function fmtTs(ts) {
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return ts || "";
  const locale = state.lang === "zh" ? "zh-CN" : "en-US";
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(ms));
}

function directionDetail(dir) {
  const article = el("article", { class: "task-detail" });
  const header = el("header", { class: "task-detail-head" });
  const identity = el("div", { class: "task-detail-identity" });
  identity.appendChild(el("h3", { text: dir.name }));
  identity.appendChild(el("p", { class: "meta", text: directionMeta(dir) }));
  header.appendChild(identity);
  header.appendChild(
    el("span", {
      class: `status-chip status-${dir.status}`,
      text: t(`status.${dir.status}`),
    })
  );
  header.appendChild(directionActions(dir));
  article.appendChild(header);
  if (dir.reason) article.appendChild(el("p", { class: "task-reason", text: dir.reason }));
  if (dir.spec) {
    const brief = el("section", { class: "task-brief" });
    brief.appendChild(el("h4", { text: t("detail.taskBrief") }));
    brief.appendChild(el("pre", { class: "spec", text: dir.spec }));
    article.appendChild(brief);
  }
  return article;
}

function partyLabel(party, directions) {
  if (party === "human") return t("party.you");
  if (party === "lead") return t("party.lead");
  const id = Number(party);
  const task = directions.find((direction) => direction.id === id);
  if (task) return task.name;
  return t("party.task");
}

function busTimeline(rows, directions) {
  const wrap = el("div", { class: "timeline" });
  if (!rows.length) {
    wrap.appendChild(el("p", { class: "meta", text: t("detail.emptyBus") }));
    return wrap;
  }
  for (const row of rows) {
    const className = row.from_party === "human" ? "msg human" : "msg";
    const from = partyLabel(row.from_party, directions);
    const to = partyLabel(row.to_party, directions);
    wrap.appendChild(
      el("article", { class: className }, [
        el("div", { class: "msg-meta", text: `${from} → ${to} · ${fmtTs(row.ts)}` }),
        el("div", { class: "msg-text", text: row.text }),
      ])
    );
  }
  return wrap;
}

async function loadIssueDetail() {
  if (!state.detailIssueId || !state.workspaceId) return;
  state.board = await api(`/api/issues?workspace_id=${state.workspaceId}`);
  const entry = state.board.find((candidate) => candidate.issue.id === state.detailIssueId);
  const root = document.getElementById("issue-detail");
  root.replaceChildren();
  if (!entry) {
    root.appendChild(emptyState("detail.notFoundTitle", "detail.notFoundBody", "detail.back", () => switchView("kanban")));
    return;
  }

  const { issue, directions } = entry;
  document.getElementById("issue-detail-heading").textContent = issue.title;
  const head = el("header", { class: "issue-head detail-head" });
  const identity = el("div", { class: "issue-identity" });
  identity.appendChild(el("div", { class: "detail-title", text: issue.title }));
  identity.appendChild(el("span", { class: "meta", text: `#${issue.id} ${issue.slug}` }));
  head.appendChild(identity);
  head.appendChild(issueActions(issue));
  root.appendChild(head);

  root.appendChild(el("h2", { class: "section-title", text: t("detail.directions") }));
  const tasks = el("div", { class: "task-list" });
  if (!directions.length) tasks.appendChild(el("p", { class: "meta", text: t("detail.noTasks") }));
  for (const direction of directions) tasks.appendChild(directionDetail(direction));
  root.appendChild(tasks);

  root.appendChild(el("h2", { class: "section-title", text: t("detail.busTimeline") }));
  const rows = await api(`/api/issues/${issue.id}/bus`);
  root.appendChild(busTimeline(rows, directions));
}

// ── repositories ────────────────────────────────────────────────────────

function profileStateLabel(profile) {
  if (!profile) return t("repo.state.notAnalyzed");
  return t(`repo.state.${profile.run_state}`);
}

function repoBlock(entry) {
  const { repo, profile } = entry;
  const article = el("article", { class: "repo" });
  const header = el("header", { class: "repo-head" });
  const identity = el("div", { class: "repo-identity" });
  identity.appendChild(el("h2", { text: repo.name }));
  identity.appendChild(el("code", { class: "path", text: repo.path }));
  header.appendChild(identity);

  const actions = el("div", { class: "repo-actions" });
  actions.appendChild(
    el("span", {
      class: `runstate runstate-${profile ? profile.run_state : "idle"}`,
      text: profileStateLabel(profile),
    })
  );
  const analyze = el("button", { type: "button", text: t("repo.analyze") });
  analyze.onclick = () =>
    withPending(analyze, "loading.analyzingRepo", async () => {
      await api(`/api/repos/${repo.id}/analyze`, { method: "POST", body: "{}" });
      notify(t("success.analysisStarted"), "success");
      await loadRepos();
    }).catch(notifyError);
  actions.appendChild(analyze);
  header.appendChild(actions);
  article.appendChild(header);

  if (profile && profile.run_error) {
    article.appendChild(el("p", { class: "repo-error", text: profile.run_error }));
  }
  if (profile && profile.summary) {
    article.appendChild(el("p", { class: "summary", text: profile.summary }));
  }
  if (profile) {
    const tags = el("div", { class: "tags" });
    if (profile.tier) tags.appendChild(el("span", { class: "tag", text: profile.tier }));
    if (profile.layer) {
      tags.appendChild(el("span", { class: "tag layer", text: `${profile.layer} #${profile.layer_rank}` }));
    }
    try {
      for (const item of JSON.parse(profile.stack || "[]")) {
        tags.appendChild(el("span", { class: "tag", text: item }));
      }
    } catch (_) {
      // Legacy profile shapes remain readable without blocking the page.
    }
    if (tags.childElementCount) article.appendChild(tags);
  }
  return article;
}

function renderRepos() {
  const root = document.getElementById("repo-list");
  const mapSection = document.getElementById("repo-map-section");
  const mapEmpty = document.getElementById("repo-map-empty");
  const mapDocument = document.getElementById("repo-map-doc");
  const analyzeWorkspace = document.getElementById("analyze-ws");
  const analyzeRelations = document.getElementById("analyze-relations");
  root.replaceChildren();

  if (!state.workspaceId) {
    mapSection.hidden = true;
    analyzeWorkspace.disabled = true;
    analyzeRelations.disabled = true;
    root.appendChild(emptyState("empty.workspaceTitle", "empty.workspaceBody", "empty.workspaceAction", openWorkspaceDialog));
    return;
  }

  const hasRepos = state.repos.length > 0;
  analyzeWorkspace.disabled = !hasRepos;
  analyzeRelations.disabled = !hasRepos;
  const entries = (state.repoMap && state.repoMap.repos) || [];

  if (!hasRepos) {
    mapSection.hidden = true;
    root.appendChild(emptyState("empty.reposTitle", "empty.reposBody"));
    return;
  }

  for (const entry of entries) root.appendChild(repoBlock(entry));
  const relations = (state.repoMap && state.repoMap.relations) || [];
  if (relations.length) {
    const relationSection = el("section", { class: "relations" });
    relationSection.appendChild(el("h2", { class: "section-title", text: t("repo.relations") }));
    for (const relation of relations) {
      relationSection.appendChild(
        el("div", {
          class: "rel",
          text: `${relation.from_repo} → ${relation.to_repo} · ${relation.kind} · ${relation.confidence} · ${relation.rationale}`,
        })
      );
    }
    root.appendChild(relationSection);
  }

  const mapText = (state.repoMap && state.repoMap.repoMap) || "";
  mapSection.hidden = false;
  mapEmpty.hidden = Boolean(mapText);
  mapDocument.hidden = !mapText;
  mapDocument.textContent = mapText;
}

// ── events ──────────────────────────────────────────────────────────────

function setConnection(connected) {
  const connection = document.getElementById("conn");
  const label = document.getElementById("conn-label");
  const key = connected ? "status.connected" : "status.disconnected";
  connection.dataset.state = connected ? "up" : "down";
  connection.setAttribute("aria-label", t(key));
  connection.title = t(key);
  label.textContent = t(key);
}

function connectEvents() {
  const source = new EventSource("/api/events");
  let timer = null;
  const poke = () => {
    setConnection(true);
    clearTimeout(timer);
    timer = setTimeout(refresh, 400);
  };
  const names = [
    "direction.updated",
    "issue.updated",
    "workspace.updated",
    "repo.added",
    "repo.profile",
    "repo.relations",
    "bus.message",
    "bus.parked",
    "bus.undelivered",
    "thread.human-active",
  ];
  for (const name of names) source.addEventListener(name, poke);
  source.onerror = () => setConnection(false);
  source.onopen = () => setConnection(true);
}

// ── wiring ──────────────────────────────────────────────────────────────

function switchView(view) {
  state.view = view;
  const navView = view === "issue" ? "kanban" : view;
  document.querySelectorAll(".nav-btn").forEach((button) => {
    const active = button.dataset.view === navView;
    button.classList.toggle("active", active);
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  document.getElementById("view-kanban").classList.toggle("active", view === "kanban");
  document.getElementById("view-repos").classList.toggle("active", view === "repos");
  document.getElementById("view-issue").classList.toggle("active", view === "issue");
  refresh();
}

function wireStaticActions() {
  withIcon(document.querySelector('[data-view="kanban"]'), "kanban");
  withIcon(document.querySelector('[data-view="repos"]'), "repo");
  withIcon(document.getElementById("add-workspace"), "plus");
  withIcon(document.getElementById("create-issue"), "plus");
  withIcon(document.getElementById("add-repo"), "plus");
  withIcon(document.getElementById("issue-back"), "back");

  document.querySelectorAll(".nav-btn").forEach((button) => {
    button.onclick = () => switchView(button.dataset.view);
  });
  document.getElementById("add-workspace").onclick = openWorkspaceDialog;
  document.getElementById("issue-back").onclick = () => {
    state.detailIssueId = null;
    switchView("kanban");
  };
  document.getElementById("workspace-select").onchange = async (event) => {
    state.workspaceId = Number(event.target.value);
    state.repos = await api(`/api/workspaces/${state.workspaceId}/repos`);
    updateWorkspaceAvailability();
    state.detailIssueId = null;
    switchView("kanban");
  };

  const issueForm = document.getElementById("issue-create-form");
  const issueInput = document.getElementById("new-issue-title");
  const issueError = document.getElementById("issue-form-error");
  issueInput.oninput = () => clearInlineError(issueInput, issueError);
  issueForm.onsubmit = async (event) => {
    event.preventDefault();
    if (!state.workspaceId) return;
    const title = issueInput.value.trim();
    if (!title) {
      showInlineError(issueInput, issueError, t("validation.issueTitle"));
      return;
    }
    const button = document.getElementById("create-issue");
    try {
      await withPending(button, "loading.creatingIssue", async () => {
        await api("/api/issues", {
          method: "POST",
          body: JSON.stringify({ workspace_id: state.workspaceId, title, slug: slugify(title) }),
        });
        issueInput.value = "";
        await loadKanban();
      });
      notify(t("success.issueCreated"), "success");
    } catch (error) {
      notifyError(error);
    }
  };

  const repoForm = document.getElementById("repo-register-form");
  const repoName = document.getElementById("new-repo-name");
  const repoPath = document.getElementById("new-repo-path");
  const repoError = document.getElementById("repo-form-error");
  repoName.oninput = () => clearInlineError(repoName, repoError);
  repoPath.oninput = () => clearInlineError(repoPath, repoError);
  repoForm.onsubmit = async (event) => {
    event.preventDefault();
    if (!state.workspaceId) return;
    const name = repoName.value.trim();
    const path = repoPath.value.trim();
    if (!name) {
      showInlineError(repoName, repoError, t("validation.repoName"));
      return;
    }
    if (!path) {
      showInlineError(repoPath, repoError, t("validation.repoPath"));
      return;
    }
    const button = document.getElementById("add-repo");
    try {
      await withPending(button, "loading.addingRepo", async () => {
        await api(`/api/workspaces/${state.workspaceId}/repos`, {
          method: "POST",
          body: JSON.stringify({ name, path, base_ref: "main" }),
        });
        repoName.value = "";
        repoPath.value = "";
        await loadRepos();
      });
      notify(t("success.repoAdded"), "success");
    } catch (error) {
      notifyError(error);
    }
  };

  const analyzeWorkspace = document.getElementById("analyze-ws");
  analyzeWorkspace.onclick = () =>
    withPending(analyzeWorkspace, "loading.analyzingWorkspace", async () => {
      await api(`/api/workspaces/${state.workspaceId}/analyze`, { method: "POST", body: "{}" });
      notify(t("success.analysisStarted"), "success");
      await loadRepos();
    }).catch(notifyError);

  const analyzeRelations = document.getElementById("analyze-relations");
  analyzeRelations.onclick = () =>
    withPending(analyzeRelations, "loading.analyzingRelations", async () => {
      await api(`/api/workspaces/${state.workspaceId}/analyze-relations`, { method: "POST", body: "{}" });
      notify(t("success.relationsStarted"), "success");
      await loadRepos();
    }).catch(notifyError);
}

async function boot() {
  applyI18n();
  wireStaticActions();
  document.querySelector('[data-view="kanban"]').setAttribute("aria-current", "page");
  await loadWorkspaces();
  if (state.workspaceId) state.repos = await api(`/api/workspaces/${state.workspaceId}/repos`);
  await loadKanban();
  connectEvents();
}

boot().catch(notifyError);
