// ---------- element refs ----------
const landingViewEl = document.getElementById("landing-view");
const orgViewEl = document.getElementById("org-view");
const workspaceViewEl = document.getElementById("workspace-view");
const btnBackEl = document.getElementById("btn-back");
const workspaceProjectNameEl = document.getElementById("workspace-project-name");
const workspacePillsEl = document.getElementById("workspace-pills");

const orgsGridEl = document.getElementById("orgs-grid");
const noOrgsMsgEl = document.getElementById("no-orgs-msg");
const btnAddOrgEl = document.getElementById("btn-add-org");
const orgViewNameEl = document.getElementById("org-view-name");

const projectsGridEl = document.getElementById("projects-grid");
const noProjectsMsgEl = document.getElementById("no-projects-msg");
const btnHowToUseEl = document.getElementById("btn-how-to-use");
const btnAddProjectEl = document.getElementById("btn-add-project");

const modalOverlayEl = document.getElementById("modal-overlay");
const howToUseModalEl = document.getElementById("how-to-use-modal");
const addProjectModalEl = document.getElementById("add-project-modal");
const addOrgModalEl = document.getElementById("add-org-modal");
const orgNameInputEl = document.getElementById("org-name-input");
const addOrgErrorEl = document.getElementById("add-org-error");
const btnCreateOrgEl = document.getElementById("btn-create-org");

const projectNameInputEl = document.getElementById("project-name-input");
const tabExistingFolderEl = document.getElementById("tab-existing-folder");
const tabNewFolderEl = document.getElementById("tab-new-folder");
const projectRootLabelEl = document.getElementById("project-root-label");
const projectRootInputEl = document.getElementById("project-root-input");
const btnBrowseEl = document.getElementById("btn-browse");
const btnScanEl = document.getElementById("btn-scan");
const btnInitializeFolderEl = document.getElementById("btn-initialize-folder");
const newFolderHintEl = document.getElementById("new-folder-hint");
const deploymentSelectBoxEl = document.getElementById("deployment-select-box");
const deploymentSelectEl = document.getElementById("deployment-select");
const environmentSelectEl = document.getElementById("environment-select");
const addProjectErrorEl = document.getElementById("add-project-error");
const btnCreateProjectEl = document.getElementById("btn-create-project");

const btnInitEl = document.getElementById("btn-init");
const btnFmtEl = document.getElementById("btn-fmt");
const btnValidateEl = document.getElementById("btn-validate");
const btnPlanEl = document.getElementById("btn-plan");
const btnPlanDestroyEl = document.getElementById("btn-plan-destroy");
const planNameInputEl = document.getElementById("plan-name-input");
const runsListEl = document.getElementById("runs-list");
const logEl = document.getElementById("log");
const runTitleEl = document.getElementById("run-title");
const runStatusEl = document.getElementById("run-status");
const planSummaryEl = document.getElementById("plan-summary");
const summaryTextEl = document.getElementById("summary-text");
const confirmBoxEl = document.getElementById("confirm-box");
const confirmTokenEl = document.getElementById("confirm-token");
const confirmExpiryEl = document.getElementById("confirm-expiry");
const confirmInputEl = document.getElementById("confirm-input");

let currentOrg = null; // {id, name}
let currentProject = null; // {id, org_id, name, deployment, environment, cloud_provider, initialized}
let currentRunId = null;
let currentEventSource = null;
let expiryTimer = null;
let discoveredDeployments = [];
let runsPollTimer = null;
let addProjectMode = "existing"; // "existing" | "new" -- which folder-source tab is active in Add Work Project

// ---------- theme (light / dark) ----------

// Applied to <html> as data-theme so CSS variable blocks in style.css do all
// the work. Read from localStorage first, else follow the OS preference.
const btnThemeEl = document.getElementById("btn-theme");
const THEME_KEY = "iac-dashboard-theme";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  btnThemeEl.querySelector(".theme-icon").textContent = theme === "dark" ? "☀" : "☾";
  btnThemeEl.dataset.tip = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}

btnThemeEl.onclick = () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
};

initTheme();

// ---------- tooltips ----------

// Themed replacement for the native `title` tooltip: any element with
// data-tip gets one. Text is inserted with textContent (never innerHTML) so
// project names and filesystem paths can't inject markup. Lines indented by
// two spaces in the source string are treated as paths/commands and rendered
// as inline code chips; blank lines become spacers.
const tooltipEl = document.getElementById("tooltip");
let tooltipTarget = null;
let tooltipShowTimer = null;

function buildTooltip(text, isError) {
  tooltipEl.className = isError ? "tip-error" : "";
  tooltipEl.replaceChildren();
  for (const raw of text.split("\n")) {
    if (!raw.trim()) {
      const spacer = document.createElement("div");
      spacer.className = "tip-spacer";
      tooltipEl.appendChild(spacer);
      continue;
    }
    const isIndented = /^\s{2,}/.test(raw);
    const wrapper = document.createElement("div");
    wrapper.className = "tip-line";
    if (isIndented) {
      const code = document.createElement("span");
      code.className = "tip-mono";
      code.textContent = raw.trim();
      wrapper.appendChild(code);
    } else {
      wrapper.textContent = raw.trim();
    }
    tooltipEl.appendChild(wrapper);
  }
}

function positionTooltip(target) {
  const r = target.getBoundingClientRect();
  const t = tooltipEl.getBoundingClientRect();
  const margin = 10;

  // prefer below the element, flip above when there isn't room
  let top = r.bottom + 8;
  if (top + t.height > window.innerHeight - margin) {
    top = Math.max(margin, r.top - t.height - 8);
  }
  // centre horizontally, then clamp inside the viewport
  let left = r.left + r.width / 2 - t.width / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - t.width - margin));

  tooltipEl.style.top = `${Math.round(top)}px`;
  tooltipEl.style.left = `${Math.round(left)}px`;
}

function hideTooltip() {
  clearTimeout(tooltipShowTimer);
  tooltipTarget = null;
  tooltipEl.classList.remove("tip-visible");
  tooltipEl.classList.add("hidden");
}

