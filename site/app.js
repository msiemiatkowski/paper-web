// paperwriter web frontend.
// A static page: every paper file is read from (and written to) the private repository through the
// GitHub API with the user's own token. Nothing about the papers is part of the published site.

const STAGES = [
  ["Intake", "work/00_intake.md"],
  ["Sources", "work/01_gaps.md"],
  ["Search", "work/02_search.md"],
  ["Plan", "work/03_plan.md"],
  ["Draft", "work/04_draft.md"],
  ["Audits", "work/05_A5.md"],
  ["Build", "output/REPORT.md"],
];
const VERSIONS = ["output/manuscript.md", "work/05_A5_r2.md", "work/05_A4_r2.md", "work/05_A3_r2.md", "work/05_A5.md",
  "work/05_A4.md", "work/05_A3.md", "work/05_A2.md", "work/05_A1.md", "work/04_draft.md"];
const AGENTS = ["intake", "source-reader", "literature-scout", "planner", "section-writer", "audit-claims",
  "audit-argument", "audit-flow", "audit-language", "integrity-checker"];
const MARKER_RE = /\[(NEED|VERIFY|COMMENT|OUTSIDE ALLOWLIST|ADDED)(?::\s*([^\]]*))?\]/g;
const MARKER_INFO = {
  NEED: ["need", "Information you need to supply"],
  VERIFY: ["verify", "Could not be verified"],
  COMMENT: ["comment", "Note for the authors"],
  ADDED: ["added", "Reference added by the literature search"],
  "OUTSIDE ALLOWLIST": ["added", "Reference from outside the journal allowlist"],
};

// ------------------------------------------------------------------ settings and storage

function store(kind) {
  try { const s = kind === "local" ? window.localStorage : window.sessionStorage; s.getItem("x"); return s; }
  catch { return null; }
}
const LOCAL = store("local");
const SESSION = store("session");

function loadCfg() {
  let cfg = {};
  try { cfg = JSON.parse(LOCAL?.getItem("pw.cfg") || "{}"); } catch { cfg = {}; }
  // A bookmarkable link can preset the data repository: ?owner=…&repo=…&branch=… (never a token).
  const q = new URLSearchParams(location.search);
  for (const k of ["owner", "repo", "branch"]) if (q.get(k)) cfg[k] = q.get(k);
  const host = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  cfg.owner = cfg.owner || (host ? host[1] : "");
  cfg.repo = cfg.repo || (host ? location.pathname.split("/")[1] || "" : "");
  cfg.branch = cfg.branch || "main";
  cfg.api = cfg.api || "https://api.github.com";
  cfg.token = (cfg.remember ? LOCAL?.getItem("pw.token") : SESSION?.getItem("pw.token")) || "";
  return cfg;
}

function saveCfg(cfg) {
  const { token, ...rest } = cfg;
  LOCAL?.setItem("pw.cfg", JSON.stringify(rest));
  LOCAL?.removeItem("pw.token");
  SESSION?.removeItem("pw.token");
  if (token) (cfg.remember ? LOCAL : SESSION)?.setItem("pw.token", token);
}

const S = { cfg: loadCfg(), paths: null, sha: new Map(), size: new Map(), blobs: new Map(), treeAt: 0, refs: new Map() };

// ------------------------------------------------------------------ helpers

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const encPath = (p) => p.split("/").map(encodeURIComponent).join("/");
const fmtSize = (n) => n == null ? "" : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;

function toast(msg, bad = false) {
  const el = document.createElement("div");
  el.className = "toast" + (bad ? " bad" : "");
  el.textContent = msg;
  const box = $("#toast");
  box.append(el);
  while (box.children.length > 2) box.firstElementChild.remove();
  setTimeout(() => el.remove(), bad ? 7000 : 3000);
}

function hashOf(s) {
  let h = 5381;
  for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) | 0;
  return (h >>> 0).toString(36);
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast("Copied"); }
  catch { toast("Copy failed: select the text and copy it", true); }
}

// ------------------------------------------------------------------ GitHub API

class ApiError extends Error {
  constructor(status, text) {
    const hint = status === 401 ? "the token is invalid or expired"
      : status === 403 ? "the token lacks permission, or the rate limit was hit"
      : status === 404 ? "not found (or the token cannot see this repository)"
      : status === 409 || status === 422 ? "GitHub rejected the change (the branch may have moved: refresh and retry)"
      : "";
    super(`GitHub API ${status}${hint ? `: ${hint}` : ""}`);
    this.status = status;
    this.body = text;
  }
}

async function api(path, { method = "GET", body, accept = "application/vnd.github+json", as = "json" } = {}) {
  const headers = { Accept: accept, "X-GitHub-Api-Version": "2022-11-28" };
  if (S.cfg.token) headers.Authorization = `Bearer ${S.cfg.token}`;
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(S.cfg.api.replace(/\/$/, "") + path, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: "no-store" });
  if (!res.ok) throw new ApiError(res.status, await res.text().catch(() => ""));
  if (as === "blob") return res.blob();
  if (as === "text") return res.text();
  return res.status === 204 ? null : res.json();
}

const repo = (p) => `/repos/${encodeURIComponent(S.cfg.owner)}/${encodeURIComponent(S.cfg.repo)}${p}`;

async function loadTree(force = false) {
  if (S.paths && !force && Date.now() - S.treeAt < 60000) return;
  const t = await api(repo(`/git/trees/${encodeURIComponent(S.cfg.branch)}?recursive=1`));
  S.paths = [];
  S.sha.clear();
  S.size.clear();
  for (const e of t.tree) {
    if (e.type !== "blob" || !e.path.startsWith("papers/")) continue;
    S.paths.push(e.path);
    S.sha.set(e.path, e.sha);
    S.size.set(e.path, e.size);
  }
  S.treeAt = Date.now();
}

const exists = (path) => S.sha.has(path);

async function blob(path) {
  const sha = S.sha.get(path);
  if (!sha) throw new Error(`${path} does not exist on ${S.cfg.branch}`);
  if (!S.blobs.has(sha)) S.blobs.set(sha, api(repo(`/git/blobs/${sha}`), { accept: "application/vnd.github.raw+json", as: "blob" }));
  return S.blobs.get(sha);
}
async function text(path) { return (await blob(path)).text(); }
async function textOr(path, fallback = null) { return exists(path) ? text(path) : fallback; }

