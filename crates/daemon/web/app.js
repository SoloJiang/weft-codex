// weft-codex web app — vanilla JS over the weftd API. Events arrive via
// SSE /api/events and trigger a debounced refetch (events are advisory;
// the API is the truth).

"use strict";

const STATUSES = ["queued", "planning", "working", "review", "done"];

const state = {
  lang: localStorage.getItem("weft.lang") || "zh",
  workspaces: [],
  workspaceId: null,
  repos: [],
  board: [],
  repoMap: null,
  view: "kanban",
  detailIssueId: null,
};

// ── i18n ────────────────────────────────────────────────────────────────

function t(key) {
  const table = window.I18N[state.lang] || window.I18N.en;
  return table[key] || window.I18N.en[key] || key;
}

function applyI18n() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh);
  });
  document.documentElement.lang = state.lang;
}

// ── helpers ─────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  const resp = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const body = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    throw new Error(body.error || `HTTP ${resp.status}`);
  }
  return body;
}

function toast(msg) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = t("err.prefix") + msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 6000);
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k === "html") node.innerHTML = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.appendChild(child);
  return node;
}

function slugify(s) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "item"
  );
}

function threadLink(threadId) {
  if (!threadId) return null;
  return el("a", { href: `codex://threads/${threadId}`, class: "thread-link", text: t("dir.openThread") });
}

// ── modal ─────────────────────────────────────────────────────────────────

function openModal(titleKey, contentNode) {
  return new Promise((resolve) => {
    const modal = document.getElementById("modal");
    document.getElementById("modal-title").textContent = t(titleKey);
    const content = document.getElementById("modal-content");
    content.innerHTML = "";
    content.appendChild(contentNode);
    modal.classList.remove("hidden");
    const done = (value) => {
      modal.classList.add("hidden");
      resolve(value);
    };
    document.getElementById("modal-ok").onclick = () => done(true);
    document.getElementById("modal-cancel").onclick = () => done(false);
    modal.onclick = (e) => {
      if (e.target === modal) done(false);
    };
  });
}

function formFields(fields) {
  const wrap = el("div");
  const inputs = {};
  for (const f of fields) {
    wrap.appendChild(el("label", { text: t(f.label) }));
    let node;
    if (f.type === "select") {
      node = el("select");
      for (const [value, label] of f.options) {
        node.appendChild(el("option", { value, text: label }));
      }
    } else if (f.type === "textarea") {
      node = el("textarea");
    } else {
      node = el("input");
    }
    node.value = f.value || "";
    inputs[f.key] = node;
    wrap.appendChild(node);
  }
  return { wrap, read: () => Object.fromEntries(Object.entries(inputs).map(([k, n]) => [k, n.value])) };
}

// ── data loading ────────────────────────────────────────────────────────────

async function loadWorkspaces() {
  state.workspaces = await api("/api/workspaces");
  const sel = document.getElementById("workspace-select");
  sel.innerHTML = "";
  for (const ws of state.workspaces) {
    sel.appendChild(el("option", { value: ws.id, text: ws.name }));
  }
  if (!state.workspaceId && state.workspaces.length) {
    state.workspaceId = state.workspaces[0].id;
  }
  sel.value = state.workspaceId || "";
}

async function loadKanban() {
  if (!state.workspaceId) return;
  state.board = await api(`/api/issues?workspace_id=${state.workspaceId}`);
  renderKanban();
}

async function loadRepos() {
  if (!state.workspaceId) return;
  state.repos = await api(`/api/workspaces/${state.workspaceId}/repos`);
  state.repoMap = await api(`/api/workspaces/${state.workspaceId}/repo-map`);
  renderRepos();
}

async function refresh() {
  try {
    if (state.view === "kanban") await loadKanban();
    else if (state.view === "issue") await loadIssueDetail();
    else await loadRepos();
  } catch (e) {
    toast(e.message);
  }
}