document.addEventListener("mouseover", (ev) => {
  const target = ev.target.closest("[data-tip]");
  if (!target || target === tooltipTarget) return;
  tooltipTarget = target;
  clearTimeout(tooltipShowTimer);
  tooltipShowTimer = setTimeout(() => {
    if (tooltipTarget !== target || !target.isConnected) return;
    buildTooltip(target.dataset.tip, target.dataset.tipError === "true");
    tooltipEl.classList.remove("hidden");
    positionTooltip(target); // after unhiding, so height is measurable
    tooltipEl.classList.add("tip-visible");
  }, 180);
});

document.addEventListener("mouseout", (ev) => {
  if (tooltipTarget && !tooltipTarget.contains(ev.relatedTarget)) hideTooltip();
});
document.addEventListener("mousedown", hideTooltip);
window.addEventListener("scroll", hideTooltip, true);

// ---------- auto-hiding scrollbars ----------

// Scrollbar thumbs are transparent at rest in style.css; marking the element
// .scrolling reveals it, and we clear that 2s after the last scroll event.
// Registered in the capture phase because `scroll` doesn't bubble -- without
// capture only the document's own scrolling would ever be seen, not any of
// the inner scrollable panels (runs list, log, diff table, modals).
const SCROLL_IDLE_MS = 2000;
const scrollIdleTimers = new WeakMap();

document.addEventListener(
  "scroll",
  (ev) => {
    const el = ev.target instanceof Element ? ev.target : document.documentElement;
    el.classList.add("scrolling");
    clearTimeout(scrollIdleTimers.get(el));
    scrollIdleTimers.set(
      el,
      setTimeout(() => el.classList.remove("scrolling"), SCROLL_IDLE_MS)
    );
  },
  { capture: true, passive: true }
);

// ---------- view transitions ----------

