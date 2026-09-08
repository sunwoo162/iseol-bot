const TOKEN_KEY = "iseol.web.token";
const state = {
  mode: "idea-lab",
  ideaLab: { prototypes: [], campaigns: [], productions: [] },
  selectedProjectId: "",
  project: null,
  loading: false,
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function setStatus(kind, message) {
  const banner = $("#status-banner");
  if (!message) {
    banner.hidden = true;
    banner.textContent = "";
    banner.dataset.kind = "";
    return;
  }
  banner.hidden = false;
  banner.dataset.kind = kind;
  banner.textContent = message;
}

function setLoading(loading, message = "Loading Iseol state…") {
  state.loading = loading;
  document.body.classList.toggle("is-loading", loading);
  if (loading) setStatus("loading", message);
}

function savedToken() {
  return localStorage.getItem(TOKEN_KEY)?.trim() ?? "";
}

function authHeaders() {
  const token = savedToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson(path, options = {}) {
  const response = await fetch(path, options);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  if (!response.ok) {
    const error = new Error(body?.error || `Request failed (${response.status})`);
    error.status = response.status;
    error.code = response.status === 401 ? "unauthorized" : "error";
    throw error;
  }
  return body;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function shortSha(value = "") {
  return value ? value.slice(0, 9) : "—";
}

function prototypeCard(prototype, index) {
  const card = element("article", "prototype-card");
  const top = element("div", "prototype-topline");
  top.append(element("span", "prototype-index", String(index + 1).padStart(2, "0")));
  top.append(element("span", `prototype-state state-${prototype.status}`, prototype.status));
  card.append(top);

  card.append(element("h3", "prototype-title", prototype.title));
  card.append(element("p", "prototype-concept", prototype.concept));

  const facts = element("dl", "prototype-facts");
  const factRows = [
    ["Branch", prototype.repository.branch],
    ["Commit", shortSha(prototype.repository.commitSha)],
    ["Deploy", prototype.deployment.provider || "live"],
  ];
  for (const [label, value] of factRows) {
    const row = element("div", "fact-row");
    row.append(element("dt", "", label), element("dd", "", value));
    facts.append(row);
  }
  card.append(facts);

  const actions = element("div", "prototype-actions");
  const deployment = element("a", "primary-link", "Open prototype ↗");
  deployment.href = prototype.deployment.url;
  deployment.target = "_blank";
  deployment.rel = "noopener noreferrer";
  actions.append(deployment);

  if (prototype.status === "candidate") {
    const promote = element("button", "secondary-button promote-button", "Promote to project");
    promote.type = "button";
    promote.addEventListener("click", () => promotePrototype(prototype.id));
    actions.append(promote);
    const archive = element("button", "ghost-button", "Archive");
    archive.type = "button";
    archive.addEventListener("click", () => archivePrototype(prototype.id));
    actions.append(archive);
  } else if (prototype.promotedProjectId) {
    const openProject = element("button", "secondary-button", "Open workspace");
    openProject.type = "button";
    openProject.addEventListener("click", () => {
      switchMode("project-workspace");
      selectProject(prototype.promotedProjectId);
    });
    actions.append(openProject);
  }
  card.append(actions);
  return card;
}

function campaignCard(campaign) {
  const card = element("article", "campaign-card");
  const head = element("div", "run-head");
  head.append(element("strong", "", "Campaign progress"));
  head.append(element("span", `prototype-state state-${campaign.status}`, campaign.status));
  card.append(head);
  card.append(element("p", "campaign-seed", campaign.seed));
  card.append(element("p", "muted", `${campaign.readyCount}/${campaign.targetReadyCount} ready · ${campaign.productionCount} productions · concurrency ${campaign.productionConcurrency}`));
  if (campaign.blockerSummary) card.append(element("p", "campaign-blocker", campaign.blockerSummary));
  if (!["complete", "cancelled"].includes(campaign.status)) {
    const cancel = element("button", "ghost-button", "Cancel");
    cancel.type = "button";
    cancel.addEventListener("click", () => cancelCampaign(campaign.id));
    card.append(cancel);
  }
  return card;
}

function productionCard(production) {
  const card = element("article", "production-card");
  const head = element("div", "run-head");
  head.append(element("strong", "mono", production.id));
  head.append(element("span", `prototype-state state-${production.status}`, production.status));
  card.append(head);
  card.append(element("p", "muted", `Run ${production.runId} · ${production.run?.stage ?? "pending"}`));
  card.append(element("p", "mono muted", `${production.branch} · ${shortSha(production.commitSha)}`));
  if (production.blockerSummary) card.append(element("p", "campaign-blocker", production.blockerSummary));
  if (production.deploymentUrl) {
    const open = element("a", "primary-link", "Open prototype ↗");
    open.href = production.deploymentUrl;
    open.target = "_blank";
    open.rel = "noopener noreferrer";
    card.append(open);
  }
  return card;
}

function renderIdeaLab() {
  const prototypes = state.ideaLab.prototypes ?? [];
  const campaigns = state.ideaLab.campaigns ?? [];
  const productions = state.ideaLab.productions ?? [];
  const campaignList = $("#campaign-list");
  const productionGrid = $("#production-grid");
  campaignList.replaceChildren(...campaigns.map(campaignCard));
  productionGrid.replaceChildren(...productions.map(productionCard));
  if (!campaigns.length) campaignList.append(element("p", "muted", "No active Campaigns."));
  if (!productions.length) productionGrid.append(element("p", "muted", "No production Runs yet."));
  const grid = $("#prototype-grid");
  grid.replaceChildren();
  $("#prototype-count").textContent = String(prototypes.length);
  $("#promoted-count").textContent = String(prototypes.filter((item) => item.status === "promoted").length);
  $("#candidate-count").textContent = String(prototypes.filter((item) => item.status === "candidate").length);
  if (!prototypes.length) {
    const empty = element("div", "empty-state empty-card");
    empty.append(element("strong", "", "Idea Lab is empty."));
    empty.append(element("span", "", "READY prototypes appear here after verified preview deployment."));
    grid.append(empty);
  } else {
    prototypes.forEach((prototype, index) => grid.append(prototypeCard(prototype, index)));
  }
}

function refreshProjectOptions() {
  const select = $("#project-select");
  const current = state.selectedProjectId;
  select.replaceChildren(new Option("Select a promoted project", ""));
  for (const prototype of state.ideaLab.prototypes ?? []) {
    if (!prototype.promotedProjectId) continue;
    select.append(new Option(prototype.title, prototype.promotedProjectId));
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

async function loadIdeaLab({ quiet = false } = {}) {
  if (!quiet) setLoading(true, "Loading Idea Lab…");
  try {
    state.ideaLab = await fetchJson("/api/idea-lab");
    renderIdeaLab();
    refreshProjectOptions();
    if (!quiet) setStatus("success", "Idea Lab synced with durable Iseol state.");
  } catch (error) {
    setStatus(error.code === "unauthorized" ? "unauthorized" : "error", error.message);
  } finally {
    setLoading(false);
  }
}

async function createCampaign(makeMore = false) {
  const latestSeed = state.ideaLab.campaigns?.at(-1)?.seed ?? "";
  const seed = $("#campaign-seed").value.trim() || (makeMore ? latestSeed : "");
  const targetReadyCount = Number($("#campaign-target").value || 3);
  if (!seed) { setStatus("error", "Enter a Campaign seed first."); return; }
  setLoading(true, makeMore ? "Creating another Idea Lab Campaign…" : "Creating Idea Lab Campaign…");
  try {
    await fetchJson("/api/idea-lab/campaigns", {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ seed, targetReadyCount, productionConcurrency: 1 }),
    });
    await loadIdeaLab({ quiet: true });
    setStatus("success", makeMore ? "New Campaign queued for more candidates." : "Campaign created.");
  } catch (error) { setStatus(error.code === "unauthorized" ? "unauthorized" : "error", error.message); }
  finally { setLoading(false); }
}

async function cancelCampaign(campaignId) {
  setLoading(true, "Cancelling Campaign…");
  try {
    await fetchJson(`/api/idea-lab/campaigns/${encodeURIComponent(campaignId)}/cancel`, {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    await loadIdeaLab({ quiet: true });
    setStatus("success", `Campaign cancelled: ${campaignId}`);
  } catch (error) { setStatus(error.code === "unauthorized" ? "unauthorized" : "error", error.message); }
  finally { setLoading(false); }
}

async function archivePrototype(prototypeId) {
  setLoading(true, "Archiving prototype…");
  try {
    await fetchJson(`/api/prototypes/${encodeURIComponent(prototypeId)}/archive`, {
      method: "POST", headers: { ...authHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({}),
    });
    await loadIdeaLab({ quiet: true });
    setStatus("success", `Archived ${prototypeId}.`);
  } catch (error) { setStatus(error.code === "unauthorized" ? "unauthorized" : "error", error.message); }
  finally { setLoading(false); }
}

async function promotePrototype(prototypeId) {
  setLoading(true, "Promoting prototype and importing Genesis…");
  try {
    const project = await fetchJson(`/api/prototypes/${encodeURIComponent(prototypeId)}/promote`, {
      method: "POST",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    await loadIdeaLab({ quiet: true });
    switchMode("project-workspace");
    await selectProject(project.id);
    setStatus("success", `Promoted ${prototypeId} to ${project.id}.`);
  } catch (error) {
    const kind = error.code === "unauthorized" ? "unauthorized" : "error";
    const message = error.status === 401
      ? "Unauthorized. Save the Iseol Web token and try again."
      : error.message;
    setStatus(kind, message);
  } finally {
    setLoading(false);
  }
}

function switchMode(mode) {
  state.mode = mode;
  $$(".mode-tab").forEach((button) => {
    const active = button.dataset.mode === mode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
  });
  $("#idea-lab-view").hidden = mode !== "idea-lab";
  $("#project-workspace-view").hidden = mode !== "project-workspace";
  if (mode === "project-workspace") refreshProjectOptions();
}

function clearProjectView() {
  state.project = null;
  $("#project-empty").hidden = false;
  $("#project-content").hidden = true;
}

function infoRow(label, value, mono = false) {
  const row = element("div", "info-row");
  row.append(element("span", "info-label", label));
  const content = element("strong", mono ? "mono" : "", value || "—");
  row.append(content);
  return row;
}

function renderGenesis(genesis) {
  const root = $("#genesis-content");
  root.replaceChildren();
  const grid = element("div", "genesis-grid");
  grid.append(infoRow("Prototype", genesis.prototypeId, true));
  grid.append(infoRow("Branch", genesis.repository.branch, true));
  grid.append(infoRow("Origin commit", genesis.repository.commitSha, true));
  grid.append(infoRow("Promoted", new Date(genesis.promotedAt).toLocaleString()));
  grid.append(infoRow("Genesis Runs", String(genesis.runs?.length ?? 0)));
  root.append(grid);

  const links = element("div", "inline-links");
  const repository = element("a", "text-link", "Repository ↗");
  repository.href = genesis.repository.url;
  repository.target = "_blank";
  repository.rel = "noopener noreferrer";
  const deployment = element("a", "text-link", "Genesis deployment ↗");
  deployment.href = genesis.deployment.url;
  deployment.target = "_blank";
  deployment.rel = "noopener noreferrer";
  links.append(repository, deployment);
  root.append(links);
}

function treeBranch(nodes, parentId) {
  const children = nodes.filter((node) => (node.parentId ?? null) === parentId);
  const list = element("ul", parentId === null ? "tree-root" : "tree-children");
  for (const node of children) {
    const item = element("li", "tree-node");
    const line = element("div", "tree-line");
    line.append(element("span", `tree-kind kind-${node.kind}`, node.kind));
    line.append(element("strong", "tree-title", node.title));
    line.append(element("span", `tree-status status-${node.status}`, node.status));
    if (node.runIds?.length) {
      line.append(element("span", "tree-run-count", `${node.runIds.length} run${node.runIds.length === 1 ? "" : "s"}`));
    }
    item.append(line);
    const nested = treeBranch(nodes, node.id);
    if (nested.childElementCount) item.append(nested);
    list.append(item);
  }
  return list;
}

function renderTree(nodes) {
  const root = $("#tree-content");
  root.replaceChildren();
  if (!nodes?.length) {
    root.append(element("p", "muted", "Project tree is empty."));
    return;
  }
  root.append(treeBranch(nodes, null));
}

function renderRuns(runs) {
  const root = $("#runs-content");
  root.replaceChildren();
  if (!runs?.length) {
    root.append(element("p", "muted", "No active attached Runs."));
    return;
  }
  const list = element("div", "run-list");
  for (const run of runs) {
    const card = element("article", "run-card");
    const head = element("div", "run-head");
    head.append(element("strong", "mono", run.runId));
    head.append(element("span", `run-status run-${run.status.toLowerCase()}`, run.status));
    card.append(head);
    card.append(element("p", "run-objective", run.objective));
    const meta = element("div", "run-meta");
    meta.append(element("span", "", `Stage ${run.stage}`));
    meta.append(element("span", "", `${run.evidenceCount} evidence`));
    if (run.policySha256) meta.append(element("span", "mono", `policy ${shortSha(run.policySha256)}`));
    card.append(meta);
    list.append(card);
  }
  root.append(list);
}

function renderHistory(history) {
  const root = $("#history-content");
  root.replaceChildren();
  if (!history?.length) {
    root.append(element("p", "muted", "No durable history yet."));
    return;
  }
  const timeline = element("ol", "history-list");
  for (const event of [...history].sort((a, b) => a.at.localeCompare(b.at))) {
    const item = element("li", "history-item");
    const dot = element("span", "history-dot");
    const body = element("div", "history-body");
    const top = element("div", "history-top");
    top.append(element("strong", "", event.summary));
    top.append(element("time", "", new Date(event.at).toLocaleString()));
    body.append(top);
    const refs = [event.type, event.nodeId, event.runId, event.prototypeId].filter(Boolean);
    if (refs.length) body.append(element("p", "mono muted", refs.join(" · ")));
    item.append(dot, body);
    timeline.append(item);
  }
  root.append(timeline);
}

function renderProject(view) {
  state.project = view;
  $("#project-empty").hidden = true;
  $("#project-content").hidden = false;
  $("#project-name").textContent = view.project.name;
  $("#project-status").textContent = view.project.status.toUpperCase();
  $("#project-meta").textContent = `${view.project.id} · updated ${new Date(view.project.updatedAt).toLocaleString()}`;
  const deployment = $("#project-deployment");
  deployment.href = view.genesis.deployment.url;
  renderGenesis(view.genesis);
  renderTree(view.tree);
  renderRuns(view.runs);
  renderHistory(view.history);
}

async function selectProject(projectId) {
  state.selectedProjectId = projectId || "";
  $("#project-select").value = state.selectedProjectId;
  if (!state.selectedProjectId) {
    clearProjectView();
    return;
  }
  setLoading(true, "Loading Project Workspace…");
  try {
    const view = await fetchJson(`/api/projects/${encodeURIComponent(state.selectedProjectId)}`);
    renderProject(view);
    setStatus("success", `Project Workspace loaded: ${view.project.name}`);
  } catch (error) {
    clearProjectView();
    setStatus(error.code === "unauthorized" ? "unauthorized" : "error", error.message);
  } finally {
    setLoading(false);
  }
}

function saveToken() {
  const value = $("#web-token").value.trim();
  if (value) localStorage.setItem(TOKEN_KEY, value);
  else localStorage.removeItem(TOKEN_KEY);
  setStatus("success", value ? "Web token saved locally in this browser." : "Web token cleared.");
}

function bindEvents() {
  $$(".mode-tab").forEach((button) =>
    button.addEventListener("click", () => switchMode(button.dataset.mode)),
  );
  $("#save-token").addEventListener("click", saveToken);
  $("#refresh-ideas").addEventListener("click", () => loadIdeaLab());
  $("#create-campaign").addEventListener("click", () => createCampaign(false));
  $("#make-more").addEventListener("click", () => createCampaign(true));
  $("#refresh-project").addEventListener("click", () => selectProject(state.selectedProjectId));
  $("#project-select").addEventListener("change", (event) => selectProject(event.target.value));
}

async function init() {
  $("#web-token").value = savedToken();
  bindEvents();
  switchMode("idea-lab");
  clearProjectView();
  await loadIdeaLab();
}

init().catch((error) => setStatus("error", error.message));
