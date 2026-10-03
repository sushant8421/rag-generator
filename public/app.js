// DocChat UI: vanilla JS, no build step.
"use strict";

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) if (c != null) node.append(c);
  return node;
};

const state = {
  sections: [],
  scope: new Set(), // sections pinned for chat; empty = auto-route to the best-matching section
  activeSection: null, // section open in the Documents tab
  config: null,
  busy: false,
  jobTimer: null,
};

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok && res.status !== 422) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}
const postJSON = (path, data) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });

// ---------- toast ----------
let toastTimer;
function toast(msg, isError = false) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), isError ? 6000 : 3000);
}

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => showView(tab.dataset.view)),
);
function showView(view) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $("#view-chat").classList.toggle("hidden", view !== "chat");
  $("#view-docs").classList.toggle("hidden", view !== "docs");
  if (view === "chat") $("#question").focus();
}

// ---------- health ----------
async function checkHealth() {
  const s = $("#status");
  try {
    const r = await fetch("/health");
    const up = r.ok;
    s.className = "status " + (up ? "up" : "down");
    s.querySelector(".label").textContent = up ? "Connected" : "Vector DB down";
  } catch {
    s.className = "status down";
    s.querySelector(".label").textContent = "Server offline";
  }
}

// ---------- sections ----------
async function loadSections() {
  state.sections = await api("/api/sections");
  const names = new Set(state.sections.map((s) => s.name));
  for (const n of [...state.scope]) if (!names.has(n)) state.scope.delete(n);
  if (state.activeSection && !names.has(state.activeSection)) state.activeSection = null;
  if (!state.activeSection && state.sections.length) state.activeSection = state.sections[0].name;
  renderScope();
  renderSectionList();
  renderSuggestions();
  if (state.activeSection) loadSectionDetail();
  else renderSectionDetail(null);
}

function renderScope() {
  const list = $("#scope-list");
  list.replaceChildren();
  for (const s of state.sections) {
    const cb = el("input", { type: "checkbox", checked: state.scope.has(s.name), disabled: !s.compatible });
    cb.addEventListener("change", () => {
      cb.checked ? state.scope.add(s.name) : state.scope.delete(s.name);
      updateScopeHint();
    });
    const label = el("label", { title: s.compatible ? "" : `Built with ${s.embeddingModel}; re-upload to search` },
      cb, el("span", { className: "name", textContent: s.displayName }), el("span", { className: "count", textContent: s.documentCount }));
    list.append(el("li", { className: s.compatible ? "" : "disabled" }, label));
  }
  updateScopeHint();
}

function updateScopeHint() {
  const hint = $("#scope-hint");
  const total = state.sections.reduce((n, s) => n + s.documentCount, 0);
  if (!state.sections.length) hint.textContent = "No sections yet. Add documents in the Documents tab.";
  else if (total === 0) hint.textContent = "Sections are empty. Upload documents in the Documents tab.";
  else if (state.scope.size === 0) hint.textContent = "Auto: each question is answered from the section that best matches it. Tick sections to search only those.";
  else hint.textContent = `Only searching the ${state.scope.size} ticked section${state.scope.size > 1 ? "s" : ""}.`;
  $("#scope-all").classList.toggle("hidden", state.scope.size === 0);
}

$("#scope-all").addEventListener("click", () => {
  state.scope.clear();
  renderScope();
});

// ---------- chat ----------
const SUGGESTIONS = ["Give me an overview of these documents", "What are the main components and how do they interact?", "What problems or incidents are described?"];
function renderSuggestions() {
  const box = $("#suggestions");
  box.replaceChildren();
  if (!state.sections.some((s) => s.documentCount > 0)) {
    box.append(el("button", { textContent: "Upload documents →", onclick: () => showView("docs") }));
    return;
  }
  for (const q of SUGGESTIONS) box.append(el("button", { textContent: q, onclick: () => ask(q) }));
}

const textarea = $("#question");
textarea.addEventListener("input", autosize);
textarea.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("#composer").requestSubmit();
  }
});
function autosize() {
  textarea.style.height = "auto";
  textarea.style.height = Math.min(textarea.scrollHeight, 200) + "px";
}

$("#composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = textarea.value.trim();
  if (q) ask(q);
});