// Reveal one of the three top-level views with an entrance animation.
// Removing the class and forcing a reflow before re-adding it is what makes
// the animation replay on every navigation -- without the reflow the browser
// coalesces remove+add into no change at all and nothing animates.
function revealView(el, { back = false } = {}) {
  const cls = back ? "view-enter-back" : "view-enter";
  for (const view of [landingViewEl, orgViewEl, workspaceViewEl]) {
    if (view !== el) view.classList.add("hidden");
    view.classList.remove("view-enter", "view-enter-back");
  }
  el.classList.remove("hidden");
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add(cls);

  // Drop the class once it's played out. The keyframes end on the element's
  // natural state so removing it changes nothing visually, but it stops the
  // descendant rules (cards, panels) from re-firing if the view's contents
  // get re-rendered later while it's still on screen.
  el.addEventListener(
    "animationend",
    (ev) => {
      if (ev.target === el) el.classList.remove(cls);
    },
    { once: true }
  );
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function fmtTime(ts) {
  if (!ts) return "";
  return new Date(ts * 1000).toLocaleTimeString();
}

// ---------- status rendering (tick / cross instead of a status word) ----------

// success -> check, failed -> cross, queued/running -> pulsing dot. The glyph
// lives in its own span so CSS can give it the coloured circular chip; the
// label sits next to it and is hidden by CSS in the compact list badges.
const STATUS_GLYPHS = { success: "✓", failed: "✗", running: "●", queued: "●" };

function statusHtml(status) {
  const glyph = STATUS_GLYPHS[status] || "●";
  return `<span class="status-icon">${glyph}</span><span class="status-label">${escapeHtml(status)}</span>`;
}

function setRunStatus(status) {
  runStatusEl.className = `status ${status}`;
  runStatusEl.innerHTML = statusHtml(status);
  // Cancel is only meaningful while something is actually in flight
  btnCancelRunEl.classList.toggle("hidden", !["queued", "running"].includes(status));
}

const btnCancelRunEl = document.getElementById("btn-cancel-run");

async function cancelCurrentRun() {
  const detail = await api(`/api/runs/${currentRunId}`);
  const isApply = detail.kind === "apply";
  const ok = await confirmDialog(
    isApply
      ? "Stop this APPLY?\n\nTerraform may have already created some resources, so your infrastructure can be left half-changed, and killing it can leave the state file locked (you'd need `terraform force-unlock`). Only do this if it's genuinely stuck."
      : `Stop this ${detail.kind}? It doesn't change any infrastructure, so this is safe.`,
    { title: isApply ? "Cancel a running apply?" : "Cancel this run?", okLabel: "Stop it", danger: isApply }
  );
  if (!ok) return;
  try {
    await api(`/api/runs/${currentRunId}/cancel`, { method: "POST" });
    toast("Run cancelled.", { type: "success" });
    await refreshRunsList();
  } catch (e) {
    toast(`Could not cancel: ${e.message}`, { type: "error" });
  }
}
btnCancelRunEl.onclick = cancelCurrentRun;

// ---------- modals ----------

function openModal(modalEl) {
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
  modalEl.classList.remove("hidden");
  modalOverlayEl.classList.remove("hidden");
}

function closeModals() {
  modalOverlayEl.classList.add("hidden");
  if (pendingConfirmResolve) {
    pendingConfirmResolve(false);
    pendingConfirmResolve = null;
  }
}

modalOverlayEl.addEventListener("click", (ev) => {
  if (ev.target === modalOverlayEl) closeModals();
});
document.querySelectorAll(".modal-close").forEach((btn) => btn.addEventListener("click", closeModals));

btnHowToUseEl.onclick = () => openModal(howToUseModalEl);

// ---------- confirm dialog (replaces native confirm()) ----------

const confirmDialogModalEl = document.getElementById("confirm-dialog-modal");
const confirmDialogTitleEl = document.getElementById("confirm-dialog-title");
const confirmDialogMessageEl = document.getElementById("confirm-dialog-message");
const confirmDialogOkEl = document.getElementById("confirm-dialog-ok");
const confirmDialogCancelEl = document.getElementById("confirm-dialog-cancel");

let pendingConfirmResolve = null;

function confirmDialog(message, { title = "Are you sure?", okLabel = "Confirm", danger = true } = {}) {
  confirmDialogTitleEl.textContent = title;
  confirmDialogMessageEl.textContent = message;
  confirmDialogOkEl.textContent = okLabel;
  confirmDialogOkEl.className = danger ? "btn danger" : "btn primary";
  openModal(confirmDialogModalEl);

  return new Promise((resolve) => {
    pendingConfirmResolve = resolve;
  });
}

confirmDialogOkEl.onclick = () => {
  const resolve = pendingConfirmResolve;
  pendingConfirmResolve = null;
  modalOverlayEl.classList.add("hidden");
  if (resolve) resolve(true);
};
confirmDialogCancelEl.onclick = () => closeModals();

// ---------- toasts (replaces native alert()) ----------

const toastContainerEl = document.getElementById("toast-container");

const TOAST_GLYPHS = { success: "✓", error: "✗", info: "i" };

function toast(message, { type = "info", duration = 4500 } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${TOAST_GLYPHS[type] || "i"}</span><span>${escapeHtml(message)}</span>`;
  toastContainerEl.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ---------- landing view (organizations) ----------

function showLanding({ pushHistory = true } = {}) {
  revealView(landingViewEl, { back: true });
  btnBackEl.classList.add("hidden");
  currentOrg = null;
  currentProject = null;
  currentRunId = null;
  if (currentEventSource) { currentEventSource.close(); currentEventSource = null; }
  if (runsPollTimer) { clearInterval(runsPollTimer); runsPollTimer = null; }
  document.title = "IaC-Dashboard";

  if (pushHistory && location.pathname + location.search !== "/") {
    history.pushState({}, "", "/");
  }
  refreshOrgs();
}

btnBackEl.onclick = () => {
  if (!workspaceViewEl.classList.contains("hidden") && currentOrg) {
    showOrgView(currentOrg);
  } else {
    showLanding();
  }
};

// ---------- org view (work projects inside one organization) ----------

async function showOrgView(org, { pushHistory = true } = {}) {
  currentOrg = org;
  currentProject = null;
  currentRunId = null;
  if (currentEventSource) { currentEventSource.close(); currentEventSource = null; }
  if (runsPollTimer) { clearInterval(runsPollTimer); runsPollTimer = null; }

  // Coming back up from a project workspace animates the other direction.
  // Has to be read BEFORE revealView, which hides the other views.
  const cameFromWorkspace = !workspaceViewEl.classList.contains("hidden");
  revealView(orgViewEl, { back: cameFromWorkspace });
  btnBackEl.classList.remove("hidden");
  btnBackEl.textContent = "← Organizations";
  orgViewNameEl.textContent = org.name;
  document.title = `${org.name} — IaC-Dashboard`;

  if (pushHistory) {
    const url = `/${encodeURIComponent(org.name)}`;
    if (location.pathname !== url) history.pushState({ orgId: org.id }, "", url);
  }
  await refreshProjects();
}

// ---------- URL routing (back/forward + refresh-safe deep links) ----------

window.addEventListener("popstate", () => restoreFromLocation({ pushHistory: false }));

async function restoreFromLocation({ pushHistory }) {
  const match = location.pathname.match(/^\/([^/]+)(?:\/([^/]+))?\/?$/);
  if (!match) {
    showLanding({ pushHistory });
    return;
  }
  const orgName = decodeURIComponent(match[1]);
  const projectName = match[2] ? decodeURIComponent(match[2]) : null;
  try {
    const orgs = await api("/api/organizations");
    const org = orgs.find((o) => o.name === orgName);
    if (!org) throw new Error(`no organization named "${orgName}"`);

    if (!projectName) {
      await showOrgView(org, { pushHistory });
      return;
    }
    const projects = await api(`/api/projects?org_id=${org.id}`);
    const project = projects.find((p) => p.name === projectName);
    if (!project) throw new Error(`no project named "${projectName}" in "${orgName}"`);
    currentOrg = org;
    await openWorkspace(project, { pushHistory });
  } catch (e) {
    toast(`That link is no longer valid: ${e.message}`, { type: "error" });
    showLanding({ pushHistory });
  }
}

function closeAllCardMenus() {
  document.querySelectorAll(".card-menu").forEach((m) => m.remove());
  document.querySelectorAll(".card-menu-btn").forEach((b) => b.classList.remove("menu-open"));
}
document.addEventListener("click", closeAllCardMenus);

function renderOrgCard(o) {
  const card = document.createElement("div");
  card.className = "project-card";
  card.innerHTML = `
    <div class="card-top-row">
      <div class="name">${o.name}</div>
      <button class="card-menu-btn" data-tip="Organization settings">&#8942;</button>
    </div>
    <div class="path">${o.project_count} work project${o.project_count === 1 ? "" : "s"}</div>
  `;

  const menuBtn = card.querySelector(".card-menu-btn");
  menuBtn.onclick = (ev) => {
    ev.stopPropagation();
    const alreadyOpen = menuBtn.classList.contains("menu-open");
    closeAllCardMenus();
    if (alreadyOpen) return;

    menuBtn.classList.add("menu-open");
    const menu = document.createElement("div");
    menu.className = "card-menu";
    menu.innerHTML = `<button data-action="delete" class="danger">Delete organization</button>`;
    menu.onclick = async (mev) => {
      mev.stopPropagation();
      if (mev.target.dataset.action !== "delete") return;
      closeAllCardMenus();
      const ok = await confirmDialog(
        `Delete "${o.name}" and all ${o.project_count} project(s) inside it from the dashboard?\n\nThis only removes local bookkeeping -- it does NOT run terraform destroy or touch any Azure resources.`,
        { title: "Delete organization?", okLabel: "Delete organization" }
      );
      if (!ok) return;
      await api(`/api/organizations/${o.id}`, { method: "DELETE" });
      toast(`"${o.name}" removed.`, { type: "success" });
      refreshOrgs();
    };
    card.appendChild(menu);
  };

  card.onclick = () => showOrgView(o);
  return card;
}

async function refreshOrgs() {
  const orgs = await api("/api/organizations");
  orgsGridEl.innerHTML = "";
  noOrgsMsgEl.classList.toggle("hidden", orgs.length > 0);
  for (const o of orgs) orgsGridEl.appendChild(renderOrgCard(o));
}

function renderProjectCard(p) {
  const card = document.createElement("div");
  card.className = "project-card";
  card.innerHTML = `
    <div class="card-top-row">
      <div class="name">${p.name}</div>
      <button class="card-menu-btn" data-tip="Project settings">&#8942;</button>
    </div>
    <div class="pills">
      <span class="pill" data-tip="${escapeHtml(
        `Deployment: ${p.deployment}\nThe folder terraform runs in.`
      )}">${escapeHtml(p.deployment)}</span>
      <span class="pill" data-tip="${escapeHtml(
        p.tfvars_relative
          ? `Environment: ${p.environment}\nUses these two files:\n  ${p.tfvars_relative}\n  ${p.backend_relative}`
          : `Environment: ${p.environment}`
      )}">${escapeHtml(p.environment)}</span>
      <span class="pill" data-tip="Cloud provider&#10;Azure is the only supported provider right now.">${escapeHtml(
        p.cloud_provider || "azure"
      )}</span>
    </div>
    <div class="path">${p.project_root}</div>
    <div class="init-status ${p.initialized ? "ok" : "pending"}">
      ${p.initialized ? "initialized" : "not initialized yet this session"}
    </div>
  `;

  const menuBtn = card.querySelector(".card-menu-btn");
  menuBtn.onclick = (ev) => {
    ev.stopPropagation();
    const alreadyOpen = menuBtn.classList.contains("menu-open");
    closeAllCardMenus();
    if (alreadyOpen) return;

    menuBtn.classList.add("menu-open");
    const menu = document.createElement("div");
    menu.className = "card-menu";
    menu.innerHTML = `
      <button data-action="edit">Edit</button>
      <button data-action="clear-runs">Delete all runs</button>
      <button data-action="delete" class="danger">Delete project</button>
    `;
    menu.onclick = async (mev) => {
      mev.stopPropagation();
      const action = mev.target.dataset.action;
      if (!action) return;
      closeAllCardMenus();

      if (action === "edit") {
        openEditProjectModal(p);
      } else if (action === "clear-runs") {
        const ok = await confirmDialog(
          `Delete all run history (init/plan/apply) for "${p.name}"? This can't be undone.`,
          { title: "Delete all runs?", okLabel: "Delete runs" }
        );
        if (!ok) return;
        try {
          await api(`/api/projects/${p.id}/runs`, { method: "DELETE" });
          toast("Run history cleared.", { type: "success" });
        } catch (e) {
          toast(`Could not clear runs: ${e.message}`, { type: "error" });
        }
      } else if (action === "delete") {
        const ok = await confirmDialog(
          `Delete "${p.name}" from the dashboard?\n\nThis only removes it from this list -- it does NOT run terraform destroy or touch any Azure resources.`,
          { title: "Delete project?", okLabel: "Delete project" }
        );
        if (!ok) return;
        await api(`/api/projects/${p.id}`, { method: "DELETE" });
        toast(`"${p.name}" removed.`, { type: "success" });
        refreshProjects();
      }
    };
    card.appendChild(menu);
  };

  card.onclick = () => openWorkspace(p);
  return card;
}