// Cards/dialogs are shared between the kanban and the issue detail view;
// their action handlers reload whichever is showing.
async function reloadCurrent() {
  if (state.view === "issue") await loadIssueDetail();
  else await loadKanban();
}

// ── kanban ───────────────────────────────────────────────────────────────

function directionCard(dir) {
  const card = el("div", { class: "card" + (dir.attention ? " attention" : ""), draggable: "true" });
  card.dataset.directionId = dir.id;
  const name = el("div", { class: "name", text: dir.name });
  if (dir.attention) {
    name.appendChild(el("span", { class: "badge", text: dir.attention_reason || "!" }));
  }
  card.appendChild(name);
  const repo = state.repos.find((r) => r.id === dir.repo_id);
  card.appendChild(
    el("div", {
      class: "sub",
      text: `${repo ? repo.name : dir.repo_id} · ${dir.mandate}${dir.branch ? " · " + dir.branch : ""}`,
    })
  );
  const btns = el("div", { class: "btns" });
  if (!dir.codex_thread_id) {
    const spawn = el("button", { text: t("dir.spawn") });
    spawn.onclick = () => api(`/api/directions/${dir.id}/spawn`, { method: "POST", body: "{}" }).then(reloadCurrent).catch((e) => toast(e.message));
    btns.appendChild(spawn);
  } else {
    const link = threadLink(dir.codex_thread_id);
    if (link) btns.appendChild(link);
    const msg = el("button", { text: t("dir.msg") });
    msg.onclick = () => messageDialog((text) => api(`/api/directions/${dir.id}/message`, { method: "POST", body: JSON.stringify({ text }) }));
    btns.appendChild(msg);
  }
  if (dir.attention) {
    const clear = el("button", { text: t("dir.clearAttention") });
    clear.onclick = () => api(`/api/directions/${dir.id}/attention/clear`, { method: "POST", body: "{}" }).then(reloadCurrent).catch((e) => toast(e.message));
    btns.appendChild(clear);
  }
  card.appendChild(btns);
  card.ondragstart = (e) => e.dataTransfer.setData("text/plain", String(dir.id));
  return card;
}

function kanbanColumn(status, directions) {
  const col = el("div", { class: "col" });
  col.dataset.status = status;
  col.appendChild(el("h4", { text: t("status." + status) }));
  for (const dir of directions.filter((d) => d.status === status)) {
    col.appendChild(directionCard(dir));
  }
  col.ondragover = (e) => {
    e.preventDefault();
    col.classList.add("over");
  };
  col.ondragleave = () => col.classList.remove("over");
  col.ondrop = (e) => {
    e.preventDefault();
    col.classList.remove("over");
    const id = e.dataTransfer.getData("text/plain");
    api(`/api/directions/${id}/status`, { method: "POST", body: JSON.stringify({ status }) })
      .then(loadKanban)
      .catch((err) => toast(err.message));
  };
  return col;
}

function issueBlock(entry) {
  const { issue, directions } = entry;
  const block = el("div", { class: "issue" });
  const head = el("div", { class: "issue-head" });
  const title = el("h3", { class: "issue-link", text: issue.title, title: t("issue.open") });
  title.onclick = () => openIssueDetail(issue.id);
  head.appendChild(title);
  head.appendChild(el("span", { class: "meta", text: `#${issue.id} ${issue.slug}` }));
  if (issue.lead_codex_thread_id) {
    const link = threadLink(issue.lead_codex_thread_id);
    if (link) head.appendChild(link);
    const msgLead = el("button", { text: t("issue.msgLead") });
    msgLead.onclick = () => messageDialog((text) => api(`/api/issues/${issue.id}/message`, { method: "POST", body: JSON.stringify({ text }) }));
    head.appendChild(msgLead);
  } else {
    const spawn = el("button", { text: t("issue.spawnLead") });
    spawn.onclick = () => api(`/api/issues/${issue.id}/spawn-lead`, { method: "POST", body: "{}" }).then(reloadCurrent).catch((e) => toast(e.message));
    head.appendChild(spawn);
  }
  const open = el("button", { text: t("issue.open") });
  open.onclick = () => openIssueDetail(issue.id);
  head.appendChild(open);
  const addDir = el("button", { text: t("issue.addDirection") });
  addDir.onclick = () => directionDialog(issue.id);
  head.appendChild(addDir);
  block.appendChild(head);
  const cols = el("div", { class: "columns" });
  for (const status of STATUSES) {
    cols.appendChild(kanbanColumn(status, directions));
  }
  block.appendChild(cols);
  return block;
}