async function ask(question) {
  if (state.busy) return;
  state.busy = true;
  $("#send").disabled = true;
  $("#chat-empty")?.remove();
  textarea.value = "";
  autosize();

  const messages = $("#messages");
  messages.append(el("div", { className: "msg user" }, el("div", { className: "bubble", textContent: question })));
  const typing = el("div", { className: "msg bot" },
    el("div", { className: "bubble" }, el("span", { className: "typing" }, el("i"), el("i"), el("i"), " Searching documents…")));
  messages.append(typing);
  scrollToBottom();

  const sections = [...state.scope];
  try {
    const res = await postJSON("/api/ask", { question, sections });
    typing.replaceWith(renderAnswer(res));
  } catch (err) {
    typing.replaceWith(el("div", { className: "msg bot error" }, el("div", { className: "bubble", textContent: err.message })));
  } finally {
    state.busy = false;
    $("#send").disabled = false;
    scrollToBottom();
    textarea.focus();
  }
}

/** "Auto-routed to Wisetap" / "Searched: A, B", with per-section match scores in the tooltip. */
function routingTag(routing) {
  const used = routing.sections.filter((s) => s.selected).map((s) => s.displayName);
  const text = !used.length ? "No sections searched"
    : routing.mode === "auto" ? `Auto-routed to ${used.join(" + ")}`
    : `Searched: ${used.join(", ")}`;
  const title = routing.sections
    .map((s) => `${s.displayName}: ${Math.round((1 - s.bestDistance) * 100)}% best match${s.selected ? " ✓" : ""}`)
    .join("\n");
  return el("div", { className: "scope-tag", textContent: text, title });
}

function renderAnswer({ answer, sources, routing }) {
  const body = el("div", { className: "answer" });
  body.innerHTML = DOMPurify.sanitize(marked.parse(answer));
  linkCitations(body, sources.length);

  const bubble = el("div", { className: "bubble" }, body);
  const cited = sources.filter((s) => s.cited);
  const other = sources.filter((s) => !s.cited);
  const sourceEls = new Map();

  if (cited.length) {
    const list = el("ul", { className: "source-list" });
    cited.forEach((s) => list.append(sourceCard(s, sourceEls)));
    bubble.append(el("details", { className: "sources", open: true },
      el("summary", { textContent: `Sources (${cited.length})` }), list));
  }
  if (other.length) {
    const list = el("ul", { className: "source-list" });
    other.forEach((s) => list.append(sourceCard(s, sourceEls)));
    bubble.append(el("details", { className: "sources" },
      el("summary", { textContent: `${other.length} other retrieved passage${other.length > 1 ? "s" : ""} (not cited)` }), list));
  }

  body.addEventListener("click", (e) => {
    const btn = e.target.closest(".cite");
    if (!btn) return;
    const card = sourceEls.get(Number(btn.dataset.n));
    if (!card) return;
    card.closest("details").open = true;
    card.classList.add("open", "flash");
    card.querySelector(".toggle").textContent = "Hide excerpt";
    card.scrollIntoView({ behavior: "smooth", block: "nearest" });
    setTimeout(() => card.classList.remove("flash"), 1200);
  });

  return el("div", { className: "msg bot" }, routingTag(routing), bubble);
}

/** Turns "[2]" / "[2, 5]" in answer text into clickable citation pills (skipping code). */
function linkCitations(root, max) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement.closest("code, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes = [];
  const CITE = /\[(\d+(?:\s*,\s*\d+)*)\]/g; // "[2]" or grouped "[2, 5]"
  while (walker.nextNode()) if (CITE.test(walker.currentNode.nodeValue)) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const frag = document.createDocumentFragment();
    let last = 0;
    const text = node.nodeValue;
    for (const m of text.matchAll(CITE)) {
      const ns = m[1].split(",").map(Number);
      if (ns.some((n) => n < 1 || n > max)) continue;
      frag.append(text.slice(last, m.index));
      for (const n of ns) {
        const pill = el("button", { className: "cite", textContent: n, title: `Show source ${n}` });
        pill.dataset.n = n;
        frag.append(pill);
      }
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    node.replaceWith(frag);
  }
}