async function refreshProjects() {
  if (!currentOrg) return;
  const projects = await api(`/api/projects?org_id=${currentOrg.id}`);
  projectsGridEl.innerHTML = "";
  noProjectsMsgEl.classList.toggle("hidden", projects.length > 0);
  for (const p of projects) projectsGridEl.appendChild(renderProjectCard(p));
}

// ---------- add organization modal ----------

btnAddOrgEl.onclick = () => {
  orgNameInputEl.value = "";
  addOrgErrorEl.classList.add("hidden");
  openModal(addOrgModalEl);
};

btnCreateOrgEl.onclick = async () => {
  addOrgErrorEl.classList.add("hidden");
  const name = orgNameInputEl.value.trim();
  if (!name) {
    addOrgErrorEl.textContent = "Give this organization a name.";
    addOrgErrorEl.classList.remove("hidden");
    return;
  }
  try {
    const org = await api("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    closeModals();
    await showOrgView(org);
  } catch (e) {
    addOrgErrorEl.textContent = e.message;
    addOrgErrorEl.classList.remove("hidden");
  }
};

// ---------- add / edit project modal ----------

const addProjectModalTitleEl = document.getElementById("add-project-modal-title");
let editingProjectId = null; // null = "add" mode, otherwise the project.id being edited

function setFolderMode(mode) {
  addProjectMode = mode;
  tabExistingFolderEl.classList.toggle("active", mode === "existing");
  tabNewFolderEl.classList.toggle("active", mode === "new");
  projectRootLabelEl.textContent = mode === "new" ? "Empty folder to initialize" : "Project folder";
  newFolderHintEl.classList.toggle("hidden", mode !== "new");
  btnScanEl.classList.toggle("hidden", mode !== "existing");
  btnInitializeFolderEl.classList.toggle("hidden", mode !== "new");
  deploymentSelectBoxEl.classList.add("hidden");
  addProjectErrorEl.classList.add("hidden");
  btnCreateProjectEl.disabled = true;
  discoveredDeployments = [];
}
tabExistingFolderEl.onclick = () => setFolderMode("existing");
tabNewFolderEl.onclick = () => setFolderMode("new");

btnAddProjectEl.onclick = () => {
  editingProjectId = null;
  addProjectModalTitleEl.textContent = "Add Work Project";
  btnCreateProjectEl.textContent = "Create Project";
  projectNameInputEl.value = "";
  projectNameInputEl.disabled = false;
  projectNameInputEl.title = "";
  projectRootInputEl.value = "";
  tabExistingFolderEl.classList.remove("hidden");
  tabNewFolderEl.classList.remove("hidden");
  document.getElementById("folder-mode-tabs").classList.remove("hidden");
  setFolderMode("existing");
  openModal(addProjectModalEl);
};

async function openEditProjectModal(project) {
  editingProjectId = project.id;
  addProjectModalTitleEl.textContent = `Edit "${project.name}"`;
  btnCreateProjectEl.textContent = "Save Changes";
  projectNameInputEl.value = project.name;
  projectNameInputEl.disabled = true;
  projectNameInputEl.title = "Name can't be changed -- it's the stable key this project's URL is built on. Delete and re-add it to rename.";
  projectRootInputEl.value = project.project_root;
  // Editing only ever re-scans an existing folder -- "Initialize new folder" doesn't apply to a project that already exists.
  document.getElementById("folder-mode-tabs").classList.add("hidden");
  setFolderMode("existing");
  addProjectErrorEl.classList.add("hidden");
  btnCreateProjectEl.disabled = true;
  deploymentSelectBoxEl.classList.add("hidden");
  openModal(addProjectModalEl);

  // pre-scan so the deployment/environment selects are populated + preselected
  try {
    const result = await api("/api/project/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_root: project.project_root }),
    });
    discoveredDeployments = result.deployments;
    deploymentSelectEl.innerHTML = discoveredDeployments
      .map((d) => `<option value="${d.name}">${d.name}</option>`)
      .join("");
    deploymentSelectEl.value = project.deployment;
    updateEnvironmentOptions();
    environmentSelectEl.value = project.environment;
    deploymentSelectBoxEl.classList.remove("hidden");
    btnCreateProjectEl.disabled = false;
  } catch (e) {
    showAddProjectError(`Could not re-scan the saved folder: ${e.message}`);
  }
}