function renderKanban() {
  const root = document.getElementById("issues");
  root.innerHTML = "";
  if (!state.board.length) {
    root.appendChild(el("p", { class: "meta", text: t("empty.issues") }));
    return;
  }
  for (const entry of state.board) root.appendChild(issueBlock(entry));
}

async function messageDialog(send) {
  const form = formFields([{ key: "text", label: "field.message", type: "textarea" }]);
  const ok = await openModal("modal.messageTitle", form.wrap);
  if (!ok) return;
  const { text } = form.read();
  if (!text.trim()) return;
  try {
    await send(text);
    await reloadCurrent();
  } catch (e) {
    toast(e.message);
  }
}

async function directionDialog(issueId) {
  const form = formFields([
    { key: "name", label: "field.name" },
    {
      key: "repo_id",
      label: "field.repo",
      type: "select",
      options: state.repos.map((r) => [String(r.id), r.name]),
    },
    {
      key: "mandate",
      label: "field.mandate",
      type: "select",
      options: [
        ["plan+impl", "plan+impl"],
        ["impl-only", "impl-only"],
      ],
    },
    { key: "base_branch", label: "field.baseBranch", value: "main" },
    { key: "reason", label: "field.reason" },
    { key: "spec", label: "field.spec", type: "textarea" },
  ]);
  const ok = await openModal("modal.directionTitle", form.wrap);
  if (!ok) return;
  const body = form.read();
  if (!body.name.trim()) return;
  body.slug = slugify(body.name);
  body.repo_id = Number(body.repo_id);
  try {
    await api(`/api/issues/${issueId}/directions`, { method: "POST", body: JSON.stringify(body) });
    await reloadCurrent();
  } catch (e) {
    toast(e.message);
  }
}

// ── issue detail view ──────────────────────────────────────────────────────

function openIssueDetail(issueId) {
  state.detailIssueId = issueId;
  switchView("issue");
}

function fmtTs(ts) {
  const ms = Number(ts) * 1000;
  if (!Number.isFinite(ms) || ms <= 0) return ts || "";
  return new Date(ms).toLocaleString();
}

function directionDetail(dir) {
  const wrap = el("div", { class: "dir-detail" });
  wrap.appendChild(directionCard(dir));
  if (dir.reason) {
    wrap.appendChild(el("div", { class: "sub", text: dir.reason }));
  }
  if (dir.spec) {
    wrap.appendChild(el("pre", { class: "spec", text: dir.spec }));
  }
  return wrap;
}

function busTimeline(rows) {
  const wrap = el("div", { class: "timeline" });
  if (!rows.length) {
    wrap.appendChild(el("p", { class: "meta", text: t("detail.emptyBus") }));
    return wrap;
  }
  for (const r of rows) {
    const cls = r.from_party === "human" ? "msg human" : "msg";
    wrap.appendChild(
      el("div", { class: cls }, [
        el("div", { class: "msg-meta", text: `${r.from_party} → ${r.to_party || "?"} · ${fmtTs(r.ts)}` }),
        el("div", { class: "msg-text", text: r.text }),
      ])
    );
  }
  return wrap;
}