function sourceCard(s, registry) {
  const toggle = el("button", { className: "toggle", type: "button", textContent: "Show excerpt" });
  const parts = s.heading.split(" > ");
  const path = parts.length > 1 ? parts.slice(1).join(" › ") : parts[0];
  const card = el("li", { className: "source" },
    el("div", { className: "src-head" },
      el("span", { className: "n", textContent: `[${s.n}]` }),
      el("span", { className: "file", textContent: s.filename }),
      el("span", { className: "sec", textContent: `· ${state.sections.find((x) => x.name === s.section)?.displayName ?? s.section}` }),
      toggle),
    path ? el("div", { className: "path", textContent: path }) : null,
    el("div", { className: "snippet", textContent: s.snippet }));
  toggle.addEventListener("click", () => {
    card.classList.toggle("open");
    toggle.textContent = card.classList.contains("open") ? "Hide excerpt" : "Show excerpt";
  });
  registry.set(s.n, card);
  return card;
}

function scrollToBottom() {
  const m = $("#messages");
  m.scrollTop = m.scrollHeight;
}

// ---------- documents ----------
function renderSectionList() {
  const list = $("#section-list");
  list.replaceChildren();
  for (const s of state.sections) {
    const btn = el("button", { className: s.name === state.activeSection ? "active" : "" },
      el("span", { className: "name", textContent: s.displayName }),
      el("span", { className: "count", textContent: s.documentCount }));
    btn.addEventListener("click", () => {
      state.activeSection = s.name;
      renderSectionList();
      loadSectionDetail();
    });
    list.append(el("li", {}, btn));
  }
}

$("#new-section").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#new-section-name");
  const errEl = $("#new-section-error");
  errEl.textContent = "";
  const displayName = input.value.trim();
  if (!displayName) return;
  try {
    const created = await postJSON("/api/sections", { displayName });
    input.value = "";
    state.activeSection = created.name;
    await loadSections();
    toast(`Section "${created.displayName}" created — now add documents`);
  } catch (err) {
    errEl.textContent = err.message;
  }
});

async function loadSectionDetail() {
  const name = state.activeSection;
  const [docs, jobs] = await Promise.all([api(`/api/sections/${encodeURIComponent(name)}/documents`), api(`/api/jobs?section=${encodeURIComponent(name)}`)]);
  if (name !== state.activeSection) return; // user switched meanwhile
  renderSectionDetail(state.sections.find((s) => s.name === name), docs, jobs);
}

function renderSectionDetail(section, docs = [], jobs = []) {
  $("#docs-empty").classList.toggle("hidden", !!section);
  $("#docs-detail").classList.toggle("hidden", !section);
  if (!section) return;

  $("#sec-title").textContent = section.displayName;
  $("#sec-meta").textContent = `${docs.length} document${docs.length === 1 ? "" : "s"} · ${docs.reduce((n, d) => n + d.chunkCount, 0)} chunks`;

  const rows = $("#doc-rows");
  rows.replaceChildren();
  for (const d of docs) {
    const del = el("button", { className: "btn danger-ghost", textContent: "Remove" });
    del.addEventListener("click", async () => {
      if (!confirm(`Remove "${d.filename}" from ${section.displayName}?`)) return;
      try {
        await api(`/api/sections/${encodeURIComponent(section.name)}/documents/${d.documentId}`, { method: "DELETE" });
        toast(`Removed ${d.filename}`);
        loadSections();
      } catch (err) {
        toast(err.message, true);
      }
    });
    rows.append(el("tr", {},
      el("td", { textContent: d.filename }),
      el("td", { textContent: d.chunkCount }),
      el("td", { textContent: new Date(d.uploadedAt).toLocaleString(), className: "muted" }),
      el("td", {}, del)));
  }
  $("#no-docs").classList.toggle("hidden", docs.length > 0);
  renderJobs(jobs);
}

const STAGE_PROGRESS = { queued: 5, parsing: 20, chunking: 35, embedding: 60, storing: 85, done: 100, failed: 100 };
const STAGE_LABEL = { queued: "Queued", parsing: "Parsing…", chunking: "Chunking…", embedding: "Embedding…", storing: "Saving…" };

function renderJobs(jobs) {
  // Show active jobs plus anything that finished in the last 2 minutes.
  const recent = jobs.filter((j) => !j.finishedAt || Date.now() - Date.parse(j.finishedAt) < 120_000);
  $("#jobs-wrap").classList.toggle("hidden", recent.length === 0);
  const list = $("#jobs");
  list.replaceChildren();
  for (const j of recent) {
    const label =
      j.status === "done" ? `✓ ${j.result.chunks} chunks${j.result.replaced ? " (replaced previous version)" : ""}`
      : j.status === "failed" ? `Failed: ${j.error}`
      : STAGE_LABEL[j.status];
    const bar = el("div", { className: "bar" }, el("span"));
    bar.firstChild.style.width = STAGE_PROGRESS[j.status] + "%";
    list.append(el("li", { className: `job ${j.status}` },
      el("span", { className: "file", textContent: j.filename }), bar, el("span", { className: "state", textContent: label })));
  }
  const active = jobs.some((j) => !["done", "failed"].includes(j.status));
  clearTimeout(state.jobTimer);
  if (active) state.jobTimer = setTimeout(pollJobs, 1200);
}