function showAddProjectError(message) {
  addProjectErrorEl.textContent = message;
  addProjectErrorEl.classList.remove("hidden");
}

btnBrowseEl.onclick = async () => {
  try {
    const { path } = await api("/api/browse-folder", { method: "POST" });
    if (path) projectRootInputEl.value = path;
  } catch (e) {
    showAddProjectError(e.message);
  }
};

btnScanEl.onclick = async () => {
  addProjectErrorEl.classList.add("hidden");
  const projectRoot = projectRootInputEl.value.trim();
  if (!projectRoot) { showAddProjectError("Enter or browse to a folder first."); return; }
  try {
    const result = await api("/api/project/discover", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_root: projectRoot }),
    });
    discoveredDeployments = result.deployments;
    deploymentSelectEl.innerHTML = discoveredDeployments
      .map((d) => `<option value="${d.name}">${d.name}</option>`)
      .join("");
    updateEnvironmentOptions();
    deploymentSelectBoxEl.classList.remove("hidden");
    btnCreateProjectEl.disabled = false;
  } catch (e) {
    deploymentSelectBoxEl.classList.add("hidden");
    btnCreateProjectEl.disabled = true;
    showAddProjectError(e.message);
  }
};

btnInitializeFolderEl.onclick = async () => {
  addProjectErrorEl.classList.add("hidden");
  const projectRoot = projectRootInputEl.value.trim();
  if (!projectRoot) { showAddProjectError("Enter or browse to an empty folder first."); return; }
  try {
    const result = await api("/api/project/initialize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ project_root: projectRoot }),
    });
    discoveredDeployments = result.deployments;
    deploymentSelectEl.innerHTML = discoveredDeployments
      .map((d) => `<option value="${d.name}">${d.name}</option>`)
      .join("");
    updateEnvironmentOptions();
    deploymentSelectBoxEl.classList.remove("hidden");
    btnCreateProjectEl.disabled = false;
    toast("Folder initialized -- remember to replace the REPLACE_ME placeholders in the generated backend/tfvars files with real values before running Init.", { type: "success", duration: 8000 });
  } catch (e) {
    deploymentSelectBoxEl.classList.add("hidden");
    btnCreateProjectEl.disabled = true;
    showAddProjectError(e.message);
  }
};

function updateEnvironmentOptions() {
  const dep = discoveredDeployments.find((d) => d.name === deploymentSelectEl.value);
  const envs = dep ? dep.environments : [];
  environmentSelectEl.innerHTML = envs.length
    ? envs.map((e) => `<option value="${e}">${e}</option>`).join("")
    : `<option value="" disabled>no valid environments found</option>`;
}
deploymentSelectEl.onchange = updateEnvironmentOptions;