async function loadIssueDetail() {
  if (!state.detailIssueId || !state.workspaceId) return;
  state.board = await api(`/api/issues?workspace_id=${state.workspaceId}`);
  const entry = state.board.find((e) => e.issue.id === state.detailIssueId);
  const root = document.getElementById("issue-detail");
  root.innerHTML = "";
  if (!entry) {
    root.appendChild(el("p", { class: "meta", text: `#${state.detailIssueId}` }));
    return;
  }
  const { issue, directions } = entry;
  const head = el("div", { class: "issue-head detail-head" });
  head.appendChild(el("h3", { text: issue.title }));
  head.appendChild(el("span", { class: "meta", text: `#${issue.id} ${issue.slug}` }));
  if (issue.lead_codex_thread_id) {
    const link = threadLink(issue.lead_codex_thread_id);
    if (link) head.appendChild(link);
    const msgLead = el("button", { text: t("issue.msgLead") });
    msgLead.onclick = () => messageDialog((text) => api(`/api/issues/${issue.id}/message`, { method: "POST", body: JSON.stringify({ text }) }));
    head.appendChild(msgLead);
  } else {
    const spawn = el("button", { text: t("issue.spawnLead") });
    spawn.onclick = () => api(`/api/issues/${issue.id}/spawn-lead`, { method: "POST", body: "{}" }).then(reloadCurrent).catch((e) => toast(e.message));
    head.appendChild(spawn);
  }
  const addDir = el("button", { text: t("issue.addDirection") });
  addDir.onclick = () => directionDialog(issue.id);
  head.appendChild(addDir);
  root.appendChild(head);

  root.appendChild(el("h2", { text: t("detail.directions") }));
  const dirs = el("div", { class: "dir-list" });
  for (const dir of directions) dirs.appendChild(directionDetail(dir));
  root.appendChild(dirs);

  root.appendChild(el("h2", { text: t("detail.busTimeline") }));
  const rows = await api(`/api/issues/${issue.id}/bus`);
  root.appendChild(busTimeline(rows));
}

// ── repos view ─────────────────────────────────────────────────────────────

function repoBlock(entry) {
  const { repo, profile } = entry;
  const block = el("div", { class: "repo" });
  block.appendChild(el("h3", { text: repo.name }));
  block.appendChild(el("span", { class: "path", text: repo.path }));
  const analyze = el("button", { text: t("repo.analyze") });
  analyze.onclick = () => api(`/api/repos/${repo.id}/analyze`, { method: "POST", body: "{}" }).catch((e) => toast(e.message));
  block.appendChild(el("span", { text: " " }));
  block.appendChild(analyze);
  if (profile) {
    const stateEl = el("span", {
      class: "runstate-" + profile.run_state,
      text: ` ${profile.run_state}${profile.run_error ? " — " + profile.run_error : ""}`,
    });
    block.appendChild(stateEl);
    if (profile.summary) block.appendChild(el("p", { class: "summary", text: profile.summary }));
    const tags = el("div", { class: "tags" });
    if (profile.tier) tags.appendChild(el("span", { class: "tag", text: profile.tier }));
    if (profile.layer) tags.appendChild(el("span", { class: "tag layer", text: `${profile.layer} #${profile.layer_rank}` }));
    try {
      for (const s of JSON.parse(profile.stack || "[]")) tags.appendChild(el("span", { class: "tag", text: s }));
    } catch (_) { /* tolerate legacy shapes */ }
    block.appendChild(tags);
  }
  return block;
}

function renderRepos() {
  const root = document.getElementById("repo-list");
  root.innerHTML = "";
  const entries = (state.repoMap && state.repoMap.repos) || [];
  if (!entries.length) {
    root.appendChild(el("p", { class: "meta", text: t("empty.repos") }));
  }
  for (const entry of entries) root.appendChild(repoBlock(entry));
  const relations = (state.repoMap && state.repoMap.relations) || [];
  if (relations.length) {
    root.appendChild(el("h2", { text: t("repo.relations") }));
    for (const r of relations) {
      root.appendChild(
        el("div", { class: "rel", text: `${r.from_repo} → ${r.to_repo}  [${r.kind} · ${r.confidence}]  ${r.rationale}` })
      );
    }
  }
  document.getElementById("repo-map-doc").textContent = (state.repoMap && state.repoMap.repoMap) || "";
}

// ── events (SSE) ───────────────────────────────────────────────────────────