async function pollJobs() {
  if (!state.activeSection) return;
  const jobs = await api(`/api/jobs?section=${encodeURIComponent(state.activeSection)}`).catch(() => []);
  const active = jobs.some((j) => !["done", "failed"].includes(j.status));
  if (!active) {
    // Only report failures from this batch, not older ones still in the job list.
    const failed = jobs.filter((j) => j.status === "failed" && Date.now() - Date.parse(j.finishedAt) < 10_000).length;
    if (failed) toast(`${failed} file${failed > 1 ? "s" : ""} failed to process`, true);
    else toast("Documents ready to query");
    return loadSections(); // refresh counts + doc list
  }
  renderJobs(jobs);
}

// ---------- upload ----------
const dropzone = $("#dropzone");
const fileInput = $("#file-input");
["dragenter", "dragover"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("over"); }));
dropzone.addEventListener("drop", (e) => uploadFiles([...e.dataTransfer.files]));
fileInput.addEventListener("change", () => {
  uploadFiles([...fileInput.files]);
  fileInput.value = "";
});

/** Client-side pre-check mirrors the server limits for instant feedback; the server re-validates. */
function precheck(file) {
  const c = state.config;
  const ext = "." + file.name.split(".").pop().toLowerCase();
  if (!c.supportedExtensions.includes(ext)) return `unsupported type (${c.supportedExtensions.join(", ")})`;
  const max = ext === ".pdf" ? c.maxPdfBytes : c.maxTextBytes;
  if (file.size > max) return `too large (${fmtBytes(file.size)} > ${fmtBytes(max)})`;
  if (file.size === 0) return "empty file";
  return null;
}

async function uploadFiles(files) {
  if (!files.length || !state.activeSection) return;
  const c = state.config;
  if (files.length > c.maxFilesPerUpload) return toast(`Upload at most ${c.maxFilesPerUpload} files at a time`, true);

  const bad = files.map((f) => [f, precheck(f)]).filter(([, e]) => e);
  if (bad.length) toast(bad.map(([f, e]) => `${f.name}: ${e}`).join(" · "), true);
  const good = files.filter((f) => !precheck(f));
  if (!good.length) return;

  const form = new FormData();
  good.forEach((f) => form.append("files", f));
  try {
    const res = await api(`/api/sections/${encodeURIComponent(state.activeSection)}/documents`, { method: "POST", body: form });
    if (res.rejected?.length) toast(res.rejected.map((r) => `${r.filename}: ${r.error}`).join(" · "), true);
    if (res.jobs?.length) {
      toast(`Processing ${res.jobs.length} file${res.jobs.length > 1 ? "s" : ""} in the background — you can keep chatting`);
      pollJobs();
    }
  } catch (err) {
    toast(err.message, true);
  }
}

$("#sec-delete").addEventListener("click", async () => {
  const s = state.sections.find((x) => x.name === state.activeSection);
  if (!s || !confirm(`Delete section "${s.displayName}" and all ${s.documentCount} of its documents? This cannot be undone.`)) return;
  try {
    await api(`/api/sections/${encodeURIComponent(s.name)}`, { method: "DELETE" });
    state.activeSection = null;
    toast(`Deleted ${s.displayName}`);
    loadSections();
  } catch (err) {
    toast(err.message, true);
  }
});

function fmtBytes(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

// ---------- init ----------
(async function init() {
  checkHealth();
  setInterval(checkHealth, 15000);
  try {
    state.config = await api("/api/config");
    const c = state.config;
    $("#limits").textContent = `${c.supportedExtensions.join(", ")} · PDF up to ${c.maxPdfPages} pages / ${fmtBytes(c.maxPdfBytes)} · text up to ${fmtBytes(c.maxTextBytes)} · ${c.maxFilesPerUpload} files at a time`;
    fileInput.accept = c.supportedExtensions.join(",");
    await loadSections();
  } catch (err) {
    toast(err.message, true);
  }
  textarea.focus();
})();