btnCreateProjectEl.onclick = async () => {
  addProjectErrorEl.classList.add("hidden");
  const projectRoot = projectRootInputEl.value.trim();
  const deployment = deploymentSelectEl.value;
  const environment = environmentSelectEl.value;
  if (!deployment || !environment) { showAddProjectError("Pick a deployment and environment."); return; }
  try {
    if (editingProjectId) {
      await api(`/api/projects/${editingProjectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_root: projectRoot, deployment, environment }),
      });
      closeModals();
      refreshProjects();
    } else {
      const name = projectNameInputEl.value.trim();
      if (!name) { showAddProjectError("Give this project a name."); return; }
      const project = await api("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          org_id: currentOrg.id,
          name,
          project_root: projectRoot,
          deployment,
          environment,
        }),
      });
      closeModals();
      await openWorkspace(project);
      // kick off init automatically for a brand-new project
      runInit();
    }
  } catch (e) {
    showAddProjectError(e.message);
  }
};

// ---------- workspace view ----------

async function openWorkspace(project, { pushHistory = true } = {}) {
  currentProject = project;
  revealView(workspaceViewEl);
  btnBackEl.classList.remove("hidden");
  btnBackEl.textContent = "← Projects";
  renderTargetPills(project);
  logEl.textContent = "";
  runTitleEl.textContent = "No run selected";
  runStatusEl.innerHTML = "";
  runStatusEl.className = "status";
  btnCancelRunEl.classList.add("hidden");
  resetActionBar();

  if (pushHistory) {
    const url = `/${encodeURIComponent(currentOrg.name)}/${encodeURIComponent(project.name)}`;
    if (location.pathname !== url) history.pushState({ projectId: project.id }, "", url);
  }
  document.title = `${project.name} — IaC-Dashboard`;

  await refreshRunsList();
  runsPollTimer = setInterval(refreshRunsList, 5000);
}

function renderTargetPills(project) {
  workspaceProjectNameEl.textContent = project.name;

  // Filenames come from the server (see _decorate) rather than being rebuilt
  // here, so the hover text can't disagree with the files a run really uses.
  const deploymentTip =
    `Deployment: ${project.deployment}\n` +
    `Every terraform command runs with this folder as its working directory.\n` +
    `  ${project.project_root}\\${project.deployment}`;
  const envTip = project.tfvars_relative
    ? `Environment: ${project.environment}\n` +
      `Resolves to these two files inside ${project.deployment}:\n` +
      `  ${project.tfvars_relative}\n` +
      `passed to plan/apply as -var-file\n` +
      `  ${project.backend_relative}\n` +
      `passed to init as -backend-config`
    : `Environment: ${project.environment}`;

  workspacePillsEl.innerHTML = `
    <span class="pill" data-tip="${escapeHtml(deploymentTip)}">${escapeHtml(project.deployment)}</span>
    <span class="pill" data-tip="${escapeHtml(envTip)}">${escapeHtml(project.environment)}</span>
    <span class="pill checking" id="auth-pill">checking Azure&hellip;</span>`;
  btnPlanEl.disabled = !project.initialized;
  btnPlanDestroyEl.disabled = !project.initialized;
  btnValidateEl.disabled = !project.initialized;
  refreshAuthPill(project.id);
}

// The pill used to claim "real Azure changes" unconditionally, which was a
// guess -- it now reports the result of the same auth check that actually
// gates init/plan, so a bad/missing login is visible up front instead of
// surfacing only when a run fails. Runs a couple of `az` calls, hence the
// interim "checking" state.
async function refreshAuthPill(projectId) {
  let result;
  try {
    result = await api(`/api/projects/${projectId}/auth-check`);
  } catch (e) {
    result = { authenticated: false, reason: e.message, details: [e.message] };
  }
  // the workspace may have been left (or switched) while az was running
  const pill = document.getElementById("auth-pill");
  if (!pill || !currentProject || currentProject.id !== projectId) return;

  pill.className = result.authenticated ? "pill warn" : "pill error";
  pill.textContent = result.authenticated ? "Real Azure Change Activated" : "Not Authenticated";
  // details comes from the server so the hover explanation always matches the
  // real verdict (who you're signed in as, which subscription, how to fix it)
  const lines = result.details && result.details.length ? result.details : [result.reason || ""];
  pill.dataset.tip = lines.join("\n");
  pill.dataset.tipError = String(!result.authenticated);
}

async function refreshCurrentProjectInitState() {
  const fresh = await api(`/api/projects/${currentProject.id}`);
  const projects = await api("/api/projects");
  const withState = projects.find((p) => p.id === fresh.id);
  currentProject = { ...fresh, initialized: withState ? withState.initialized : false };
  renderTargetPills(currentProject);
}

function resetActionBar() {
  planSummaryEl.classList.add("hidden");
  confirmBoxEl.classList.add("hidden");
  confirmInputEl.value = "";
  if (expiryTimer) clearInterval(expiryTimer);
}

function renderRunsList(runs) {
  runsListEl.innerHTML = "";
  for (const r of runs) {
    const li = document.createElement("li");
    li.className = r.run_id === currentRunId ? "active" : "";
    li.innerHTML = `<span class="kind">${r.kind}</span>
      ${r.is_destroy ? '<span class="destroy-tag">DESTROY</span>' : ""}
      <span class="badge status ${r.status}" data-tip="${escapeHtml(r.status)}">${statusHtml(r.status)}</span><br/>
      ${r.name ? `<span class="run-name">${escapeHtml(r.name)}</span><br/>` : ""}
      <span class="muted">${fmtTime(r.created_at)}</span>`;
    li.onclick = () => selectRun(r.run_id);
    runsListEl.appendChild(li);
  }
}

let lastFetchedRuns = [];

async function refreshRunsList() {
  if (!currentProject) return;
  const runs = await api(`/api/runs?project_id=${currentProject.id}`);
  lastFetchedRuns = runs;
  renderRunsList(runs);
}

function isLatestPlan(runId) {
  const planRuns = lastFetchedRuns.filter((r) => r.kind === "plan");
  if (!planRuns.length) return true; // can't tell yet -- don't block
  const latest = planRuns.reduce((a, b) => (a.created_at > b.created_at ? a : b));
  return latest.run_id === runId;
}

function showPlanSummary(run) {
  resetActionBar();
  if (run.kind !== "plan" || run.status !== "success" || !run.summary) return;
  const s = run.summary;
  const banner = run.is_destroy
    ? '<div class="destroy-banner">⚠ DESTROY PLAN -- applying this tears resources down</div>'
    : "";
  summaryTextEl.innerHTML =
    banner +
    (s.no_changes
      ? "<b>No changes.</b> Infrastructure matches the config."
      : `<b>${s.add}</b> to add, <b>${s.change}</b> to change, <b>${s.destroy}</b> to destroy.`);
  planSummaryEl.classList.remove("hidden");

  const btnRequestApply = document.getElementById("btn-request-apply");
  if (isLatestPlan(run.run_id)) {
    btnRequestApply.classList.remove("hidden");
    btnRequestApply.onclick = () => requestApply(run.run_id);
  } else {
    btnRequestApply.classList.add("hidden");
    summaryTextEl.innerHTML +=
      '<div class="stale-plan-note">A newer plan exists for this project -- this one can no longer be applied. Open the latest plan, or re-run plan.</div>';
  }
}

async function requestApply(planRunId) {
  try {
    const result = await api("/api/apply/request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ plan_run_id: planRunId }),
    });
    confirmTokenEl.textContent = result.token;
    document.getElementById("confirm-warning-text").textContent =
      `${result.warning} (also required if driving this via Claude/MCP.)`;
    confirmBoxEl.classList.remove("hidden");

    let remaining = result.expires_in_seconds;
    confirmExpiryEl.textContent = `expires in ${remaining}s`;
    expiryTimer = setInterval(() => {
      remaining -= 1;
      confirmExpiryEl.textContent = remaining > 0 ? `expires in ${remaining}s` : "expired";
      if (remaining <= 0) clearInterval(expiryTimer);
    }, 1000);

    document.getElementById("btn-confirm-apply").onclick = () => confirmApply(result.token);
  } catch (e) {
    toast(`Could not request apply: ${e.message}`, { type: "error" });
  }
}

async function confirmApply(expectedToken) {
  const typed = confirmInputEl.value.trim().toUpperCase();
  if (typed !== expectedToken) {
    toast("Code doesn't match — copy it exactly from above.", { type: "error" });
    return;
  }
  try {
    const result = await api("/api/apply/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: expectedToken }),
    });
    resetActionBar();
    selectRun(result.run_id);
  } catch (e) {
    toast(`Apply failed to start: ${e.message}`, { type: "error" });
  }
}

const planViewToolbarEl = document.getElementById("plan-view-toolbar");
const planDiffContainerEl = document.getElementById("plan-diff-container");
const planDiffTableBodyEl = document.querySelector("#plan-diff-table tbody");
const planDiffCountsEl = document.getElementById("plan-diff-counts");
const btnToggleRawLogEl = document.getElementById("btn-toggle-raw-log");

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

function formatAttrValue(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function buildDetailRows(rc) {
  const unknown = new Set(rc.unknown_after_apply || []);
  const rows = [];
  if (rc.action === "create") {
    for (const [k, v] of Object.entries(rc.after || {})) {
      if (unknown.has(k)) rows.push([k, "(known after apply)"]);
      else if (v !== null) rows.push([k, formatAttrValue(v)]);
    }
  } else if (rc.action === "delete") {
    for (const [k, v] of Object.entries(rc.before || {})) {
      if (v !== null) rows.push([k, formatAttrValue(v)]);
    }
  } else {
    // update / replace -- only the fields that actually changed
    for (const k of rc.changed_fields) {
      const beforeVal = unknown.has(k) ? "(known after apply)" : formatAttrValue((rc.before || {})[k]);
      const afterVal = unknown.has(k) ? "(known after apply)" : formatAttrValue((rc.after || {})[k]);
      rows.push([k, `${beforeVal}  →  ${afterVal}`]);
    }
  }
  return rows;
}

async function showPlanDiff(run) {
  planViewToolbarEl.classList.add("hidden");
  planDiffContainerEl.classList.add("hidden");
  logEl.classList.remove("hidden");
  if (run.kind !== "plan" || run.status !== "success") return;

  try {
    const diff = await api(`/api/runs/${run.run_id}/plan-diff`);
    if (diff.total === 0) return; // "No changes" -- raw log already says so, nothing to tabulate

    document.getElementById("btn-download-json").href = `/api/runs/${run.run_id}/plan-diff/export?format=json`;
    document.getElementById("btn-download-csv").href = `/api/runs/${run.run_id}/plan-diff/export?format=csv`;

    const counts = {};
    for (const rc of diff.resource_changes) counts[rc.action] = (counts[rc.action] || 0) + 1;
    planDiffCountsEl.textContent = Object.entries(counts)
      .map(([action, n]) => `${n} to ${action}`)
      .join(", ");

    planDiffTableBodyEl.innerHTML = "";
    for (const rc of diff.resource_changes) {
      const tr = document.createElement("tr");
      tr.className = "diff-row";
      tr.innerHTML = `
        <td><span class="expand-caret">&#9656;</span> <span class="action-badge ${rc.action}">${rc.action}</span></td>
        <td class="resource-address">${escapeHtml(rc.address)}</td>
        <td class="changed-fields">${escapeHtml(rc.changed_fields.join(", "))}</td>
      `;

      const detailRows = buildDetailRows(rc);
      const detailTr = document.createElement("tr");
      detailTr.className = "diff-detail-row hidden";
      const detailTd = document.createElement("td");
      detailTd.colSpan = 3;
      detailTd.innerHTML = detailRows.length
        ? `<table class="attr-table">${detailRows
            .map(([k, v]) => `<tr><td class="attr-key">${escapeHtml(k)}</td><td class="attr-val">${escapeHtml(v)}</td></tr>`)
            .join("")}</table>`
        : `<span class="muted">No attribute details available.</span>`;
      detailTr.appendChild(detailTd);

      tr.onclick = () => {
        const expanded = !detailTr.classList.contains("hidden");
        detailTr.classList.toggle("hidden", expanded);
        tr.querySelector(".expand-caret").innerHTML = expanded ? "&#9656;" : "&#9662;";
      };

      planDiffTableBodyEl.appendChild(tr);
      planDiffTableBodyEl.appendChild(detailTr);
    }

    planViewToolbarEl.classList.remove("hidden");
    planDiffContainerEl.classList.remove("hidden");
    logEl.classList.add("hidden");
    btnToggleRawLogEl.textContent = "Show raw log";
  } catch (e) {
    // no .tfplan file (expired/restarted) or parse failure -- just keep showing the raw log
  }
}

btnToggleRawLogEl.onclick = () => {
  const tableCurrentlyShown = !planDiffContainerEl.classList.contains("hidden");
  planDiffContainerEl.classList.toggle("hidden", tableCurrentlyShown);
  logEl.classList.toggle("hidden", !tableCurrentlyShown);
  btnToggleRawLogEl.textContent = tableCurrentlyShown ? "Show table" : "Show raw log";
};

// ---------- compare plans ----------

const comparePickerModalEl = document.getElementById("compare-picker-modal");
const comparePickerListEl = document.getElementById("compare-picker-list");
const compareResultsModalEl = document.getElementById("compare-results-modal");
const compareResultsTitleEl = document.getElementById("compare-results-title");
const compareResultsSummaryEl = document.getElementById("compare-results-summary");
const compareResultsTableEl = document.getElementById("compare-results-table");

document.getElementById("btn-compare-plan").onclick = () => {
  const otherPlans = lastFetchedRuns.filter((r) => r.kind === "plan" && r.run_id !== currentRunId && r.status === "success");
  comparePickerListEl.innerHTML = "";
  if (!otherPlans.length) {
    comparePickerListEl.innerHTML = '<li class="muted" style="cursor:default">No other successful plans for this project yet.</li>';
  } else {
    for (const r of otherPlans) {
      const li = document.createElement("li");
      li.innerHTML = `<span class="run-name">${escapeHtml(r.name || "(unnamed)")}</span><span class="muted">${fmtTime(r.created_at)}</span>`;
      li.onclick = () => runCompare(r.run_id);
      comparePickerListEl.appendChild(li);
    }
  }
  openModal(comparePickerModalEl);
};

function statusLabel(status) {
  return {
    added_in_newer_plan: "added",
    removed_in_newer_plan: "removed",
    action_changed: "action changed",
    changed_fields_differ: "fields differ",
  }[status] || status;
}

function compareRowDetail(d) {
  if (d.status === "added_in_newer_plan") return `now: ${d.newer_action}`;
  if (d.status === "removed_in_newer_plan") return `was: ${d.older_action}`;
  if (d.status === "action_changed") return `${d.older_action} → ${d.newer_action}`;
  if (d.status === "changed_fields_differ") {
    return d.field_diffs
      .map((fd) => `${fd.field}: ${formatAttrValue(fd.older_value)} → ${formatAttrValue(fd.newer_value)}`)
      .join("\n");
  }
  return "";
}

async function runCompare(otherRunId) {
  try {
    const result = await api(`/api/runs/${currentRunId}/compare/${otherRunId}`);
    closeModals();

    compareResultsTitleEl.textContent = `"${result.older_run_name}" → "${result.newer_run_name}"`;
    if (result.total_differences === 0) {
      compareResultsSummaryEl.textContent = "No differences -- these two plans would do exactly the same thing.";
      compareResultsTableEl.classList.add("hidden");
    } else {
      compareResultsSummaryEl.textContent = `${result.total_differences} resource(s) differ:`;
      compareResultsTableEl.querySelector("tbody").innerHTML = result.differences
        .map(
          (d) => `<tr>
            <td><span class="status-badge ${d.status}">${statusLabel(d.status)}</span></td>
            <td class="resource-address">${escapeHtml(d.address)}</td>
            <td class="compare-detail">${escapeHtml(compareRowDetail(d))}</td>
          </tr>`
        )
        .join("");
      compareResultsTableEl.classList.remove("hidden");
    }
    openModal(compareResultsModalEl);
  } catch (e) {
    toast(`Could not compare plans: ${e.message}`, { type: "error" });
  }
}

async function selectRun(runId) {
  currentRunId = runId;
  resetActionBar();
  logEl.textContent = "";
  logEl.classList.remove("hidden");
  planViewToolbarEl.classList.add("hidden");
  planDiffContainerEl.classList.add("hidden");
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  const detail = await api(`/api/runs/${runId}`);
  runTitleEl.textContent = detail.name
    ? `${detail.kind.toUpperCase()} "${detail.name}"`
    : `${detail.kind.toUpperCase()} — ${runId.slice(0, 8)}`;
  setRunStatus(detail.status);
  logEl.textContent = detail.lines.join("\n");
  logEl.scrollTop = logEl.scrollHeight;

  refreshRunsList();

  if (detail.status === "success" || detail.status === "failed") {
    if (detail.kind === "plan") {
      showPlanSummary(detail);
      await showPlanDiff(detail);
    }
    if (detail.kind === "init") await refreshCurrentProjectInitState();
    return;
  }

  const es = new EventSource(`/api/runs/${runId}/stream`);
  currentEventSource = es;
  es.onmessage = (ev) => {
    logEl.textContent += (logEl.textContent ? "\n" : "") + ev.data;
    logEl.scrollTop = logEl.scrollHeight;
  };
  es.addEventListener("done", async () => {
    es.close();
    const finalDetail = await api(`/api/runs/${runId}`);
    setRunStatus(finalDetail.status);
    refreshRunsList();
    if (finalDetail.kind === "plan") {
      showPlanSummary(finalDetail);
      await showPlanDiff(finalDetail);
    }
    if (finalDetail.kind === "init") await refreshCurrentProjectInitState();
  });
}

async function runInit() {
  try {
    const { run_id } = await api(`/api/projects/${currentProject.id}/init`, { method: "POST" });
    await refreshRunsList();
    selectRun(run_id);
  } catch (e) {
    toast(`Could not start init: ${e.message}`, { type: "error" });
  }
}
btnInitEl.onclick = runInit;

// Formats in place, with no confirmation gate: `terraform fmt` only touches
// whitespace and alignment, never meaning, and re-running it is a no-op --
// so both a prompt and a separate read-only "check" mode were pure friction.
async function runFmt() {
  try {
    const { run_id } = await api(`/api/projects/${currentProject.id}/fmt`, { method: "POST" });
    await refreshRunsList();
    await selectRun(run_id);

    const detail = await api(`/api/runs/${run_id}`);
    const files = detail.lines.filter((l) => l.trim());
    toast(files.length ? `Reformatted ${files.length} file(s).` : "Everything was already formatted.", {
      type: "success",
    });
  } catch (e) {
    toast(`Could not format: ${e.message}`, { type: "error" });
  }
}
btnFmtEl.onclick = runFmt;

async function runValidate() {
  try {
    const { run_id } = await api(`/api/projects/${currentProject.id}/validate`, { method: "POST" });
    await refreshRunsList();
    selectRun(run_id);
  } catch (e) {
    toast(`Could not start validate: ${e.message}`, { type: "error" });
  }
}
btnValidateEl.onclick = runValidate;

async function runPlan(destroy) {
  const name = planNameInputEl.value.trim();
  if (!name) {
    planNameInputEl.focus();
    planNameInputEl.classList.add("input-error");
    setTimeout(() => planNameInputEl.classList.remove("input-error"), 1200);
    return;
  }
  if (destroy) {
    const ok = await confirmDialog(
      `This will plan destroying EVERYTHING "${currentProject.name}" manages (${currentProject.deployment}/${currentProject.environment}). ` +
        `Planning is safe by itself -- nothing is destroyed until you separately Request Apply and confirm it -- but make sure this is really what you want.`,
      { title: "Plan a destroy?", okLabel: "Plan Destroy" }
    );
    if (!ok) return;
  }
  try {
    const { run_id } = await api(`/api/projects/${currentProject.id}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, destroy }),
    });
    planNameInputEl.value = "";
    await refreshRunsList();
    selectRun(run_id);
  } catch (e) {
    toast(`Could not start plan: ${e.message}`, { type: "error" });
  }
}
btnPlanEl.onclick = () => runPlan(false);
btnPlanDestroyEl.onclick = () => runPlan(true);

restoreFromLocation({ pushHistory: false });