function connectEvents() {
  const src = new EventSource("/api/events");
  const conn = document.getElementById("conn");
  let timer = null;
  const poke = () => {
    conn.classList.remove("down");
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
  for (const name of names) {
    src.addEventListener(name, poke);
  }
  src.onerror = () => conn.classList.add("down");
  src.onopen = () => conn.classList.remove("down");
}

// ── wiring ────────────────────────────────────────────────────────────────

function switchView(view) {
  state.view = view;
  document.querySelectorAll(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  document.getElementById("view-kanban").classList.toggle("active", view === "kanban");
  document.getElementById("view-repos").classList.toggle("active", view === "repos");
  document.getElementById("view-issue").classList.toggle("active", view === "issue");
  refresh();
}

async function boot() {
  applyI18n();
  document.querySelectorAll(".nav-btn").forEach((b) => (b.onclick = () => switchView(b.dataset.view)));
  document.getElementById("lang-toggle").onclick = () => {
    state.lang = state.lang === "zh" ? "en" : "zh";
    localStorage.setItem("weft.lang", state.lang);
    applyI18n();
    renderKanban();
    renderRepos();
    if (state.view === "issue") loadIssueDetail().catch((e) => toast(e.message));
  };
  document.getElementById("workspace-select").onchange = async (e) => {
    state.workspaceId = Number(e.target.value);
    state.repos = await api(`/api/workspaces/${state.workspaceId}/repos`);
    state.detailIssueId = null;
    switchView("kanban");
  };
  document.getElementById("issue-back").onclick = () => {
    state.detailIssueId = null;
    switchView("kanban");
  };
  document.getElementById("add-workspace").onclick = async () => {
    const form = formFields([{ key: "name", label: "field.name" }]);
    const ok = await openModal("modal.workspaceTitle", form.wrap);
    if (!ok) return;
    const { name } = form.read();
    if (!name.trim()) return;
    try {
      const { id } = await api("/api/workspaces", { method: "POST", body: JSON.stringify({ name, slug: slugify(name) }) });
      state.workspaceId = id;
      await loadWorkspaces();
      refresh();
    } catch (e) {
      toast(e.message);
    }
  };
  document.getElementById("create-issue").onclick = async () => {
    const title = document.getElementById("new-issue-title").value;
    if (!title.trim() || !state.workspaceId) return;
    try {
      await api("/api/issues", {
        method: "POST",
        body: JSON.stringify({ workspace_id: state.workspaceId, title, slug: slugify(title) }),
      });
      document.getElementById("new-issue-title").value = "";
      await loadKanban();
    } catch (e) {
      toast(e.message);
    }
  };
  document.getElementById("add-repo").onclick = async () => {
    const name = document.getElementById("new-repo-name").value;
    const path = document.getElementById("new-repo-path").value;
    if (!name.trim() || !path.trim() || !state.workspaceId) return;
    try {
      await api(`/api/workspaces/${state.workspaceId}/repos`, {
        method: "POST",
        body: JSON.stringify({ name, path, base_ref: "main" }),
      });
      document.getElementById("new-repo-name").value = "";
      document.getElementById("new-repo-path").value = "";
      state.repos = await api(`/api/workspaces/${state.workspaceId}/repos`);
      await loadRepos();
    } catch (e) {
      toast(e.message);
    }
  };
  document.getElementById("analyze-ws").onclick = () =>
    api(`/api/workspaces/${state.workspaceId}/analyze`, { method: "POST", body: "{}" }).catch((e) => toast(e.message));
  document.getElementById("analyze-relations").onclick = () =>
    api(`/api/workspaces/${state.workspaceId}/analyze-relations`, { method: "POST", body: "{}" }).catch((e) => toast(e.message));

  await loadWorkspaces();
  if (state.workspaceId) {
    state.repos = await api(`/api/workspaces/${state.workspaceId}/repos`);
    await loadKanban();
  }
  connectEvents();
}

boot().catch((e) => toast(e.message));