async function download(path) {
  try {
    const b = await blob(path);
    const url = URL.createObjectURL(b);
    const a = Object.assign(document.createElement("a"), { href: url, download: path.split("/").pop() });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (e) { toast(e.message, true); }
}

function b64FromBytes(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
const b64FromText = (t) => b64FromBytes(new TextEncoder().encode(t));
async function b64FromFile(file) { return b64FromBytes(new Uint8Array(await file.arrayBuffer())); }

// Commit several files in one commit (Git Data API). files: [{path, b64}]
async function commit(files, message, onStep = () => {}) {
  const ref = await api(repo(`/git/ref/heads/${S.cfg.branch}`));
  const head = ref.object.sha;
  const base = await api(repo(`/git/commits/${head}`));
  const tree = [];
  for (const [i, f] of files.entries()) {
    onStep(i, files.length, f.path);
    const b = await api(repo("/git/blobs"), { method: "POST", body: { content: f.b64, encoding: "base64" } });
    tree.push({ path: f.path, mode: "100644", type: "blob", sha: b.sha });
  }
  onStep(files.length, files.length, "commit");
  const t = await api(repo("/git/trees"), { method: "POST", body: { base_tree: base.tree.sha, tree } });
  const c = await api(repo("/git/commits"), { method: "POST", body: { message, tree: t.sha, parents: [head] } });
  await api(repo(`/git/refs/heads/${S.cfg.branch}`), { method: "PATCH", body: { sha: c.sha } });
  S.treeAt = 0;
  return c;
}

// ------------------------------------------------------------------ paper model

function slugs() {
  const out = new Set();
  for (const p of S.paths) {
    const m = p.match(/^papers\/([^/]+)\/input\//);
    if (m) out.add(m[1]);
  }
  return [...out].sort();
}

function stageState(slug) {
  const done = STAGES.map(([, f]) => exists(`papers/${slug}/${f}`));
  const current = done.indexOf(false);
  const started = S.paths.some((p) => p.startsWith(`papers/${slug}/work/`));
  return { done, current: current === -1 ? 7 : current, started, complete: current === -1 };
}

function stepper(slug) {
  const st = stageState(slug);
  return `<div class="stepper" aria-label="Pipeline stages">${STAGES.map(([name], i) => {
    const cls = st.done[i] ? "done" : (i === st.current && st.started ? "current" : "");
    return `<div class="step ${cls}" title="Stage ${i}: ${name}${st.done[i] ? " (done)" : ""}"><div class="bar"></div><span>${i} ${name}</span></div>`;
  }).join("")}</div>`;
}

function nextStep(slug) {
  const st = stageState(slug);
  if (st.complete) return { cmd: `/draft-paper papers/${slug} --from 1`, text: "The draft is built. Review the open items and the report. After you change inputs (for example add a PDF or fix the reference list), rerun from the stage that uses them." };
  if (!st.started) return { cmd: `/draft-paper papers/${slug}`, text: "Inputs are in place. Start the pipeline in a Claude Code session on this repository." };
  return { cmd: `/draft-paper papers/${slug} --resume`, text: `The run stopped before stage ${st.current} (${STAGES[st.current][0]}). Resume it in a Claude Code session.` };
}

async function brief(slug) {
  const t = await textOr(`papers/${slug}/input/brief.yaml`);
  if (!t) return {};
  try { return jsyaml.load(t) || {}; } catch { return {}; }
}

async function refsIndex(slug) {
  if (S.refs.has(slug)) return S.refs.get(slug);
  const idx = {};
  try {
    for (const r of JSON.parse(await textOr(`papers/${slug}/work/refs.json`, "[]"))) idx[r.key] = r;
  } catch { /* no refs yet */ }
  S.refs.set(slug, idx);
  return idx;
}

function latestVersion(slug) {
  return VERSIONS.map((v) => `papers/${slug}/${v}`).find(exists) || null;
}

// ------------------------------------------------------------------ markdown rendering

function authorYear(ref, narrative) {
  const c = ref?.csl || {};
  const au = c.author || [];
  const fam = (a) => a.family || a.literal || "?";
  const year = c.issued?.["date-parts"]?.[0]?.[0] || "n.d.";
  const names = au.length === 0 ? "?" : au.length === 1 ? fam(au[0]) : au.length === 2
    ? `${fam(au[0])} ${narrative ? "and" : "&"} ${fam(au[1])}` : `${fam(au[0])} et al.`;
  return { names, year };
}

function renderCitations(md, refs) {
  const one = (item) => {
    const m = item.trim().match(/^(-?)@([\w:.#$%&+?<>~/-]*\w)\s*,?\s*(.*)$/);
    if (!m) return esc(item.trim());
    const { names, year } = authorYear(refs[m[2]]);
    const loc = m[3] ? `, ${esc(m[3])}` : "";
    return (m[1] ? `${year}` : `${esc(names)}, ${year}`) + loc;
  };
  md = md.replace(/\[([^\[\]]*@[^\[\]]*)\]/g, (all, inner) =>
    /@/.test(inner) ? `<span class="cite">(${inner.split(";").map(one).join("; ")})</span>` : all);
  return md.replace(/(^|[^\w@>(\-])@([A-Za-z0-9_][\w:.#$%&+?<>~/-]*[A-Za-z0-9_])/g, (all, pre, key) => {
    if (!refs[key]) return all;
    const { names, year } = authorYear(refs[key], true);
    return `${pre}<span class="cite">${esc(names)} (${year})</span>`;
  });
}

function renderMarkers(md) {
  return md.replace(MARKER_RE, (all, kind, txt) => {
    const [cls, title] = MARKER_INFO[kind];
    return `<mark class="mk mk-${cls}" title="${esc(title)}"><b>${esc(kind)}</b>${esc(txt || "")}</mark>`;
  });
}

function mdToHtml(md, { refs = null, manuscript = false } = {}) {
  md = String(md || "").replace(/^---\n[\s\S]*?\n(---|\.\.\.)\n/, "");
  md = md.replace(/^(#{1,6} .*?)\s*\{[^}]*\}\s*$/gm, "$1");
  if (manuscript) {
    md = renderMarkers(md);
    if (refs) md = renderCitations(md, refs);
    md = md.replace(/^Table: (.*)$/gm, "**$1**");
  }
  const html = marked.parse(md, { gfm: true, breaks: false });
  return DOMPurify.sanitize(html, { ADD_ATTR: ["title"], FORBID_TAGS: ["style", "form", "input"] });
}

async function hydrateImages(root, baseDir) {
  for (const img of $$("img", root)) {
    const src = img.getAttribute("src") || "";
    if (/^(https?:|data:|blob:)/.test(src)) continue;
    const path = `${baseDir}/${src}`.replace(/\/\.\//g, "/");
    img.removeAttribute("src");
    img.alt = img.alt || src;
    if (exists(path)) blob(path).then((b) => { img.src = URL.createObjectURL(b); }).catch(() => {});
  }
}

// ------------------------------------------------------------------ router

const app = () => $("#app");
const ROUTES = [
  [/^#\/?$/, viewPapers, "papers"],
  [/^#\/settings$/, viewSettings, "settings"],
  [/^#\/help$/, viewHelp, "help"],
  [/^#\/new$/, viewNew, "new"],
  [/^#\/paper\/([^/]+)(?:\/([a-z]+))?(?:\/(.+))?$/, viewPaper, "papers"],
];

async function route() {
  const hash = location.hash || "#/";
  const connected = S.cfg.token && S.cfg.owner && S.cfg.repo;
  const badge = $("#repo-badge");
  badge.hidden = !connected;
  badge.textContent = connected ? `${S.cfg.owner}/${S.cfg.repo} · ${S.cfg.branch}` : "";
  for (const [re, view, nav] of ROUTES) {
    const m = hash.match(re);
    if (!m) continue;
    $$(".nav a").forEach((a) => a.classList.toggle("active", a.dataset.nav === nav));
    if (!connected && !["settings", "help"].includes(nav)) return viewSettings(null, true);
    try { await view(...m.slice(1).map((x) => x && decodeURIComponent(x))); }
    catch (e) {
      console.error(e);
      app().innerHTML = `<div class="callout bad"><b>Something went wrong.</b> ${esc(e.message)}</div>
        <p><a class="btn" href="#/settings">Check the connection</a> <button class="btn" id="retry">Retry</button></p>`;
      $("#retry").onclick = () => { S.treeAt = 0; route(); };
    }
    return;
  }
  location.hash = "#/";
}

// ------------------------------------------------------------------ view: connection

function viewSettings(_, firstRun = false) {
  const c = S.cfg;
  app().innerHTML = `
    <div class="page-head"><h1>Connect to your repository</h1>
      <p class="muted">This page is a shell: it holds no papers. It reads and writes your private repository through the
      GitHub API, using a token that stays in this browser.</p></div>
    ${firstRun ? `<div class="callout" style="margin-bottom:16px">Connect once to see your papers.</div>` : ""}
    <form id="cfg" class="card stack" autocomplete="off">
      <div class="form-grid">
        <div class="field"><label for="owner" class="req">Owner</label><input id="owner" type="text" value="${esc(c.owner)}" placeholder="your-github-username" required></div>
        <div class="field"><label for="repo" class="req">Repository</label><input id="repo" type="text" value="${esc(c.repo || "")}" placeholder="papers-ab-audit" required></div>
        <div class="field"><label for="branch" class="req">Branch</label><input id="branch" type="text" value="${esc(c.branch)}" required>
          <span class="hint">The branch the pipeline commits to.</span></div>
        <div class="field wide"><label for="token" class="req">Fine-grained personal access token</label>
          <input id="token" type="password" value="${esc(c.token)}" placeholder="github_pat_…" required>
          <span class="hint">Create one at <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">github.com/settings/personal-access-tokens</a>:
          Repository access → <i>Only select repositories</i> → this repository; Permissions → <i>Contents: Read and write</i>. Set an expiry.</span></div>
        <label class="check wide"><input id="remember" type="checkbox" ${c.remember ? "checked" : ""}>
          <span>Remember the token on this device<br><span class="hint">Off: it is forgotten when you close the tab. Turn it on only on a device you trust.</span></span></label>
        <details class="wide"><summary class="small muted">Advanced</summary>
          <div class="field" style="margin-top:8px"><label for="apibase">API base URL</label><input id="apibase" type="url" value="${esc(c.api)}"></div></details>
      </div>
      <div class="row"><button class="btn primary" type="submit">Test and save</button>
        ${c.token ? `<button class="btn danger" type="button" id="forget">Forget token</button>` : ""}
        <span id="cfg-status" class="muted small"></span></div>
    </form>`;
  $("#cfg").onsubmit = async (ev) => {
    ev.preventDefault();
    const next = { owner: $("#owner").value.trim(), repo: $("#repo").value.trim(), branch: $("#branch").value.trim() || "main",
      token: $("#token").value.trim(), remember: $("#remember").checked, api: $("#apibase").value.trim() || "https://api.github.com" };
    const prev = S.cfg;
    S.cfg = next;
    $("#cfg-status").textContent = "Checking…";
    try {
      const r = await api(repo(""));
      await api(repo(`/branches/${encodeURIComponent(next.branch)}`));
      saveCfg(next);
      S.paths = null; S.blobs.clear(); S.refs.clear();
      toast(`Connected to ${r.full_name}${r.private ? " (private)" : ""}`);
      if (r.private === false) toast("Warning: this repository is public.", true);
      if (r.permissions && !r.permissions.push) toast("The token can read but not write: uploads will fail.", true);
      location.hash = "#/";
      route();
    } catch (e) {
      S.cfg = prev;
      $("#cfg-status").textContent = e.message;
    }
  };
  const forget = $("#forget");
  if (forget) forget.onclick = () => { S.cfg = { ...S.cfg, token: "" }; saveCfg(S.cfg); toast("Token forgotten"); route(); };
}

// ------------------------------------------------------------------ view: papers

async function viewPapers() {
  app().innerHTML = `<div class="page-head spread"><div><h1>Papers</h1><p class="muted">Each folder in <code>papers/</code> on <code>${esc(S.cfg.branch)}</code>.</p></div>
    <div class="row"><button class="btn" id="refresh">Refresh</button><a class="btn primary" href="#/new">New paper</a></div></div>
    <div id="list" class="grid"><div class="card"><div class="skeleton"></div><div class="skeleton"></div></div></div>`;
  $("#refresh").onclick = () => { S.treeAt = 0; route(); };
  await loadTree();
  const list = slugs();
  if (!list.length) {
    $("#list").outerHTML = `<div class="card empty"><h2>No papers yet</h2><p>Create the first one: you fill in the brief and upload your outline, results and references.</p><a class="btn primary" href="#/new">New paper</a></div>`;
    return;
  }
  $("#list").innerHTML = list.map((s) => `<a class="card paper-card" href="#/paper/${encodeURIComponent(s)}" style="text-decoration:none;color:inherit" id="card-${esc(s)}">
      <div class="spread"><h2 style="margin:0">${esc(s)}</h2>${badgeFor(s)}</div>
      <p class="muted small meta" style="margin:.3em 0 0">&nbsp;</p>${stepper(s)}</a>`).join("");
  await Promise.all(list.map(async (s) => {
    const b = await brief(s);
    const card = $(`#card-${CSS.escape(s)}`);
    if (!card) return;
    if (b.paper?.title) $("h2", card).textContent = b.paper.title;
    $(".meta", card).textContent = [s, b.paper?.target_journal, b.paper?.article_type].filter(Boolean).join(" · ");
    const pdf = await pdfState(s);
    if (pdf.autoOpen || pdf.paused) {
      const n = pdf.items.filter((i) => i.status === "requested").length;
      $(".spread", card).insertAdjacentHTML("beforeend", `<span class="badge warn">${n} PDF${n === 1 ? "" : "s"} wanted</span>`);
    }
  }));
}

function badgeFor(slug) {
  const st = stageState(slug);
  if (st.complete) return `<span class="badge ok">Draft ready</span>`;
  if (!st.started) return `<span class="badge info">Ready to run</span>`;
  return `<span class="badge warn">At stage ${st.current}: ${STAGES[st.current][0]}</span>`;
}

// ------------------------------------------------------------------ view: one paper

const TABS = [["overview", "Overview"], ["manuscript", "Manuscript"], ["items", "Open items"], ["report", "Report"],
  ["audits", "Audits"], ["sources", "Sources"], ["files", "Files"], ["brief", "Brief"]];

async function viewPaper(slug, tab = "overview", sub = null) {
  await loadTree();
  if (!slugs().includes(slug)) {
    app().innerHTML = `<div class="card empty"><h2>No paper “${esc(slug)}”</h2><a class="btn" href="#/">All papers</a></div>`;
    return;
  }
  const b = await brief(slug);
  const pdf = await pdfState(slug);
  const ns = pdf.paused ? { cmd: pdf.cmd, text: `The pipeline paused after ${pdf.req.round === "search" ? "the literature search" : "checking your reference list"} because some sources are not available as PDFs. Upload the ones you have, then resume.` } : nextStep(slug);
  const P = `papers/${slug}`;
  const ver = latestVersion(slug);
  const items = ver ? markersIn(await text(ver)) : [];
  const open = items.filter((i) => ["NEED", "VERIFY"].includes(i.kind)).length;
  app().innerHTML = `
    <div class="page-head spread">
      <div><p class="muted small" style="margin:0"><a href="#/">Papers</a> / ${esc(slug)}</p>
        <h1>${esc(b.paper?.title || slug)}</h1>
        <p class="muted">${[b.paper?.target_journal, b.paper?.article_type, b.design].filter(Boolean).map(esc).join(" · ")}</p></div>
      <div class="row">${badgeFor(slug)}<button class="btn small" id="refresh">Refresh</button></div>
    </div>
    ${stepper(slug)}
    <nav class="tabs" aria-label="Paper sections">${TABS.map(([id, label]) =>
      `<a href="#/paper/${encodeURIComponent(slug)}/${id}" class="${id === tab ? "active" : ""}">${label}${id === "items" && open ? ` <span class="badge need">${open}</span>` : ""}</a>`).join("")}</nav>
    <section id="tab"></section>`;
  $("#refresh").onclick = () => { S.treeAt = 0; S.refs.delete(slug); route(); };
  const el = $("#tab");
  const views = { overview: tabOverview, manuscript: tabManuscript, items: tabItems, report: tabReport, audits: tabAudits,
    sources: tabSources, files: tabFiles, brief: tabBrief };
  await (views[tab] || tabOverview)(el, { slug, P, b, ns, ver, items, sub, pdf });
  const seen = `pw.pdfdlg.${S.cfg.owner}/${S.cfg.repo}/${slug}/${pdf.req?.created || ""}`;
  if (tab === "pdfs" || (pdf.autoOpen && !SESSION?.getItem(seen))) {
    SESSION?.setItem(seen, "1");
    openPdfDialog(slug, pdf);
  }
}

function cmdBox(cmd) {
  return `<div class="cmd"><code>${esc(cmd)}</code><button class="btn small" data-copy="${esc(cmd)}">Copy</button></div>`;
}
function wireCopy(root) { $$("[data-copy]", root).forEach((b) => { b.onclick = () => copy(b.dataset.copy); }); }

async function tabOverview(el, { slug, P, ns, ver, items, pdf }) {
  const outs = [["output/manuscript.docx", "Manuscript (Word)"], ["output/manuscript.md", "Manuscript (Markdown)"],
    ["output/references.bib", "References (BibTeX)"], ["output/REPORT.md", "Report"],
    ["output/render/manuscript_libreoffice.pdf", "Rendered PDF"]].filter(([f]) => exists(`${P}/${f}`));
  const count = (k) => items.filter((i) => i.kind === k).length;
  const runlog = await textOr(`${P}/work/run_log.md`);
  const missing = pdf.items.filter((i) => i.status !== "received");
  const uploaded = missing.filter((i) => i.status === "uploaded").length;
  const pdfCallout = pdf.paused
    ? `<div class="callout warn spread" style="margin-bottom:16px"><div><b>The pipeline is waiting for PDFs.</b> ${missing.length} source(s) could not be obtained as full text;
        ${uploaded} uploaded so far. Upload what you have, then resume.</div><button class="btn primary" id="open-pdfs">Upload PDFs</button></div>`
    : missing.length ? `<div class="callout spread" style="margin-bottom:16px"><div>${missing.length} source(s) were read without a full text.
        A PDF lets the claims that cite them be checked.</div><button class="btn" id="open-pdfs">Upload PDFs</button></div>` : "";
  el.innerHTML = `${pdfCallout}
    <div class="grid">
      <div class="card stack"><h2>Next step</h2><p>${esc(ns.text)}</p>${cmdBox(ns.cmd)}
        <p class="small muted">Run it in a Claude Code session on this repository and branch: at
        <a href="https://claude.ai/code" target="_blank" rel="noopener noreferrer">claude.ai/code</a>, with
        <code>claude --cloud "${esc(ns.cmd)}"</code>, or locally after <code>claude --model fable --effort max</code>.
        Other options: <code>--resume</code> continues an interrupted run; <code>--from N</code> reruns from stage N.</p></div>
      <div class="card stack"><h2>Outputs</h2>
        ${outs.length ? `<div class="row">${outs.map(([f, l]) => `<button class="btn" data-dl="${esc(`${P}/${f}`)}">⤓ ${esc(l)}</button>`).join("")}</div>`
          : `<p class="muted">No outputs yet: they appear after stage 6 (Build).</p>`}
        ${ver ? `<p class="small muted">Latest manuscript version: <code>${esc(ver.slice(P.length + 1))}</code></p>
        <div class="row">
          <a class="badge need" href="#/paper/${encodeURIComponent(slug)}/items">${count("NEED")} NEED</a>
          <a class="badge verify" href="#/paper/${encodeURIComponent(slug)}/items">${count("VERIFY")} VERIFY</a>
          <a class="badge comment" href="#/paper/${encodeURIComponent(slug)}/items">${count("COMMENT")} COMMENT</a>
          ${count("ADDED") ? `<span class="badge added">${count("ADDED")} ADDED</span>` : ""}</div>` : ""}
      </div>
    </div>
    <div class="card" style="margin-top:16px"><h2>Run log</h2>
      ${runlog ? `<div class="md">${mdToHtml(runlog)}</div>` : `<p class="muted">The pipeline has not started.</p>`}</div>`;
  wireCopy(el);
  $$("[data-dl]", el).forEach((b) => { b.onclick = () => download(b.dataset.dl); });
  if ($("#open-pdfs", el)) $("#open-pdfs", el).onclick = () => openPdfDialog(slug, pdf);
}

async function tabManuscript(el, { slug, P, ver }) {
  if (!ver) { el.innerHTML = `<div class="card empty">No draft yet: the manuscript appears after stage 4.</div>`; return; }
  const refs = await refsIndex(slug);
  const md = await text(ver);
  el.innerHTML = `<div class="spread" style="margin-bottom:12px"><p class="muted small" style="margin:0">Showing <code>${esc(ver.slice(P.length + 1))}</code>.
      Markers are highlighted; citations are shown as author–year.</p>
      <div class="row">${exists(`${P}/output/manuscript.docx`) ? `<button class="btn small" id="dl-docx">⤓ Word</button>` : ""}
      <button class="btn small" id="dl-md">⤓ Markdown</button></div></div>
    <article class="card doc" id="doc">${mdToHtml(md, { refs, manuscript: true })}</article>`;
  if ($("#dl-docx")) $("#dl-docx").onclick = () => download(`${P}/output/manuscript.docx`);
  $("#dl-md").onclick = () => download(ver);
  hydrateImages($("#doc"), `${P}/input`);
}

function markersIn(md) {
  const out = [];
  let section = "";
  for (const para of md.replace(/^---\n[\s\S]*?\n(---|\.\.\.)\n/, "").split(/\n\s*\n/)) {
    const t = para.trim();
    if (t.startsWith("#")) {
      if (t.startsWith("# ")) section = t.slice(2).replace(/\s*\{.*\}\s*$/, "").trim();
      continue;
    }
    for (const m of para.matchAll(MARKER_RE)) {
      const before = para.slice(0, m.index);
      const start = Math.max(before.lastIndexOf(". "), before.lastIndexOf("\n")) + 1;
      const ctx = before.slice(start).replace(/\[[^\]]*@[^\]]*\]/g, "").replace(MARKER_RE, "").replace(/[*_]{1,2}([^*_]+)[*_]{1,2}/g, "$1").trim();
      out.push({ kind: m[1], text: (m[2] || "").trim(), section, ctx: ctx.slice(-220) });
    }
  }
  return out;
}

async function tabItems(el, { slug, ver, items }) {
  if (!ver) { el.innerHTML = `<div class="card empty">No draft yet.</div>`; return; }
  const key = `pw.items.${S.cfg.owner}/${S.cfg.repo}/${slug}`;
  let ticked = {};
  try { ticked = JSON.parse(LOCAL?.getItem(key) || "{}"); } catch { ticked = {}; }
  const groups = ["NEED", "VERIFY", "COMMENT", "ADDED", "OUTSIDE ALLOWLIST"].map((k) => [k, items.filter((i) => i.kind === k)]).filter(([, v]) => v.length);
  if (!groups.length) { el.innerHTML = `<div class="card empty">No open markers in the latest version.</div>`; return; }
  el.innerHTML = `<p class="muted small">From <code>${esc(ver.split("/").slice(2).join("/"))}</code>. Ticks are kept in this browser only, as your
    own checklist; to resolve an item, change the inputs or the text and rerun, or edit the Word file.</p>` +
    groups.map(([k, list]) => `<div class="card"><h2><span class="badge ${MARKER_INFO[k][0]}">${esc(k)}</span> ${esc(MARKER_INFO[k][1])} <span class="muted">(${list.length})</span></h2>
      ${list.map((i) => { const id = hashOf(k + i.text + i.ctx); return `<label class="item ${ticked[id] ? "done" : ""}">
        <input type="checkbox" data-id="${id}" ${ticked[id] ? "checked" : ""}>
        <div><div class="item-meta">${esc(i.section || "")}</div><div class="item-text">${esc(i.text || "(no text)")}</div>
        ${i.ctx ? `<div class="item-ctx">“…${esc(i.ctx)}”</div>` : ""}</div></label>`; }).join("")}</div>`).join("");
  $$("input[data-id]", el).forEach((cb) => {
    cb.onchange = () => {
      ticked[cb.dataset.id] = cb.checked || undefined;
      LOCAL?.setItem(key, JSON.stringify(ticked));
      cb.closest(".item").classList.toggle("done", cb.checked);
    };
  });
}

async function tabReport(el, { P }) {
  const md = await textOr(`${P}/output/REPORT.md`);
  el.innerHTML = md ? `<article class="card md">${mdToHtml(md)}</article>` : `<div class="card empty">The report appears after stage 6 (Build).</div>`;
}

async function tabAudits(el, { slug, P, sub }) {
  const files = S.paths.filter((p) => p.startsWith(`${P}/work/audits/`) && /\.(md|html)$/.test(p)).sort();
  if (!files.length) { el.innerHTML = `<div class="card empty">Audit reports appear during stage 5.</div>`; return; }
  const checks = await textOr(`${P}/work/audits/A5_checks.json`);
  let summary = "";
  try {
    const s = JSON.parse(checks || "null")?.summary;
    if (s) summary = `<div class="card" style="margin-bottom:16px"><h2>Integrity checks (A5)</h2><div class="row">${Object.entries(s)
      .filter(([k]) => k !== "version").map(([k, v]) => `<span class="badge ${v ? "ok" : "bad"}">${esc(k)}: ${v ? "pass" : "fail"}</span>`).join("")}</div></div>`;
  } catch { /* ignore */ }
  const selected = sub && files.includes(`${P}/work/audits/${sub}`) ? `${P}/work/audits/${sub}` : files.find((f) => f.endsWith(".md")) || files[0];
  const label = (f) => {
    const n = f.split("/").pop();
    return n.endsWith(".html") ? `${n.replace(/_diff\.html$/, "")} diff` : n.replace(/\.md$/, "").replace(/_/g, " ");
  };
  el.innerHTML = `${summary}<div class="split"><nav class="card list" aria-label="Audit files">
      <h4>Reports</h4>${files.filter((f) => f.endsWith(".md")).map((f) => `<a href="#/paper/${encodeURIComponent(slug)}/audits/${encodeURIComponent(f.split("/").pop())}" class="${f === selected ? "active" : ""}">${esc(label(f))}</a>`).join("")}
      <h4>Word-level diffs</h4>${files.filter((f) => f.endsWith(".html")).map((f) => `<a href="#/paper/${encodeURIComponent(slug)}/audits/${encodeURIComponent(f.split("/").pop())}" class="${f === selected ? "active" : ""}">${esc(label(f))}</a>`).join("")}
    </nav><div id="audit"></div></div>`;
  const body = await text(selected);
  if (selected.endsWith(".html")) {
    const fr = document.createElement("iframe");
    fr.className = "diff";
    fr.setAttribute("sandbox", "");
    fr.setAttribute("title", label(selected));
    fr.srcdoc = body;
    $("#audit").append(fr);
  } else {
    $("#audit").innerHTML = `<article class="card md">${mdToHtml(body)}</article>`;
  }
}

async function tabSources(el, { slug, P, sub }) {
  const notes = S.paths.filter((p) => p.startsWith(`${P}/work/sources/`) && p.endsWith(".md")).sort();
  if (!notes.length) { el.innerHTML = `<div class="card empty">Source notes appear during stage 1.</div>`; return; }
  const refs = await refsIndex(slug);
  let ev = {};
  try { ev = JSON.parse(await textOr(`${P}/work/evidence.json`, "{}")); } catch { ev = {}; }
  const keyOf = (p) => p.split("/").pop().replace(/\.md$/, "");
  const selected = notes.find((p) => keyOf(p) === sub) || notes[0];
  const lvl = (k) => ({ full_text: ["ok", "full text"], abstract: ["warn", "abstract"], metadata: ["bad", "metadata"] }[ev[k]?.level] || ["", "?"]);
  const stat = (k) => ({ verified: "ok", verified_pdf: "warn", mismatch: "bad", unresolved: "bad" }[refs[k]?.status] || "");
  el.innerHTML = `<div class="split"><nav class="card list" aria-label="Sources">${notes.map((p) => {
      const k = keyOf(p); const [c, t] = lvl(k);
      return `<a href="#/paper/${encodeURIComponent(slug)}/sources/${encodeURIComponent(k)}" class="${p === selected ? "active" : ""}"><span>${esc(k)}</span><span class="badge ${c}">${esc(t)}</span></a>`;
    }).join("")}</nav><div><div class="card small" id="srcmeta"></div><article class="card md" id="note" style="margin-top:16px"></article></div></div>`;
  const k = keyOf(selected);
  const r = refs[k];
  $("#srcmeta").innerHTML = `<dl class="kv"><dt>Evidence</dt><dd><span class="badge ${lvl(k)[0]}">${esc(lvl(k)[1])}</span> ${esc(ev[k]?.source || "")}</dd>
    <dt>Reference</dt><dd>${r ? `<span class="badge ${stat(k)}">${esc(r.status)}</span> ${esc((r.mismatches || []).join("; "))}` : "—"}</dd>
    ${r?.csl?.DOI ? `<dt>DOI</dt><dd><a href="https://doi.org/${esc(r.csl.DOI)}" target="_blank" rel="noopener noreferrer">${esc(r.csl.DOI)}</a></dd>` : ""}
    ${(r?.notices || []).length ? `<dt>Notices</dt><dd><span class="badge bad">${esc(r.notices.map((n) => n.type).join(", "))}</span></dd>` : ""}</dl>`;
  $("#note").innerHTML = mdToHtml(await text(selected));
}

async function tabFiles(el, { slug, P }) {
  const groups = ["input", "work", "output"].map((g) => [g, S.paths.filter((p) => p.startsWith(`${P}/${g}/`)).sort()]);
  el.innerHTML = `
    <div class="card stack" style="margin-bottom:16px"><h2>Add files</h2>
      <p class="small muted">For example the PDF of a reference that was read only at abstract or metadata level, or a corrected results file.
      Files go to <code>input/</code>; rerun from the stage that uses them (PDFs and the reference list: <code>--from 1</code>; results: <code>--from 0</code>).</p>
      <div class="form-grid">
        <div class="field"><label for="dest">Folder</label><select id="dest">
          <option value="input/pdfs">input/pdfs (full texts of references)</option>
          <option value="input/results">input/results (results files)</option>
          <option value="input">input (outline, reference list)</option></select></div>
        <div class="field"><label for="up">Files</label><input id="up" type="file" multiple></div>
      </div>
      <div class="row"><button class="btn primary" id="upload" disabled>Upload</button><span id="upstatus" class="small muted"></span></div>
      <div class="progress" hidden id="upbar"><div></div></div>
    </div>
    ${groups.map(([g, files]) => `<div class="card"><h2>${g}/ <span class="muted small">${files.length} files</span></h2>
      ${files.length ? `<table class="files-table">${files.map((f) => `<tr><td><code>${esc(f.slice(P.length + g.length + 2))}</code></td>
        <td class="muted small">${fmtSize(S.size.get(f))}</td><td><button class="btn small" data-dl="${esc(f)}">Download</button></td></tr>`).join("")}</table>`
        : `<p class="muted">Empty.</p>`}</div>`).join("")}`;
  $$("[data-dl]", el).forEach((b) => { b.onclick = () => download(b.dataset.dl); });
  const up = $("#up");
  up.onchange = () => { $("#upload").disabled = !up.files.length; };
  $("#upload").onclick = async () => {
    const dest = $("#dest").value;
    const files = [...up.files];
    const overwrite = files.filter((f) => exists(`${P}/${dest}/${f.name}`)).map((f) => f.name);
    if (overwrite.length && !confirm(`Replace ${overwrite.join(", ")}?`)) return;
    await withProgress($("#upload"), $("#upstatus"), $("#upbar"), async (step) => {
      const payload = [];
      for (const f of files) payload.push({ path: `${P}/${dest}/${f.name}`, b64: await b64FromFile(f) });
      await commit(payload, `paperwriter web: add ${files.length} file(s) to papers/${slug}/${dest}`, step);
    });
    toast("Uploaded");
    S.treeAt = 0;
    route();
  };
}

async function withProgress(button, status, bar, fn) {
  button.disabled = true;
  bar.hidden = false;
  const fill = $("div", bar);
  try {
    await fn((i, n, what) => {
      fill.style.width = `${Math.round((i / Math.max(n, 1)) * 100)}%`;
      status.textContent = what === "commit" ? "Committing…" : `Uploading ${i + 1} of ${n}: ${what.split("/").pop()}`;
    });
    fill.style.width = "100%";
    status.textContent = "Done";
  } catch (e) {
    status.textContent = e.message;
    toast(e.message, true);
    throw e;
  } finally {
    button.disabled = false;
  }
}

// ------------------------------------------------------------------ missing PDFs window

async function pdfState(slug) {
  const P = `papers/${slug}`;
  let req = null;
  try { req = JSON.parse(await textOr(`${P}/work/pdf_requests.json`, "null")); } catch { req = null; }
  let items = [];
  if (req?.items) items = req.items.map((i) => ({ ...i }));
  else {
    let ev = {};
    try { ev = JSON.parse(await textOr(`${P}/work/evidence.json`, "{}")); } catch { ev = {}; }
    const refs = await refsIndex(slug);
    items = Object.entries(ev).filter(([k, e]) => e.level !== "full_text" && refs[k]).map(([k, e]) => {
      const c = refs[k].csl || {};
      const { names, year } = authorYear(refs[k]);
      return { key: k, citation: `${names} (${year})`, title: c.title || "", venue: c["container-title"] || c.publisher || "",
        type: c.type || "", doi: c.DOI, origin: refs[k].origin || "user", level: e.level, status: "requested",
        reason: e.note || (e.level === "abstract" ? "only the abstract was available" : "no open-access copy was found") };
    });
  }
  const past = !req || (req.round === "search" ? exists(`${P}/work/03_plan.md`) : exists(`${P}/work/01_gaps.md`));
  const paused = !!req && !past && items.some((i) => i.status !== "received");
  const autoOpen = req?.status === "waiting" && items.some((i) => i.status === "requested");
  return { P, req, items, past, paused, autoOpen, cmd: paused ? `/draft-paper ${P} --resume` : `/draft-paper ${P} --from 1` };
}

const LEVEL_LABEL = { abstract: ["warn", "abstract only"], metadata: ["bad", "no text"] };

function pdfRow(i) {
  const [lc, lt] = LEVEL_LABEL[i.level] || ["", i.level || ""];
  const kind = i.type === "book" ? "book" : i.type === "chapter" ? "chapter" : "";
  const actions = {
    requested: `<label class="btn primary small upload-btn">Upload PDF<input type="file" accept="application/pdf,.pdf" hidden></label>
      <button type="button" class="btn small" data-skip>I don't have it</button>`,
    uploaded: `<span class="badge ok">✓ Uploaded${i.uploaded_file ? `: ${esc(i.uploaded_file)}` : ""}</span>
      <label class="btn small upload-btn">Replace<input type="file" accept="application/pdf,.pdf" hidden></label>`,
    skipped: `<span class="badge">Skipped</span><label class="btn small upload-btn">Upload anyway<input type="file" accept="application/pdf,.pdf" hidden></label>
      <button type="button" class="btn small" data-unskip>Undo</button>`,
    received: `<span class="badge ok">✓ Full text received</span>`,
  }[i.status] || "";
  return `<li class="pdf-item ${i.status}" data-key="${esc(i.key)}">
    <div class="pdf-info">
      <div class="pdf-title">${esc(i.title || i.key)}</div>
      <div class="pdf-meta">${esc(i.citation || "")}${i.venue ? ` · <i>${esc(i.venue)}</i>` : ""}${i.doi ? ` · <a href="https://doi.org/${esc(i.doi)}" target="_blank" rel="noopener noreferrer">doi.org/${esc(i.doi)} ↗</a>` : ""}</div>
      <div class="row small" style="gap:6px;margin-top:4px"><span class="badge ${lc}">${esc(lt)}</span>
        <span class="badge ${i.origin === "added" ? "added" : "info"}">${i.origin === "added" ? "added by the search" : "your reference"}</span>
        ${kind ? `<span class="badge">${kind}</span>` : ""}<span class="muted">${esc(i.reason || "")}</span></div>
    </div>
    <div class="pdf-actions">${actions}<span class="pdf-busy small muted"></span></div>
  </li>`;
}

function openPdfDialog(slug, st) {
  document.querySelector("dialog.dlg")?.remove();
  const dlg = document.createElement("dialog");
  dlg.className = "dlg";
  dlg.setAttribute("aria-labelledby", "dlg-title");
  const when = st.req?.round === "search" ? "The literature search added these references, but their full texts are not openly available."
    : st.req && !st.past ? "The pipeline checked your reference list and could not get these sources as full texts."
    : "These sources were read only as an abstract or as bibliographic data.";
  const render = () => {
    const open = st.items.filter((i) => i.status !== "received");
    const done = st.items.filter((i) => i.status === "uploaded").length;
    const skipped = st.items.filter((i) => i.status === "skipped").length;
    dlg.innerHTML = `
      <div class="dlg-head"><div><h2 id="dlg-title">Full texts missing for ${open.length} source${open.length === 1 ? "" : "s"}</h2>
        <p class="muted small" style="margin:0">${esc(when)} Claims citing them can be checked only against what the pipeline can read,
        so those sentences get a [VERIFY] marker. If you have a PDF (for example through your library), upload it; or drag it onto its row.</p></div>
        <button type="button" class="btn small dlg-x" aria-label="Close">✕</button></div>
      <ul class="pdf-list">${st.items.filter((i) => i.status !== "received").map(pdfRow).join("")}</ul>
      ${st.items.some((i) => i.status === "received") ? `<details class="dlg-received small"><summary>Received earlier (${st.items.filter((i) => i.status === "received").length})</summary>
        <ul class="pdf-list">${st.items.filter((i) => i.status === "received").map(pdfRow).join("")}</ul></details>` : ""}
      <div class="dlg-foot"><span class="muted small">${done} uploaded · ${skipped} skipped · ${open.length - done - skipped} open</span>
        <div class="row"><button type="button" class="btn" data-later>Later</button><button type="button" class="btn primary" data-done>Done</button></div></div>`;
    wire();
  };
  const wire = () => {
    $(".dlg-x", dlg).onclick = () => dlg.close();
    $("[data-later]", dlg).onclick = () => dlg.close();
    $("[data-done]", dlg).onclick = () => finish();
    for (const row of $$(".pdf-item", dlg)) {
      const item = st.items.find((i) => i.key === row.dataset.key);
      const input = $("input[type=file]", row);
      if (input) input.onchange = () => input.files[0] && upload(item, input.files[0], row);
      const skip = $("[data-skip]", row);
      if (skip) skip.onclick = () => { item.status = "skipped"; render(); };
      const unskip = $("[data-unskip]", row);
      if (unskip) unskip.onclick = () => { item.status = "requested"; render(); };
      if (item.status === "received") continue;
      row.ondragover = (e) => { e.preventDefault(); row.classList.add("drag"); };
      row.ondragleave = () => row.classList.remove("drag");
      row.ondrop = (e) => { e.preventDefault(); row.classList.remove("drag"); if (e.dataTransfer.files[0]) upload(item, e.dataTransfer.files[0], row); };
    }
  };
  const freshRequest = async () => {
    await loadTree(true);
    try { return JSON.parse(await text(`${st.P}/work/pdf_requests.json`)); } catch { return st.req; }
  };
  const upload = async (item, file, row) => {
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    if (String.fromCharCode(...head) !== "%PDF-") { toast(`${file.name} is not a PDF`, true); return; }
    if (file.size > 95 * 1048576) { toast("Files over 95 MB cannot be uploaded through the GitHub API", true); return; }
    $$("button, input", row).forEach((x) => { x.disabled = true; });
    $(".pdf-busy", row).textContent = `Uploading ${file.name}…`;
    try {
      const files = [{ path: `${st.P}/input/pdfs/${item.key}.pdf`, b64: await b64FromFile(file) }];
      if (st.req) {
        const fresh = await freshRequest();
        const it = fresh.items.find((x) => x.key === item.key);
        if (it) Object.assign(it, { status: "uploaded", uploaded_file: file.name, uploaded_at: new Date().toISOString() });
        st.req = fresh;
        files.push({ path: `${st.P}/work/pdf_requests.json`, b64: b64FromText(JSON.stringify(fresh, null, 1) + "\n") });
      }
      await commit(files, `paperwriter web: PDF for ${item.key} (papers/${slug})`);
      Object.assign(item, { status: "uploaded", uploaded_file: file.name });
      toast(`Uploaded ${item.key}.pdf`);
    } catch (e) {
      toast(e.message, true);
    }
    render();
  };
  const finish = async () => {
    const btn = $("[data-done]", dlg);
    btn.disabled = true;
    try {
      if (st.req && (st.req.status === "waiting" || st.items.some((i) => i.status === "skipped"))) {
        const fresh = await freshRequest();
        for (const it of fresh.items) {
          const mine = st.items.find((i) => i.key === it.key);
          if (mine && mine.status === "skipped" && it.status === "requested") it.status = "skipped";
        }
        fresh.status = "answered";
        fresh.answered_at = new Date().toISOString();
        st.req = fresh;
        await commit([{ path: `${st.P}/work/pdf_requests.json`, b64: b64FromText(JSON.stringify(fresh, null, 1) + "\n") }],
          `paperwriter web: answer the PDF request for papers/${slug}`);
      }
    } catch (e) { toast(e.message, true); btn.disabled = false; return; }
    const uploaded = st.items.filter((i) => i.status === "uploaded").length;
    dlg.innerHTML = `<div class="dlg-head"><div><h2 id="dlg-title">${uploaded ? `${uploaded} PDF${uploaded === 1 ? "" : "s"} uploaded` : "No PDFs uploaded"}</h2></div>
        <button type="button" class="btn small dlg-x" aria-label="Close">✕</button></div>
      <div class="stack" style="padding:0 22px 22px">
        <p>${st.paused ? "Resume the pipeline in your Claude Code session; it reads the new PDFs first and continues without the ones you skipped."
          : "Rerun from stage 1 so the new texts are read and the claims citing them are checked again."}</p>${cmdBox(st.cmd)}
        <p class="small muted">In a Claude Code session on this repository: claude.ai/code, <code>claude --cloud "${esc(st.cmd)}"</code>, or locally.</p>
        <div class="row"><button type="button" class="btn primary" data-close>Close</button></div></div>`;
    wireCopy(dlg);
    $(".dlg-x", dlg).onclick = () => dlg.close();
    $("[data-close]", dlg).onclick = () => dlg.close();
  };
  dlg.addEventListener("close", () => { dlg.remove(); if (location.hash.endsWith("/pdfs")) history.replaceState(null, "", location.hash.replace(/\/pdfs$/, "")); route(); });
  document.body.append(dlg);
  render();
  dlg.showModal();
}

// ------------------------------------------------------------------ brief form (new paper and edit)

const OPT = (vals, cur) => vals.map((v) => `<option value="${esc(v)}" ${String(cur) === String(v) ? "selected" : ""}>${esc(v)}</option>`).join("");
const lines = (v) => (Array.isArray(v) ? v : []).join("\n");

function briefFormHtml(b) {
  const p = b.paper || {}, l = b.language || {}, w = b.word_limits || {}, ct = w.counts_toward_total || {};
  const n = b.author_note || {}, c = b.constraints || {}, o = b.options || {}, m = o.models || {};
  const per = Object.entries(w.per_section || {});
  const authors = (b.authors && b.authors.length ? b.authors : [{ name: "", affiliations: [] }]);
  const stageRows = Object.entries(m).filter(([k]) => k !== "default");
  return `
  <fieldset><legend>Paper</legend><div class="form-grid">
    <div class="field wide"><label for="f-title" class="req">Working title</label><input id="f-title" type="text" value="${esc(p.title)}" required></div>
    <div class="field"><label for="f-journal" class="req">Target journal</label><input id="f-journal" type="text" value="${esc(p.target_journal)}" required></div>
    <div class="field"><label for="f-type">Article type</label><select id="f-type">${OPT(["empirical", "multi-study", "short report", "theoretical/review", "registered report"], p.article_type || "empirical")}</select></div>
    <div class="field"><label for="f-rh">Running head <span class="hint">(optional, max 50)</span></label><input id="f-rh" type="text" maxlength="50" value="${esc(p.running_head)}"></div>
    <div class="field"><label for="f-design">Design <span class="hint">(governs causal language)</span></label><select id="f-design">${OPT(["experimental", "longitudinal", "cross-sectional", "meta-analytic", "theoretical"], b.design || "cross-sectional")}</select></div>
    <div class="field"><label for="f-lang">Language</label><select id="f-lang">${OPT(["en-US", "en-GB", "pl"], l.variant || "en-US")}</select></div>
    <div class="field"><label for="f-style">Citation style <span class="hint">(CSL file name; apa = APA 7)</span></label><input id="f-style" type="text" value="${esc(l.citation_style || "apa")}"></div>
  </div></fieldset>
  <fieldset><legend>Authors</legend><div id="authors">${authors.map(authorRow).join("")}</div>
    <button type="button" class="btn small" id="add-author">+ Author</button>
    <div class="form-grid" style="margin-top:14px">
      ${[["orcid", "ORCID iDs"], ["funding", "Funding"], ["conflicts", "Conflicts of interest"], ["data_availability", "Data availability"],
        ["preregistration", "Preregistration"], ["ethics", "Ethics approval"], ["correspondence", "Correspondence"]].map(([k, lab]) =>
        `<div class="field"><label for="n-${k}">${lab}</label><textarea id="n-${k}" rows="2">${esc(n[k])}</textarea></div>`).join("")}
    </div></fieldset>
  <fieldset><legend>Word limits</legend><div class="form-grid">
    <div class="field"><label for="w-total">Total <span class="hint">(empty = none)</span></label><input id="w-total" type="number" min="0" value="${esc(w.total ?? "")}"></div>
    <div class="field"><label for="w-abs">Abstract</label><input id="w-abs" type="number" min="0" value="${esc(w.abstract ?? 250)}"></div>
    <div class="field wide"><label>Counts toward the total</label><div class="row">
      ${[["abstract", "Abstract"], ["tables", "Tables"], ["figure_captions", "Figure captions"], ["references", "References"]].map(([k, lab]) =>
        `<label class="check"><input type="checkbox" id="ct-${k}" ${ct[k] ? "checked" : ""}> ${lab}</label>`).join("")}</div></div>
    <div class="field wide"><label>Per-section limits <span class="hint">(optional)</span></label><div id="persec">${per.map(([s, v]) => secRow(s, v)).join("")}</div>
      <div><button type="button" class="btn small" id="add-sec">+ Section limit</button></div></div>
  </div></fieldset>
  <fieldset><legend>Constraints</legend><div class="form-grid">
    <div class="field"><label for="c-terms">Protected terms <span class="hint">(one per line; never altered)</span></label><textarea id="c-terms" rows="3">${esc(lines(c.protected_terms))}</textarea></div>
    <div class="field"><label for="c-frame">Framing constraints <span class="hint">(one per line)</span></label><textarea id="c-frame" rows="3">${esc(lines(c.framing))}</textarea></div>
  </div></fieldset>
  <fieldset><legend>Options</legend><div class="form-grid">
    <label class="check"><input type="checkbox" id="o-pre" ${o.allow_preprints ? "checked" : ""}> Allow preprints in the literature search</label>
    <label class="check"><input type="checkbox" id="o-pause" ${o.pause_after_plan ? "checked" : ""}> Pause after the argument plan for my approval</label>
    <label class="check"><input type="checkbox" id="o-pdfs" ${o.pause_for_pdfs !== false ? "checked" : ""}> Pause to ask for PDFs that could not be obtained
      <span class="hint">(after the reference check and after the literature search)</span></label>
    <div class="field"><label for="o-max">Max added references</label><input id="o-max" type="number" min="0" max="50" value="${esc(o.max_added_refs ?? 15)}"></div>
    <div class="field"><label for="o-rounds">Audit rounds</label><select id="o-rounds">${OPT([1, 2], o.audit_rounds ?? 1)}</select></div>
    <div class="field"><label for="o-model">Model (all stages)</label><select id="o-model">${OPT(["fable", "opus", "sonnet"], m.default?.model || "fable")}</select></div>
    <div class="field"><label for="o-effort">Effort (all stages)</label><select id="o-effort">${OPT(["max", "xhigh", "high", "medium", "low"], m.default?.effort || "max")}</select></div>
    <details class="wide" ${stageRows.length ? "open" : ""}><summary class="small">Per-stage model and effort</summary>
      <div id="stages" style="margin-top:8px">${stageRows.map(([a, v]) => stageRow(a, v)).join("")}</div>
      <button type="button" class="btn small" id="add-stage">+ Stage override</button>
      <p class="hint">If <code>CLAUDE_CODE_EFFORT_LEVEL</code> is set in your environment it overrides every effort setting here.</p></details>
  </div></fieldset>`;
}

function authorRow(a = {}) {
  return `<div class="repeat-row author"><input type="text" placeholder="Full name" aria-label="Author name" value="${esc(a.name)}">
    <input type="text" placeholder="Affiliations, separated by ;" aria-label="Affiliations" value="${esc((a.affiliations || []).join("; "))}">
    <button type="button" class="btn small" data-remove aria-label="Remove author">✕</button></div>`;
}
function secRow(s = "", v = "") {
  return `<div class="repeat-row two sec"><input type="text" placeholder="Section (e.g. Introduction)" aria-label="Section" value="${esc(s)}">
    <input type="number" min="0" placeholder="Words" aria-label="Word limit" value="${esc(v)}"><button type="button" class="btn small" data-remove aria-label="Remove">✕</button></div>`;
}
function stageRow(a = "intake", v = {}) {
  return `<div class="repeat-row stage" style="grid-template-columns:1fr 1fr 1fr auto"><select aria-label="Stage">${OPT(AGENTS, a)}</select>
    <select aria-label="Model">${OPT(["fable", "opus", "sonnet"], v.model || "fable")}</select>
    <select aria-label="Effort">${OPT(["max", "xhigh", "high", "medium", "low"], v.effort || "max")}</select>
    <button type="button" class="btn small" data-remove aria-label="Remove">✕</button></div>`;
}

function wireBriefForm(root) {
  const add = (btn, box, html) => { $(btn, root).onclick = () => $(box, root).insertAdjacentHTML("beforeend", html()); };
  add("#add-author", "#authors", () => authorRow());
  add("#add-sec", "#persec", () => secRow());
  add("#add-stage", "#stages", () => stageRow());
  root.addEventListener("click", (e) => { if (e.target.matches("[data-remove]")) e.target.closest(".repeat-row").remove(); });
}

function readBriefForm(root, base = {}) {
  const v = (id) => $(id, root).value.trim();
  const num = (id) => (v(id) === "" ? null : Number(v(id)));
  const list = (id) => v(id).split("\n").map((s) => s.trim()).filter(Boolean);
  const b = structuredClone(base || {});
  b.paper = { ...(b.paper || {}), title: v("#f-title"), running_head: v("#f-rh"), target_journal: v("#f-journal"), article_type: v("#f-type") };
  b.language = { ...(b.language || {}), variant: v("#f-lang"), citation_style: v("#f-style") || "apa" };
  const per = {};
  $$(".sec", root).forEach((r) => { const [s, n] = $$("input", r); if (s.value.trim() && n.value) per[s.value.trim()] = Number(n.value); });
  b.word_limits = { ...(b.word_limits || {}), total: num("#w-total"), abstract: num("#w-abs"), per_section: per,
    counts_toward_total: Object.fromEntries(["abstract", "tables", "figure_captions", "references"].map((k) => [k, $(`#ct-${k}`, root).checked])) };
  b.authors = $$(".author", root).map((r) => { const [n, a] = $$("input", r);
    return { name: n.value.trim(), affiliations: a.value.split(";").map((s) => s.trim()).filter(Boolean) }; }).filter((a) => a.name);
  b.author_note = Object.fromEntries(["orcid", "funding", "conflicts", "data_availability", "preregistration", "ethics", "correspondence"]
    .map((k) => [k, v(`#n-${k}`)]));
  b.design = v("#f-design");
  b.constraints = { ...(b.constraints || {}), protected_terms: list("#c-terms"), framing: list("#c-frame") };
  const models = { default: { model: v("#o-model"), effort: v("#o-effort") } };
  $$(".stage", root).forEach((r) => { const [a, m, e] = $$("select", r); models[a.value] = { model: m.value, effort: e.value }; });
  b.options = { ...(b.options || {}), allow_preprints: $("#o-pre", root).checked, max_added_refs: num("#o-max") ?? 15,
    pause_after_plan: $("#o-pause", root).checked, pause_for_pdfs: $("#o-pdfs", root).checked,
    audit_rounds: Number(v("#o-rounds")), models };
  return b;
}

function briefYaml(b, header) {
  return `${header}\n` + jsyaml.dump(b, { lineWidth: 100, noRefs: true, sortKeys: false });
}

async function tabBrief(el, { slug, P, b }) {
  el.innerHTML = `<form id="bf" class="stack">${briefFormHtml(b)}
    <div class="row"><button class="btn primary" type="submit">Save brief</button><span id="bstatus" class="small muted"></span></div>
    <div class="progress" hidden id="bbar"><div></div></div></form>`;
  const f = $("#bf");
  wireBriefForm(f);
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const nb = readBriefForm(f, b);
    if (!nb.paper.title || !nb.paper.target_journal) { toast("Title and target journal are required", true); return; }
    await withProgress($("button[type=submit]", f), $("#bstatus"), $("#bbar"), (step) =>
      commit([{ path: `${P}/input/brief.yaml`, b64: b64FromText(briefYaml(nb, `# Brief for ${slug} (edited in the paperwriter web app)`)) }],
        `paperwriter web: update papers/${slug}/input/brief.yaml`, step));
    toast("Brief saved. Rerun from the stage it affects (intake: --from 0).");
  };
}

// ------------------------------------------------------------------ view: new paper

async function viewNew() {
  await loadTree();
  const tmpl = { language: { variant: "en-US", citation_style: "apa" }, word_limits: { total: null, abstract: 250 },
    design: "cross-sectional", options: { allow_preprints: false, max_added_refs: 15, pause_after_plan: false, audit_rounds: 1,
      models: { default: { model: "fable", effort: "max" } } } };
  app().innerHTML = `
    <div class="page-head"><h1>New paper</h1><p class="muted">Fill in the brief and add your materials. Everything is committed to
      <code>papers/&lt;folder&gt;/input/</code> on <code>${esc(S.cfg.branch)}</code> in one commit; then you start the run in Claude Code.</p></div>
    <form id="nf" class="stack" novalidate>
      <fieldset><legend>Folder</legend><div class="form-grid">
        <div class="field"><label for="slug" class="req">Folder name</label><input id="slug" type="text" placeholder="e.g. crisis-control-2026" pattern="[a-z0-9][a-z0-9-]*" required>
          <span class="hint">Lowercase letters, digits and hyphens. Becomes <code>papers/&lt;name&gt;</code>.</span></div></div></fieldset>
      ${briefFormHtml(tmpl)}
      <fieldset><legend>Materials</legend><div class="form-grid">
        <div class="field"><label for="u-outline" class="req">Outline</label><input id="u-outline" type="file" accept=".md,.docx,.txt">
          <span class="hint">.md or .docx: sections, key points, hypotheses, and any prose you wrote (kept verbatim).</span></div>
        <div class="field"><label for="u-refs" class="req">Reference list</label><input id="u-refs" type="file" accept=".bib,.ris,.docx,.md,.txt">
          <span class="hint">.bib, .ris, .docx or .md.</span></div>
        <div class="field"><label for="u-results" class="req">Results</label><input id="u-results" type="file" multiple>
          <span class="hint">Knitted HTML or PDF, tables (.csv, .xlsx), model output (.txt), figures (.png, .pdf). Not an unknitted .Rmd alone.</span></div>
        <div class="field"><label for="u-pdfs">PDFs of key references</label><input id="u-pdfs" type="file" accept=".pdf" multiple>
          <span class="hint">Optional but strongly recommended: claims can only be checked against texts the pipeline can read.</span></div>
      </div></fieldset>
      <div class="callout warn small">Your files go only to your private repository on GitHub. Running the pipeline sends search queries and
        identifiers (DOIs, titles) to scholarly databases, never your manuscript text.</div>
      <div class="row"><button class="btn primary" type="submit">Create paper</button><span id="nstatus" class="small muted"></span></div>
      <div class="progress" hidden id="nbar"><div></div></div>
    </form>`;
  const f = $("#nf");
  wireBriefForm(f);
  f.onsubmit = async (ev) => {
    ev.preventDefault();
    const slug = $("#slug").value.trim();
    const problems = [];
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) problems.push("a folder name (lowercase letters, digits, hyphens)");
    else if (slugs().includes(slug)) problems.push(`a folder name not already used (“${slug}” exists)`);
    const b = readBriefForm(f, tmpl);
    if (!b.paper.title) problems.push("a working title");
    if (!b.paper.target_journal) problems.push("a target journal");
    const outline = $("#u-outline").files[0], refsFile = $("#u-refs").files[0];
    const results = [...$("#u-results").files], pdfs = [...$("#u-pdfs").files];
    if (!outline) problems.push("the outline");
    if (!refsFile) problems.push("the reference list");
    if (!results.length) problems.push("at least one results file");
    if (problems.length) { toast(`Please add ${problems.join(", ")}.`, true); return; }
    const P = `papers/${slug}/input`;
    const ext = (name) => name.slice(name.lastIndexOf(".")).toLowerCase();
    await withProgress($("button[type=submit]", f), $("#nstatus"), $("#nbar"), async (step) => {
      const files = [
        { path: `${P}/brief.yaml`, b64: b64FromText(briefYaml(b, `# Brief for ${slug} (created in the paperwriter web app; fields as in templates/brief.yaml)`)) },
        { path: `${P}/outline${ext(outline.name) === ".txt" ? ".md" : ext(outline.name)}`, b64: await b64FromFile(outline) },
        { path: `${P}/references${ext(refsFile.name) === ".txt" ? ".md" : ext(refsFile.name)}`, b64: await b64FromFile(refsFile) },
      ];
      for (const r of results) files.push({ path: `${P}/results/${r.name}`, b64: await b64FromFile(r) });
      for (const p of pdfs) files.push({ path: `${P}/pdfs/${p.name}`, b64: await b64FromFile(p) });
      await commit(files, `paperwriter web: add papers/${slug} inputs`, step);
    });
    toast("Paper created");
    S.treeAt = 0;
    location.hash = `#/paper/${encodeURIComponent(slug)}`;
  };
}

// ------------------------------------------------------------------ view: help

function viewHelp() {
  app().innerHTML = `<div class="page-head"><h1>How it works</h1></div>
  <div class="grid">
    <div class="card stack"><h2>1. Add a paper</h2><p><a href="#/new">New paper</a>: fill in the brief and upload the outline, results,
      reference list and PDFs. They are committed to your private repository.</p></div>
    <div class="card stack"><h2>2. Run the pipeline</h2><p>In a Claude Code session on the repository (claude.ai/code, <code>claude --cloud</code>
      or local), type the command shown on the paper's page, e.g. <code>/draft-paper papers/&lt;name&gt;</code>. Each stage is committed, so this
      page shows progress after <b>Refresh</b>. If some sources cannot be obtained as PDFs, the run pauses after the reference
      check and after the literature search, and a window here lists them, with one upload button each.</p></div>
    <div class="card stack"><h2>3. Review</h2><p>Read the manuscript with its open items highlighted, the report, the audits with
      word-level diffs, and the notes on every source. Download the Word file: open items are Word comments.</p></div>
  </div>
  <div class="card" style="margin-top:16px"><h2>Stages</h2><ol>
    <li><b>Intake</b>: inventory, brief check, results ledger, outline against results.</li>
    <li><b>Sources</b>: references resolved and checked for retractions; one note per source; gaps.</li>
    <li><b>Search</b>: allowlisted journals only, for the gaps; at most the number of added references you set.</li>
    <li><b>Plan</b>: paragraph-level argument plan.</li>
    <li><b>Draft</b>: section by section; numbers only from your results; every citation logged.</li>
    <li><b>Audits</b>: claims and numbers, argument, flow, language, integrity.</li>
    <li><b>Build</b>: APA Word manuscript, verified references, report.</li></ol></div>
  <div class="card" style="margin-top:16px"><h2>Privacy</h2><p>This website is static and public; it contains no papers. Everything you see is
    loaded from your private repository with your token, in your browser. The token is kept for this tab only unless you choose
    “Remember”. Use a fine-grained token limited to this one repository with <i>Contents: Read and write</i>, and give it an expiry.</p></div>`;
}

window.addEventListener("hashchange", route);
route();
