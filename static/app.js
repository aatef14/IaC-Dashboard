// ---------- element refs ----------
const landingViewEl = document.getElementById("landing-view");
const orgViewEl = document.getElementById("org-view");
const workspaceViewEl = document.getElementById("workspace-view");
const toolsViewEl = document.getElementById("tools-view");
const editorViewEl = document.getElementById("editor-view");
const graphViewEl = document.getElementById("graph-view");
const btnBackEl = document.getElementById("btn-back");
const workspaceProjectNameEl = document.getElementById("workspace-project-name");
const workspacePillsEl = document.getElementById("workspace-pills");
const btnOpenVscodeEl = document.getElementById("btn-open-vscode");
const btnOpenEditorEl = document.getElementById("btn-open-editor");

const orgsGridEl = document.getElementById("orgs-grid");
const noOrgsMsgEl = document.getElementById("no-orgs-msg");
const btnAddOrgEl = document.getElementById("btn-add-org");
const orgViewNameEl = document.getElementById("org-view-name");

const projectsGridEl = document.getElementById("projects-grid");
const noProjectsMsgEl = document.getElementById("no-projects-msg");
const btnHowToUseEl = document.getElementById("btn-how-to-use");
const btnAddProjectEl = document.getElementById("btn-add-project");
const btnSyncCloudOrgEl = document.getElementById("btn-sync-cloud-org");

const modalOverlayEl = document.getElementById("modal-overlay");
const howToUseModalEl = document.getElementById("how-to-use-modal");
const addProjectModalEl = document.getElementById("add-project-modal");
const addOrgModalEl = document.getElementById("add-org-modal");
const orgNameInputEl = document.getElementById("org-name-input");
const addOrgErrorEl = document.getElementById("add-org-error");
const addOrgWarningEl = document.getElementById("add-org-warning");
const btnCreateOrgEl = document.getElementById("btn-create-org");
const tabOrgLocalEl = document.getElementById("tab-org-local");
const tabOrgCloudEl = document.getElementById("tab-org-cloud");
const orgModeHintEl = document.getElementById("org-mode-hint");
const orgRepoUrlBoxEl = document.getElementById("org-repo-url-box");
const orgRepoUrlInputEl = document.getElementById("org-repo-url-input");
const orgClonePathInputEl = document.getElementById("org-clone-path-input");
const btnBrowseClonePathEl = document.getElementById("btn-browse-clone-path");

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
const folderPickerSectionEl = document.getElementById("folder-picker-section");
const cloudProjectHintEl = document.getElementById("cloud-project-hint");
const deploymentSelectEl = document.getElementById("deployment-select");
const environmentSelectEl = document.getElementById("environment-select");
const addProjectErrorEl = document.getElementById("add-project-error");
const btnCreateProjectEl = document.getElementById("btn-create-project");
const retentionDaysInputEl = document.getElementById("retention-days-input");

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
const btnCopyConfirmTokenEl = document.getElementById("btn-copy-confirm-token");

// Copies to the clipboard only -- deliberately does NOT also fill
// confirm-input for you. Apply is never one click by design (see README's
// "Apply safety"); auto-filling the confirm box would silently turn
// "copy the code" into "confirm the apply", undoing that on purpose.
btnCopyConfirmTokenEl.onclick = async () => {
  try {
    await navigator.clipboard.writeText(confirmTokenEl.textContent);
    toast("Code copied.", { type: "success", duration: 2000 });
  } catch (e) {
    toast("Could not copy -- select and copy the code manually.", { type: "error" });
  }
};

let currentOrg = null; // {id, name}
let currentProject = null; // {id, org_id, name, deployment, environment, cloud_provider, initialized}
let currentRunId = null;
let currentEventSource = null;
let expiryTimer = null;
let discoveredDeployments = [];
// Declared here (not down in the file-editor section where it's actually
// used) because applyTheme() below reads it on every theme change,
// including the very first one at page load -- a `let` referenced before
// its own declaration line has executed throws (temporal dead zone), even
// under a `typeof` guard, so it has to exist before initTheme() ever runs.
let monacoEditorInstance = null;
let runsPollTimer = null;
let addProjectMode = "existing"; // "existing" | "new" -- which folder-source tab is active in Add Work Project

// ---------- theme (light / dark) ----------

// Applied to <html> as data-theme so CSS variable blocks in style.css do all
// the work. Read from localStorage first, else follow the OS preference.
// The toggle itself lives in the header dropdown menu (see "header menu"
// below) rather than its own persistent button, so there's no button
// element to keep in sync here -- its label is computed fresh each time the
// menu opens.
const THEME_KEY = "iac-dashboard-theme";

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // Keeps an already-open editor in sync with a theme toggle instead of it
  // staying stuck on whichever theme was active when the tab first loaded.
  if (monacoEditorInstance && window.monaco) {
    window.monaco.editor.setTheme(theme === "dark" ? "vs-dark" : "vs");
  }
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
}

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
  const lines = text.split("\n");
  lines.forEach((raw, idx) => {
    if (!raw.trim()) {
      const spacer = document.createElement("div");
      spacer.className = "tip-spacer";
      tooltipEl.appendChild(spacer);
      return;
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
      // "Label: value" lines (e.g. auth-check details) get the label and
      // value styled apart -- as one plain sentence each ran together with
      // no visual way to tell a field name from the value it's reporting.
      // Skipped on the first line so the heading styling below still wins.
      const kv = idx > 0 ? raw.trim().match(/^([^:\n]{1,90}):\s+(.+)$/) : null;
      if (kv) {
        wrapper.classList.add("tip-kv");
        const key = document.createElement("span");
        key.className = "tip-key";
        key.textContent = kv[1];
        const val = document.createElement("span");
        val.className = "tip-val";
        val.textContent = kv[2];
        wrapper.append(key, val);
      } else {
        wrapper.textContent = raw.trim();
      }
    }
    tooltipEl.appendChild(wrapper);
  });
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
  for (const view of [landingViewEl, orgViewEl, workspaceViewEl, toolsViewEl, editorViewEl, graphViewEl]) {
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
  if (res.status === 401) {
    // Session expired/missing mid-use (not a plain "wrong creds" -- that
    // never happens here, GitHub itself owns the actual login) -- bounce to
    // GitHub sign-in rather than surfacing a confusing generic error toast.
    window.location.href = "/auth/login";
    throw new Error("not authenticated");
  }
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

function fmtTime(ts) {
  if (!ts) return "";
  // Run history has no expiry (only the big plan.tfplan binary is GC'd --
  // the run record/log stays in runs.db until Clear Runs/Delete Project), so
  // a time-only stamp ("2:32 PM") was ambiguous about which day -- or even
  // year -- a run was from. Year is only added when it isn't the current
  // one, so today's/this-year's runs (the common case) stay compact.
  const d = new Date(ts * 1000);
  const opts = { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleString(undefined, opts);
}

// ---------- shared status-glyph icons ----------
// Small inline SVGs (currentColor, so they pick up whatever white/ink color
// the container already sets) instead of Unicode glyphs (✓/✗/!) -- crisper
// at small sizes and consistent across every colored-circle-chip usage
// (run status, toasts, error/warning cards, progress checklist).
const ICON_CHECK =
  '<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,13 9,18 20,6"/></svg>';
// A single diagonal line, not an X -- the chip's own circular background
// already supplies the "circle" half of the universal prohibited/blocked
// sign, so only the slash needs drawing.
const ICON_BLOCKED =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><line x1="5" y1="19" x2="19" y2="5"/></svg>';
const ICON_WARNING =
  '<svg viewBox="0 0 24 24" width="9" height="9" fill="currentColor"><rect x="10.4" y="4" width="3.2" height="10" rx="1.6"/><circle cx="12" cy="18" r="1.9"/></svg>';
const ICON_INFO =
  '<svg viewBox="0 0 24 24" width="9" height="9" fill="currentColor"><circle cx="12" cy="6" r="1.9"/><rect x="10.4" y="10" width="3.2" height="9" rx="1.6"/></svg>';

// ---------- status rendering (tick / cross instead of a status word) ----------

// success -> check, failed -> blocked/slash, queued/running -> an actual
// spinning ring (CSS border animation, see .status.running .status-icon --
// no glyph content needed, the ring IS the icon). The glyph lives in its
// own span so CSS can give it the coloured circular chip; the label sits
// next to it and is hidden by CSS in the compact list badges.
const STATUS_GLYPHS = { success: ICON_CHECK, failed: ICON_BLOCKED, running: "", queued: "" };

function statusHtml(status) {
  const glyph = status in STATUS_GLYPHS ? STATUS_GLYPHS[status] : ICON_INFO;
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

const TOAST_GLYPHS = { success: ICON_CHECK, error: ICON_BLOCKED, warning: ICON_WARNING, info: ICON_INFO };

function toast(message, { type = "info", duration = 4500, action = null } = {}) {
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.innerHTML = `<span class="toast-icon">${TOAST_GLYPHS[type] || ICON_INFO}</span><span class="toast-msg">${escapeHtml(
    message
  )}</span>`;
  if (action) {
    const btn = document.createElement("button");
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.onclick = () => {
      action.onClick();
      el.classList.add("toast-out");
      setTimeout(() => el.remove(), 200);
    };
    el.appendChild(btn);
  }
  toastContainerEl.appendChild(el);
  setTimeout(() => {
    el.classList.add("toast-out");
    setTimeout(() => el.remove(), 200);
  }, duration);
}

// ---------- breadcrumb (Home / Org / Project, or Home / Tools) ----------

const breadcrumbEl = document.getElementById("breadcrumb");

// segments: [{label, onClick}] -- the last segment is the current page and
// renders as plain (non-clickable) text; every earlier one is a link.
function renderBreadcrumb(segments) {
  breadcrumbEl.innerHTML = segments
    .map((seg, i) => {
      const sep = i > 0 ? `<span class="breadcrumb-sep">/</span>` : "";
      const isLast = i === segments.length - 1;
      return isLast
        ? `${sep}<span class="breadcrumb-current">${escapeHtml(seg.label)}</span>`
        : `${sep}<button class="breadcrumb-link" data-idx="${i}">${escapeHtml(seg.label)}</button>`;
    })
    .join("");
  breadcrumbEl.onclick = (ev) => {
    const idx = ev.target.dataset.idx;
    if (idx === undefined) return;
    segments[Number(idx)].onClick();
  };
}

// ---------- landing view (organizations) ----------

function showLanding({ pushHistory = true } = {}) {
  revealView(landingViewEl, { back: true });
  renderBreadcrumb([{ label: "IaC-Dashboard" }]);
  showBgParticles();
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
  if (!editorViewEl.classList.contains("hidden")) {
    closeFileEditor();
    return;
  }
  if (!graphViewEl.classList.contains("hidden")) {
    openWorkspace(currentProject); // read-only view -- no unsaved-state guard needed
    return;
  }
  if (!toolsViewEl.classList.contains("hidden")) {
    // Tools isn't nested under any org/project, so there's no single
    // "parent" view to compute from currentOrg/currentProject the way the
    // other two branches do -- go back to wherever you actually were
    // (landing, an org, or a specific project workspace) before opening
    // Tools, instead of always resetting to the landing page.
    const returnTo = preToolsPath || "/";
    preToolsPath = null;
    history.pushState({}, "", returnTo);
    restoreFromLocation({ pushHistory: false });
    return;
  }
  if (!workspaceViewEl.classList.contains("hidden") && currentOrg) {
    showOrgView(currentOrg);
  } else {
    showLanding();
  }
};

// ---------- tools view (standalone utilities, not tied to a project) ----------

let preToolsPath = null; // wherever we were before opening Tools -- see btnBackEl.onclick above

function showToolsView({ pushHistory = true } = {}) {
  if (pushHistory && location.pathname !== "/tools") {
    preToolsPath = location.pathname + location.search;
  }
  revealView(toolsViewEl);
  hideBgParticles();
  renderBreadcrumb([{ label: "IaC-Dashboard", onClick: showLanding }, { label: "Tools" }]);
  btnBackEl.classList.remove("hidden");
  btnBackEl.textContent = "←";
  currentOrg = null;
  currentProject = null;
  currentRunId = null;
  if (currentEventSource) { currentEventSource.close(); currentEventSource = null; }
  if (runsPollTimer) { clearInterval(runsPollTimer); runsPollTimer = null; }
  document.title = "Tools — IaC-Dashboard";

  if (pushHistory && location.pathname !== "/tools") {
    history.pushState({}, "", "/tools");
  }
}

// ---------- org view (work projects inside one organization) ----------

// Shared between the automatic sync-on-open (showOrgView) and the manual
// "Sync now" button -- same call, same error handling either way. No-op
// server-side for a Local org. Best-effort -- a pull failure (no network,
// no credentials) is surfaced as a toast, not a blocking error, since
// whatever synced previously is still viewable.
async function syncCloudOrg(org) {
  if (org.mode !== "cloud") return;
  try {
    const result = await api(`/api/organizations/${org.id}/sync`, { method: "POST" });
    if (result.warning) toast(`Cloud sync: ${result.warning}`, { type: "warning", duration: 7000 });
  } catch (e) {
    toast(`Cloud sync failed: ${e.message}`, { type: "warning", duration: 7000 });
  }
}

btnSyncCloudOrgEl.onclick = async () => {
  if (!currentOrg) return;
  btnSyncCloudOrgEl.disabled = true;
  try {
    await syncCloudOrg(currentOrg);
    await refreshProjects();
    toast("Synced.", { type: "success", duration: 2500 });
  } finally {
    btnSyncCloudOrgEl.disabled = false;
  }
};

// ---------- local sync agent ("Sync to my computer") ----------
// Talks DIRECTLY to a small local program (IaC-Dashboard Sync Agent)
// listening on 127.0.0.1 -- a website's JS can't otherwise touch a
// visitor's own disk, so this is the only way "Sync to my computer" can
// mean anything real. Every control (repo/folder/when to sync) lives
// here in the dashboard; the agent itself has no UI beyond a first-run
// dialog and a tray icon.
//
// Shown as a single compact pill (matching the Azure auth pill) rather
// than a standing panel -- click behavior depends on state: not detected
// -> downloads the agent, not yet configured -> opens the setup modal,
// already synced -> triggers a sync right now. Hover always shows the
// same info (folder, last sync, auto-sync interval) via the existing
// data-tip tooltip engine.

const AGENT_URL = "http://127.0.0.1:9876";
const localSyncPillEl = document.getElementById("local-sync-pill");
const agentConfigureModalEl = document.getElementById("agent-configure-modal");
const agentConfigureRepoLabelEl = document.getElementById("agent-configure-repo-label");
const agentTokenInputEl = document.getElementById("agent-token-input");
const agentLocalDirInputEl = document.getElementById("agent-local-dir-input");
const agentSetupErrorEl = document.getElementById("agent-setup-error");
const btnBrowseAgentFolderEl = document.getElementById("btn-browse-agent-folder");
const btnStartAgentSyncEl = document.getElementById("btn-start-agent-sync");

function agentTokenKey(orgId) {
  return `iac_agent_token_${orgId}`;
}

async function agentFetch(path, opts = {}) {
  const res = await fetch(`${AGENT_URL}${path}`, opts);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `agent HTTP ${res.status}`);
  return body;
}

async function renderLocalSyncPill(org) {
  if (org.mode !== "cloud") {
    localSyncPillEl.classList.add("hidden");
    return;
  }
  localSyncPillEl.classList.remove("hidden");

  let status;
  try {
    status = await agentFetch("/status");
  } catch (e) {
    // Most common case: the agent just isn't running right now -- not an
    // error to alarm over, just an offer to get it.
    localSyncPillEl.className = "pill muted-pill";
    localSyncPillEl.textContent = "Local sync: not running";
    localSyncPillEl.dataset.tip = [
      "Local Sync Agent",
      "No agent detected on this computer.",
      "Click to download it -- see sync_agent/README.md for what it does and why it's needed.",
    ].join("\n");
    localSyncPillEl.onclick = () => {
      window.location.href = "/download/sync-agent";
    };
    return;
  }

  const configuredForThisOrg = status.configured && status.repo_url === org.repo_url;

  if (!configuredForThisOrg) {
    localSyncPillEl.className = "pill checking";
    localSyncPillEl.textContent = "Local sync: not set up";
    localSyncPillEl.dataset.tip = [
      "Local Sync Agent",
      "Agent detected on this computer, but it isn't syncing this org yet.",
      "Click to set it up.",
    ].join("\n");
    localSyncPillEl.onclick = () => openAgentConfigureModal(org);
    return;
  }

  const lastSynced = status.last_synced_at ? fmtRelative(status.last_synced_at) : "never";
  const autoSyncMins = status.auto_sync_interval_seconds ? Math.round(status.auto_sync_interval_seconds / 60) : null;
  localSyncPillEl.className = "pill ok";
  localSyncPillEl.textContent = "Local sync: synced";
  localSyncPillEl.dataset.tip = [
    "Local Sync Agent",
    `Folder: ${status.local_dir}`,
    `Last synced: ${lastSynced}`,
    autoSyncMins ? `Auto-syncs every ~${autoSyncMins} min` : "",
    "",
    "Click this pill to sync right now.",
  ]
    .filter(Boolean)
    .join("\n");
  localSyncPillEl.onclick = () => triggerManualAgentSync(org);
}

async function triggerManualAgentSync(org) {
  const token = localStorage.getItem(agentTokenKey(org.id));
  localSyncPillEl.className = "pill checking";
  localSyncPillEl.textContent = "Local sync: syncing…";
  try {
    const result = await agentFetch("/sync", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    toast(result.warning ? `Synced with a warning: ${result.warning}` : "Synced to your computer.", {
      type: result.warning ? "warning" : "success",
    });
  } catch (e) {
    toast(`Sync failed: ${e.message}`, { type: "error", duration: 7000 });
  } finally {
    renderLocalSyncPill(org);
  }
}

function openAgentConfigureModal(org) {
  agentConfigureRepoLabelEl.textContent = org.repo_url;
  agentTokenInputEl.value = localStorage.getItem(agentTokenKey(org.id)) || "";
  agentLocalDirInputEl.value = "";
  agentSetupErrorEl.classList.add("hidden");
  openModal(agentConfigureModalEl);

  btnBrowseAgentFolderEl.onclick = async () => {
    agentSetupErrorEl.classList.add("hidden");
    const t = agentTokenInputEl.value.trim();
    if (!t) {
      agentSetupErrorEl.textContent = "Paste the agent token first.";
      agentSetupErrorEl.classList.remove("hidden");
      return;
    }
    try {
      const { path } = await agentFetch("/browse-folder", { method: "POST", headers: { Authorization: `Bearer ${t}` } });
      if (path) agentLocalDirInputEl.value = path;
    } catch (e) {
      agentSetupErrorEl.textContent = e.message;
      agentSetupErrorEl.classList.remove("hidden");
    }
  };

  btnStartAgentSyncEl.onclick = async () => {
    agentSetupErrorEl.classList.add("hidden");
    const t = agentTokenInputEl.value.trim();
    const dir = agentLocalDirInputEl.value.trim();
    if (!t || !dir) {
      agentSetupErrorEl.textContent = "Enter the token and pick a local folder.";
      agentSetupErrorEl.classList.remove("hidden");
      return;
    }
    try {
      await agentFetch("/configure", {
        method: "POST",
        headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
        body: JSON.stringify({ repo_url: org.repo_url, local_dir: dir }),
      });
      localStorage.setItem(agentTokenKey(org.id), t);
      closeModals();
      toast("Local sync set up.", { type: "success" });
      renderLocalSyncPill(org);
    } catch (e) {
      agentSetupErrorEl.textContent = e.message;
      agentSetupErrorEl.classList.remove("hidden");
    }
  };
}

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
  hideBgParticles();
  renderBreadcrumb([{ label: "IaC-Dashboard", onClick: showLanding }, { label: org.name }]);
  btnBackEl.classList.remove("hidden");
  btnBackEl.textContent = "←";
  orgViewNameEl.textContent = org.name;
  document.title = `${org.name} — IaC-Dashboard`;
  btnSyncCloudOrgEl.classList.toggle("hidden", org.mode !== "cloud");

  if (pushHistory) {
    const url = `/${encodeURIComponent(org.name)}`;
    if (location.pathname !== url) history.pushState({ orgId: org.id }, "", url);
  }

  await syncCloudOrg(org);
  renderLocalSyncPill(org); // best-effort, doesn't block the rest of the page on the agent probe
  await refreshProjects();
}

// ---------- URL routing (back/forward + refresh-safe deep links) ----------

window.addEventListener("popstate", () => restoreFromLocation({ pushHistory: false }));

async function restoreFromLocation({ pushHistory }) {
  if (location.pathname === "/tools") {
    showToolsView({ pushHistory });
    return;
  }
  // Resolves org+project by name -- shared by every route below that opens
  // its own tab (editor, graph) at a /<prefix>/<org>/<project> URL, one
  // level deeper than the plain /<org>/<project> workspace route.
  async function resolveOrgAndProject(orgName, projectName) {
    const orgs = await api("/api/organizations");
    const org = orgs.find((o) => o.name === orgName);
    if (!org) throw new Error(`no organization named "${orgName}"`);
    const projects = await api(`/api/projects?org_id=${org.id}`);
    const project = projects.find((p) => p.name === projectName);
    if (!project) throw new Error(`no project named "${projectName}" in "${orgName}"`);
    return { org, project };
  }

  // The editor opens in its own tab (a fresh load of this same app, at a
  // /editor/<org>/<project> URL) rather than swapping the view in place.
  const editorMatch = location.pathname.match(/^\/editor\/([^/]+)\/([^/]+)\/?$/);
  if (editorMatch) {
    try {
      const { org, project } = await resolveOrgAndProject(decodeURIComponent(editorMatch[1]), decodeURIComponent(editorMatch[2]));
      currentOrg = org;
      await showFileEditor(project, { pushHistory });
    } catch (e) {
      toast(`That link is no longer valid: ${e.message}`, { type: "error" });
      showLanding({ pushHistory });
    }
    return;
  }

  // Same idea for the dependency graph -- /graph/<org>/<project>, its own tab.
  const graphMatch = location.pathname.match(/^\/graph\/([^/]+)\/([^/]+)\/?$/);
  if (graphMatch) {
    try {
      const { org, project } = await resolveOrgAndProject(decodeURIComponent(graphMatch[1]), decodeURIComponent(graphMatch[2]));
      currentOrg = org;
      await showDependencyGraph(project, { pushHistory });
    } catch (e) {
      toast(`That link is no longer valid: ${e.message}`, { type: "error" });
      showLanding({ pushHistory });
    }
    return;
  }
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

// ---------- mouse-tracking spotlight on cards ----------
// One delegated listener rather than one per card (cards get re-created on
// every refresh) -- sets --mx/--my to the cursor position relative to
// whichever card it's currently over; the gradient itself is pure CSS
// (see .project-card::after).
document.addEventListener("mousemove", (ev) => {
  const card = ev.target.closest(".project-card");
  if (!card) return;
  const rect = card.getBoundingClientRect();
  card.style.setProperty("--mx", `${ev.clientX - rect.left}px`);
  card.style.setProperty("--my", `${ev.clientY - rect.top}px`);
});

// ---------- interactive background particles (landing page) ----------
// A swarm of small dots that orbits around the cursor and trails it as it
// moves -- each dot keeps a fixed angle/radius offset from the cursor (plus a
// slow independent drift so the swarm keeps breathing when the cursor is
// still) and eases toward that point at its own speed, so the cloud lags
// and re-forms around the cursor rather than reacting only when close.
// Shown/hidden by showLanding()/the other view functions, animated only
// while visible so it doesn't burn CPU on views where it isn't shown.

const bgParticlesEl = document.getElementById("bg-particles");
const PARTICLE_COLORS = ["#3b82f6", "#d97706", "#8b5cf6", "#ef4444"]; // blue, amber, purple, red -- same accent + semantic hues used elsewhere, not a new palette

let bgParticles = [];
let bgParticlesRafId = null;
let mouseX = null;
let mouseY = null;

document.addEventListener("mousemove", (ev) => {
  mouseX = ev.clientX;
  mouseY = ev.clientY;
});

// window.innerWidth/innerHeight are 0 in some embedded/preview contexts
// before layout settles -- document.documentElement.clientWidth/Height is a
// more reliable fallback, and a fixed default covers the (rare) case where
// even that reports 0, so particles never all end up stacked at (0,0).
function getViewportSize() {
  return {
    w: window.innerWidth || document.documentElement.clientWidth || 1200,
    h: window.innerHeight || document.documentElement.clientHeight || 800,
  };
}

function initBgParticles(count = 46) {
  bgParticlesEl.innerHTML = "";
  bgParticles = [];
  const { w, h } = getViewportSize();
  if (mouseX === null) {
    mouseX = w / 2;
    mouseY = h / 2;
  }
  for (let i = 0; i < count; i++) {
    const el = document.createElement("div");
    el.className = "bg-dot";
    const size = 2 + Math.random() * 4;
    el.style.width = `${size}px`;
    el.style.height = `${size}px`;
    el.style.background = PARTICLE_COLORS[i % PARTICLE_COLORS.length];
    el.style.opacity = String(0.3 + Math.random() * 0.35);
    bgParticlesEl.appendChild(el);
    bgParticles.push({
      el,
      angle: Math.random() * Math.PI * 2,
      radius: 40 + Math.random() * 150,
      angleSpeed: (Math.random() < 0.5 ? -1 : 1) * (0.004 + Math.random() * 0.012),
      ease: 0.04 + Math.random() * 0.09,
      x: mouseX,
      y: mouseY,
    });
  }
}

function animateBgParticles() {
  for (const p of bgParticles) {
    p.angle += p.angleSpeed;
    const targetX = mouseX + Math.cos(p.angle) * p.radius;
    const targetY = mouseY + Math.sin(p.angle) * p.radius;
    p.x += (targetX - p.x) * p.ease;
    p.y += (targetY - p.y) * p.ease;
    p.el.style.transform = `translate3d(${p.x}px, ${p.y}px, 0)`;
  }
  bgParticlesRafId = requestAnimationFrame(animateBgParticles);
}

function showBgParticles() {
  if (bgParticles.length === 0) initBgParticles();
  bgParticlesEl.classList.add("visible");
  if (!bgParticlesRafId) animateBgParticles();
}

function hideBgParticles() {
  bgParticlesEl.classList.remove("visible");
  if (bgParticlesRafId) {
    cancelAnimationFrame(bgParticlesRafId);
    bgParticlesRafId = null;
  }
}

// Re-scatter across the new viewport size on resize -- otherwise a shrink
// leaves dots stranded off-screen to the right/bottom, and a grow leaves
// the new space empty. Debounced since resize fires continuously while
// dragging; only bothers regenerating if particles have actually been
// created (no-op on any view where the background isn't shown).
let bgParticlesResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(bgParticlesResizeTimer);
  bgParticlesResizeTimer = setTimeout(() => {
    if (bgParticles.length > 0) initBgParticles();
  }, 300);
});

// ---------- header dropdown menu (theme / Tools / Restart Server) ----------
// Same ⋮-menu pattern as a project/org card, just anchored under the header
// button instead -- one menu instead of three separate always-visible
// buttons cluttering the header.

const btnHeaderMenuEl = document.getElementById("btn-header-menu");

// Populated once at load (see bottom of file) from /api/auth/me -- null
// means GitHub sign-in isn't configured on this server at all, in which
// case the menu just omits the sign-in row/Sign out button entirely rather
// than showing a misleading "signed in as nobody" state.
let currentGithubLogin = null;

btnHeaderMenuEl.onclick = (ev) => {
  ev.stopPropagation();
  const alreadyOpen = btnHeaderMenuEl.classList.contains("menu-open");
  closeAllCardMenus();
  if (alreadyOpen) return;

  btnHeaderMenuEl.classList.add("menu-open");
  const isDark = document.documentElement.dataset.theme === "dark";
  const menu = document.createElement("div");
  menu.className = "card-menu header-menu";
  menu.innerHTML = `
    ${currentGithubLogin ? `<div class="header-menu-account">Signed in as ${escapeHtml(currentGithubLogin)}</div>` : ""}
    <button data-action="theme">${isDark ? "☀ Switch to light mode" : "☾ Switch to dark mode"}</button>
    <button data-action="tools">Tools</button>
    <button data-action="restart" class="danger">Restart Server</button>
    ${currentGithubLogin ? `<button data-action="signout" class="danger">Sign out</button>` : ""}
  `;
  menu.onclick = (mev) => {
    mev.stopPropagation();
    const action = mev.target.dataset.action;
    if (!action) return;
    closeAllCardMenus();
    if (action === "theme") toggleTheme();
    else if (action === "tools") showToolsView();
    else if (action === "restart") restartServer();
    else if (action === "signout") window.location.href = "/auth/logout";
  };
  btnHeaderMenuEl.parentElement.appendChild(menu);
};

api("/api/auth/me")
  .then((res) => {
    currentGithubLogin = res.enabled ? res.login : null;
  })
  .catch(() => {});

// ---------- notification bell (cross-project run completions) ----------
// Polls for runs that finished anywhere, not just the project currently
// open -- Azure-portal-style bell with an unread badge, dropdown history,
// and a toast (with a "View" jump straight to the run) for anything that
// finishes while you're looking at something else.

const btnNotifBellEl = document.getElementById("btn-notif-bell");
const notifBadgeEl = document.getElementById("notif-badge");
const notifDropdownEl = document.getElementById("notif-dropdown");

let notifLastSeenAt = Date.now() / 1000; // don't toast for runs that finished before the page loaded
let notifUnreadCount = 0;
let notifItems = [];

function renderNotifBadge() {
  notifBadgeEl.textContent = String(notifUnreadCount);
  notifBadgeEl.classList.toggle("hidden", notifUnreadCount === 0);
}

function notifItemHtml(run) {
  const icon = run.status === "success" ? ICON_CHECK : ICON_BLOCKED;
  return `
    <button class="notif-item ${run.status}" data-run-id="${run.run_id}">
      <span class="notif-item-icon">${icon}</span>
      <span class="notif-item-body">
        <span class="notif-item-title">${escapeHtml(run.target.project_name)} &middot; ${escapeHtml(run.kind)}</span>
        <span class="notif-item-time">${escapeHtml(fmtRelative(run.finished_at))}</span>
      </span>
    </button>`;
}

function renderNotifDropdown() {
  notifDropdownEl.innerHTML = notifItems.length
    ? notifItems.map(notifItemHtml).join("")
    : `<div class="notif-empty">No runs finished yet this session.</div>`;
  notifDropdownEl.querySelectorAll(".notif-item").forEach((btn) => {
    btn.onclick = () => {
      const run = notifItems.find((r) => r.run_id === btn.dataset.runId);
      notifDropdownEl.classList.add("hidden");
      if (run) navigateToRun(run);
    };
  });
}

btnNotifBellEl.onclick = (ev) => {
  ev.stopPropagation();
  const opening = notifDropdownEl.classList.contains("hidden");
  notifDropdownEl.classList.toggle("hidden", !opening);
  if (opening) {
    renderNotifDropdown();
    notifUnreadCount = 0;
    renderNotifBadge();
  }
};
document.addEventListener("click", (ev) => {
  if (!notifDropdownEl.classList.contains("hidden") && !notifDropdownEl.contains(ev.target) && ev.target !== btnNotifBellEl) {
    notifDropdownEl.classList.add("hidden");
  }
});

// Jumps to the run's project/workspace from anywhere -- the notification
// may point at a project in a different organization than the one (if any)
// currently open, so this re-resolves both from scratch rather than
// assuming currentOrg already matches.
async function navigateToRun(run) {
  const projectId = run.target.project_id;
  let project;
  let orgs;
  try {
    [project, orgs] = await Promise.all([api(`/api/projects/${projectId}`), api("/api/organizations")]);
  } catch (e) {
    toast("That project no longer exists.", { type: "error" });
    return;
  }
  const org = orgs.find((o) => o.id === project.org_id);
  if (!org) {
    toast("That project's organization no longer exists.", { type: "error" });
    return;
  }
  currentOrg = org;
  await openWorkspace(project);
  selectRun(run.run_id);
}

async function pollNotifications() {
  let recent;
  try {
    recent = await api("/api/notifications/recent");
  } catch (e) {
    return;
  }
  notifItems = recent;

  const fresh = recent.filter((r) => r.finished_at && r.finished_at > notifLastSeenAt);
  for (const run of fresh) {
    // Already looking at this exact run live -- it just finished in front
    // of the user, no need to also toast about it.
    if (run.run_id === currentRunId) continue;
    notifUnreadCount++;
    toast(`${run.target.project_name}: ${run.kind} ${run.status === "success" ? "succeeded" : "failed"}`, {
      type: run.status === "success" ? "success" : "error",
      duration: 10000,
      action: { label: "View", onClick: () => navigateToRun(run) },
    });
  }
  if (recent.length) {
    notifLastSeenAt = Math.max(notifLastSeenAt, ...recent.map((r) => r.finished_at || 0));
  }
  renderNotifBadge();
}
setInterval(pollNotifications, 8000);
pollNotifications();

function renderOrgCard(o) {
  const card = document.createElement("div");
  card.className = "project-card";
  card.innerHTML = `
    <div class="card-top-row">
      <div class="name">${o.name}${o.mode === "cloud" ? '<span class="badge cloud-badge" title="Projects live in a shared Git repo">☁ Cloud</span>' : ""}</div>
      <button class="card-menu-btn" data-tip="Organization settings" aria-label="Organization settings">&#8942;</button>
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

const orgSearchInputEl = document.getElementById("org-search-input");
let allOrgs = [];

async function refreshOrgs() {
  allOrgs = await api("/api/organizations");
  renderFilteredOrgs();
}

function renderFilteredOrgs() {
  const q = orgSearchInputEl.value.trim().toLowerCase();
  const filtered = q ? allOrgs.filter((o) => o.name.toLowerCase().includes(q)) : allOrgs;
  orgsGridEl.innerHTML = "";
  for (const o of filtered) orgsGridEl.appendChild(renderOrgCard(o));

  if (allOrgs.length === 0) {
    noOrgsMsgEl.textContent = 'No organizations yet — click "New Organization" to create one. Projects live inside an organization, so this comes first.';
    noOrgsMsgEl.classList.remove("hidden");
  } else if (filtered.length === 0) {
    noOrgsMsgEl.textContent = `No organizations match "${orgSearchInputEl.value.trim()}".`;
    noOrgsMsgEl.classList.remove("hidden");
  } else {
    noOrgsMsgEl.classList.add("hidden");
  }
}
orgSearchInputEl.addEventListener("input", renderFilteredOrgs);

// "2h ago" style -- for the last-run badge, where the exact timestamp
// matters less than "was this recent or ages ago".
function fmtRelative(ts) {
  const seconds = Math.max(0, Date.now() / 1000 - ts);
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return fmtTime(ts);
}

function lastRunBadgeHtml(lastRun) {
  if (!lastRun) return `<div class="last-run-badge muted">no runs yet</div>`;
  const icon = lastRun.status === "success" ? ICON_CHECK : lastRun.status === "failed" ? ICON_BLOCKED : "";
  return `<div class="last-run-badge ${lastRun.status}">
    <span class="last-run-icon">${icon}</span>
    <span>${escapeHtml(lastRun.kind.toUpperCase())} ${escapeHtml(fmtRelative(lastRun.created_at))}</span>
  </div>`;
}

// Fires after project cards render, one /versions call per initialized
// project. Silent when there's no drift (the common case, right after a
// clean init) -- the badge only appears when there's actually something to
// look at, same "don't show it unless it matters" approach as last-run.
async function checkProviderDrift(projects) {
  await Promise.all(
    projects
      .filter((p) => p.initialized)
      .map(async (p) => {
        let data;
        try {
          data = await api(`/api/projects/${p.id}/versions`);
        } catch (e) {
          return;
        }
        const drift = data.drift || [];
        if (drift.length === 0) return;
        const badge = document.querySelector(`.provider-drift-badge[data-project-id="${p.id}"]`);
        if (!badge) return;
        const tip = drift
          .map((d) => `${d.provider}\n  installed: ${d.installed}\n  locked: ${d.locked}`)
          .join("\n\n");
        badge.classList.remove("hidden");
        badge.dataset.tip = `Installed provider version differs from .terraform.lock.hcl -- re-run init to reconcile.\n\n${tip}`;
        badge.innerHTML = `<span class="drift-icon">${ICON_WARNING}</span><span>${drift.length} provider${
          drift.length === 1 ? "" : "s"
        } out of sync with lock file</span>`;
      })
  );
}

function renderProjectCard(p) {
  const card = document.createElement("div");
  card.className = "project-card";
  card.innerHTML = `
    <div class="card-top-row">
      <div class="name">${p.name}</div>
      <button class="card-menu-btn" data-tip="Project settings" aria-label="Project settings">&#8942;</button>
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
      <span class="pill" data-tip="${escapeHtml(
        p.retention_days
          ? `Run retention: ${p.retention_days} day${p.retention_days === 1 ? "" : "s"}\nFinished init/plan/apply runs older than this are deleted automatically.`
          : "Run retention: keep forever\nNo automatic cleanup -- edit the project to set a limit."
      )}">${p.retention_days ? `${p.retention_days}d retention` : "keeps runs forever"}</span>
    </div>
    <div class="path">${p.project_root}</div>
    <div class="init-status ${p.initialized ? "ok" : "pending"}">
      ${p.initialized ? "initialized" : "not initialized yet this session"}
    </div>
    ${lastRunBadgeHtml(p.last_run)}
    <div class="provider-drift-badge hidden" data-project-id="${p.id}"></div>
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

const projectSearchInputEl = document.getElementById("project-search-input");
let allProjects = [];

async function refreshProjects() {
  if (!currentOrg) return;
  allProjects = await api(`/api/projects?org_id=${currentOrg.id}`);
  renderFilteredProjects();
}

function renderFilteredProjects() {
  const q = projectSearchInputEl.value.trim().toLowerCase();
  const filtered = q ? allProjects.filter((p) => p.name.toLowerCase().includes(q)) : allProjects;
  projectsGridEl.innerHTML = "";
  for (const p of filtered) projectsGridEl.appendChild(renderProjectCard(p));
  checkProviderDrift(filtered);

  if (allProjects.length === 0) {
    noProjectsMsgEl.textContent = 'No work projects yet in this organization — click "Add Work Project" to set one up.';
    noProjectsMsgEl.classList.remove("hidden");
  } else if (filtered.length === 0) {
    noProjectsMsgEl.textContent = `No work projects match "${projectSearchInputEl.value.trim()}".`;
    noProjectsMsgEl.classList.remove("hidden");
  } else {
    noProjectsMsgEl.classList.add("hidden");
  }
}
projectSearchInputEl.addEventListener("input", renderFilteredProjects);

// ---------- add organization modal ----------

let addOrgMode = "local";

function setOrgMode(mode) {
  addOrgMode = mode;
  tabOrgLocalEl.classList.toggle("active", mode === "local");
  tabOrgCloudEl.classList.toggle("active", mode === "cloud");
  orgRepoUrlBoxEl.classList.toggle("hidden", mode !== "cloud");
  orgModeHintEl.textContent =
    mode === "cloud"
      ? "Cloud: this org's projects live in a Git repo -- anyone who creates an org with the same name + repo URL sees the same projects."
      : "Local: everything stays on this machine only (the default, unchanged).";
}
tabOrgLocalEl.onclick = () => setOrgMode("local");
tabOrgCloudEl.onclick = () => setOrgMode("cloud");

btnAddOrgEl.onclick = () => {
  orgNameInputEl.value = "";
  orgRepoUrlInputEl.value = "";
  orgClonePathInputEl.value = "";
  addOrgErrorEl.classList.add("hidden");
  addOrgWarningEl.classList.add("hidden");
  setOrgMode("local");
  openModal(addOrgModalEl);
};

btnBrowseClonePathEl.onclick = async () => {
  try {
    const { path } = await api("/api/browse-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (path) orgClonePathInputEl.value = path;
  } catch (e) {
    addOrgErrorEl.textContent = e.message;
    addOrgErrorEl.classList.remove("hidden");
  }
};

btnCreateOrgEl.onclick = async () => {
  addOrgErrorEl.classList.add("hidden");
  addOrgWarningEl.classList.add("hidden");
  const name = orgNameInputEl.value.trim();
  if (!name) {
    addOrgErrorEl.textContent = "Give this organization a name.";
    addOrgErrorEl.classList.remove("hidden");
    return;
  }
  const repoUrl = orgRepoUrlInputEl.value.trim();
  if (addOrgMode === "cloud" && !repoUrl) {
    addOrgErrorEl.textContent = "Enter a Git repo URL for a Cloud organization.";
    addOrgErrorEl.classList.remove("hidden");
    return;
  }
  const clonePath = orgClonePathInputEl.value.trim();
  const originalLabel = btnCreateOrgEl.textContent;
  if (addOrgMode === "cloud") btnCreateOrgEl.textContent = "Cloning repo…";
  btnCreateOrgEl.disabled = true;
  try {
    const org = await api("/api/organizations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        mode: addOrgMode,
        repo_url: addOrgMode === "cloud" ? repoUrl : undefined,
        clone_path: addOrgMode === "cloud" && clonePath ? clonePath : undefined,
      }),
    });
    if (org.warning) {
      // Non-fatal (e.g. the repo looks public) -- org was still created,
      // just flag it instead of silently proceeding.
      addOrgWarningEl.textContent = org.warning;
      addOrgWarningEl.classList.remove("hidden");
      toast(org.warning, { type: "warning", duration: 9000 });
    }
    closeModals();
    await showOrgView(org);
  } catch (e) {
    addOrgErrorEl.textContent = e.message;
    addOrgErrorEl.classList.remove("hidden");
  } finally {
    btnCreateOrgEl.disabled = false;
    btnCreateOrgEl.textContent = originalLabel;
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

// Cloud org project creation skips the folder picker entirely -- name it,
// and create_cloud_project scaffolds <repo>/<name>/ automatically (see
// README's "Cloud organizations" section for why: the folder is never a
// real choice for a Cloud org, there's exactly one right answer).
let isCloudCreateMode = false;

btnAddProjectEl.onclick = () => {
  editingProjectId = null;
  addProjectModalTitleEl.textContent = "Add Work Project";
  btnCreateProjectEl.textContent = "Create Project";
  projectNameInputEl.value = "";
  projectNameInputEl.disabled = false;
  projectNameInputEl.title = "";
  retentionDaysInputEl.value = "";
  addProjectErrorEl.classList.add("hidden");

  isCloudCreateMode = !!(currentOrg && currentOrg.mode === "cloud");
  cloudProjectHintEl.classList.toggle("hidden", !isCloudCreateMode);
  folderPickerSectionEl.classList.toggle("hidden", isCloudCreateMode);

  if (isCloudCreateMode) {
    btnCreateProjectEl.disabled = true; // re-enabled by the name-input listener below once non-empty
  } else {
    // Pre-fills from this org's last-browsed path (see btnBrowseEl.onclick)
    // instead of always starting blank -- most useful when an org's
    // projects live under one shared parent repo/client folder.
    projectRootInputEl.value = (currentOrg && currentOrg.last_browsed_path) || "";
    tabExistingFolderEl.classList.remove("hidden");
    tabNewFolderEl.classList.remove("hidden");
    document.getElementById("folder-mode-tabs").classList.remove("hidden");
    setFolderMode("existing");
  }
  openModal(addProjectModalEl);
};

projectNameInputEl.addEventListener("input", () => {
  if (isCloudCreateMode && !editingProjectId) {
    btnCreateProjectEl.disabled = !projectNameInputEl.value.trim();
  }
});

async function openEditProjectModal(project) {
  editingProjectId = project.id;
  isCloudCreateMode = false; // editing always uses the full folder picker, even for a Cloud org project
  cloudProjectHintEl.classList.add("hidden");
  folderPickerSectionEl.classList.remove("hidden");
  addProjectModalTitleEl.textContent = `Edit "${project.name}"`;
  btnCreateProjectEl.textContent = "Save Changes";
  projectNameInputEl.value = project.name;
  projectNameInputEl.disabled = true;
  projectNameInputEl.title = "Name can't be changed -- it's the stable key this project's URL is built on. Delete and re-add it to rename.";
  projectRootInputEl.value = project.project_root;
  retentionDaysInputEl.value = project.retention_days ?? "";
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
    const { path } = await api("/api/browse-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org_id: currentOrg ? currentOrg.id : null }),
    });
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
      body: JSON.stringify({ project_root: projectRoot, org_id: currentOrg ? currentOrg.id : null }),
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

  if (!editingProjectId && isCloudCreateMode) {
    const name = projectNameInputEl.value.trim();
    if (!name) { showAddProjectError("Give this project a name."); return; }
    const cloudRetentionRaw = retentionDaysInputEl.value.trim();
    let retentionDays = null;
    if (cloudRetentionRaw !== "") {
      const n = Number(cloudRetentionRaw);
      if (!Number.isInteger(n) || n < 0) {
        showAddProjectError("Run retention must be a whole number of days (blank = keep forever).");
        return;
      }
      retentionDays = n;
    }
    try {
      const project = await api(`/api/organizations/${currentOrg.id}/cloud-project`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, retention_days: retentionDays }),
      });
      closeModals();
      await openWorkspace(project);
      runInit(); // same as the non-cloud "brand-new project" path below
    } catch (e) {
      showAddProjectError(e.message);
    }
    return;
  }

  const projectRoot = projectRootInputEl.value.trim();
  const deployment = deploymentSelectEl.value;
  const environment = environmentSelectEl.value;
  if (!deployment || !environment) { showAddProjectError("Pick a deployment and environment."); return; }

  const retentionRaw = retentionDaysInputEl.value.trim();
  let retentionDays = null;
  if (retentionRaw !== "") {
    const n = Number(retentionRaw);
    if (!Number.isInteger(n) || n < 0) {
      showAddProjectError("Run retention must be a whole number of days (blank = keep forever).");
      return;
    }
    retentionDays = n;
  }

  try {
    if (editingProjectId) {
      await api(`/api/projects/${editingProjectId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ project_root: projectRoot, deployment, environment, retention_days: retentionDays }),
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
          retention_days: retentionDays,
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
  hideBgParticles();
  renderBreadcrumb([
    { label: "IaC-Dashboard", onClick: showLanding },
    { label: currentOrg.name, onClick: () => showOrgView(currentOrg) },
    { label: project.name },
  ]);
  btnBackEl.classList.remove("hidden");
  btnBackEl.textContent = "←";
  renderTargetPills(project);
  resetLogView();
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
    <span class="pill checking" id="auth-pill">checking Azure&hellip;</span>
    <span class="pill muted-pill" id="terraform-version-pill" data-tip="Terraform CLI version on this machine">tf …</span>`;
  btnPlanEl.disabled = !project.initialized;
  btnPlanDestroyEl.disabled = !project.initialized;
  btnValidateEl.disabled = !project.initialized;
  refreshAuthPill(project.id);
  refreshTerraformVersionPill(project.id);
}

async function refreshTerraformVersionPill(projectId) {
  const pillEl = document.getElementById("terraform-version-pill");
  if (!pillEl) return;
  let terraformVersion = "unknown";
  let providers = {};
  try {
    const data = await api(`/api/projects/${projectId}/versions`);
    terraformVersion = data.terraform_version || "unknown";
    providers = data.providers || {};
  } catch (e) {
    // leave defaults -- pill still renders, just without version info
  }
  const providerNames = Object.keys(providers);
  // the workspace may have been left (or switched) while that request was in flight
  const stillCurrent = document.getElementById("terraform-version-pill");
  if (!stillCurrent) return;
  stillCurrent.textContent = providerNames.length
    ? `tf ${terraformVersion} · ${providerNames.length} provider${providerNames.length === 1 ? "" : "s"}`
    : `tf ${terraformVersion}`;
  const tipLines = [`Terraform CLI: ${terraformVersion}`];
  if (providerNames.length) {
    tipLines.push("", "Providers:");
    for (const name of providerNames) {
      tipLines.push(`  ${name}: ${providers[name] || "unknown"}`);
    }
  } else {
    tipLines.push("", "Providers: run terraform init to see selected provider versions");
  }
  stillCurrent.setAttribute("data-tip", tipLines.join("\n"));
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

// `az` state (login, expired token, subscription switch) can change in
// another window while the dashboard tab just sits open -- re-check
// whenever the tab regains focus, not only when Re-run Init is clicked.
window.addEventListener("focus", () => {
  if (currentProject && document.getElementById("auth-pill")) {
    refreshAuthPill(currentProject.id);
  }
});

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
const progressToolbarEl = document.getElementById("progress-toolbar");
const progressListEl = document.getElementById("progress-list");
const progressCountsEl = document.getElementById("progress-counts");
const btnToggleProgressLogEl = document.getElementById("btn-toggle-progress-log");

// Used both for HTML text content AND interpolated into attribute values
// (data-tip="...", data-address="...", etc) throughout this file -- the
// DOM textContent/innerHTML round-trip below only escapes &, <, > (which is
// all a text NODE needs), not quotes, so a value containing a literal "
// would silently close an attribute early and truncate everything after it.
// That's a real bug this hit: terraform resource addresses using for_each
// (e.g. `azurerm_storage_account.this["st-1"]`) always contain a literal ",
// so the state-resource-browser's data-address attribute got cut off right
// before it, and every for_each-keyed resource's detail lookup failed with
// a truncated address.
function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML.replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

function formatAttrValue(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Highlights just the substring that differs between a changed attribute's
// before/after values (e.g. "Standard_LRS" -> "Standard_GRS" highlights only
// "L"/"G"), rather than the whole value -- found via longest common
// prefix/suffix, which is cheap and reads naturally for the
// mostly-one-token-changed values terraform attributes tend to have. Returns
// pre-escaped HTML strings, safe to insert directly.
function highlightDiffPair(beforeStr, afterStr) {
  let p = 0;
  const maxP = Math.min(beforeStr.length, afterStr.length);
  while (p < maxP && beforeStr[p] === afterStr[p]) p++;
  let s = 0;
  const maxS = maxP - p;
  while (s < maxS && beforeStr[beforeStr.length - 1 - s] === afterStr[afterStr.length - 1 - s]) s++;

  const beforeMid = beforeStr.slice(p, beforeStr.length - s);
  const afterMid = afterStr.slice(p, afterStr.length - s);

  const beforeHtml =
    escapeHtml(beforeStr.slice(0, p)) +
    (beforeMid ? `<mark class="diff-hl diff-hl-old">${escapeHtml(beforeMid)}</mark>` : "") +
    escapeHtml(beforeStr.slice(beforeStr.length - s));
  const afterHtml =
    escapeHtml(afterStr.slice(0, p)) +
    (afterMid ? `<mark class="diff-hl diff-hl-new">${escapeHtml(afterMid)}</mark>` : "") +
    escapeHtml(afterStr.slice(afterStr.length - s));

  return { beforeHtml, afterHtml };
}

function buildDetailRows(rc) {
  const unknown = new Set(rc.unknown_after_apply || []);
  const rows = [];
  if (rc.action === "create") {
    for (const [k, v] of Object.entries(rc.after || {})) {
      if (unknown.has(k)) rows.push([k, escapeHtml("(known after apply)")]);
      else if (v !== null) rows.push([k, escapeHtml(formatAttrValue(v))]);
    }
  } else if (rc.action === "delete") {
    for (const [k, v] of Object.entries(rc.before || {})) {
      if (v !== null) rows.push([k, escapeHtml(formatAttrValue(v))]);
    }
  } else {
    // update / replace -- only the fields that actually changed
    for (const k of rc.changed_fields) {
      const beforeVal = unknown.has(k) ? "(known after apply)" : formatAttrValue((rc.before || {})[k]);
      const afterVal = unknown.has(k) ? "(known after apply)" : formatAttrValue((rc.after || {})[k]);
      const { beforeHtml, afterHtml } = highlightDiffPair(beforeVal, afterVal);
      rows.push([k, `${beforeHtml}  →  ${afterHtml}`]);
    }
  }
  return rows;
}

// ---------- log rendering (plain text + "Error:"/"Warning:" diagnostic cards) ----------
//
// terraform's own diagnostic format is already structured:
//   Error: <summary>
//
//     on main.tf line 179, in module "app_service":
//    179:   totally_fake_argument_for_error_demo = "this will fail on purpose"
//
//   An argument named "..." is not expected here.
// Parsed into cards instead of leaving the failure buried in a wall of
// monochrome log text. Falls back to plain text for anything that doesn't
// match this shape, so unrelated log content is never mangled.
const DIAG_RE = /^(Error|Warning): (.+)$/;
// When the error is inside a module call, terraform prefixes the location
// with an extra "  with module.foo[\"bar\"].some_resource.this," line before
// "on file line N" -- without consuming it, that line (and everything after
// it, since the location match then fails) fell through into plain detail
// text instead of getting the location/code styling.
const DIAG_WITH_RE = /^\s{2}with (.+),$/;
const DIAG_LOCATION_RE = /^\s{2}on (.+?) line (\d+)(?:, in (.+))?:$/;
const DIAG_CODE_RE = /^\s*(\d+):\s?(.*)$/;
// "Changes to Outputs:" is terraform's own mini-diff of output values
// (~ changed / + added / - removed, HCL-shaped, arbitrarily nested) --
// same idea as the diagnostic cards: color it like the symbols mean,
// instead of leaving it as a plain wall of text sitting right above them.
const OUTPUTS_HEADER_RE = /^Changes to Outputs:$/;
const OUTPUTS_LINE_RE = /^(\s*)([~+-])(.*)$/;

function parseLogBlocks(lines) {
  const blocks = [];
  let textBuf = [];
  const flushText = () => {
    if (textBuf.length) blocks.push({ type: "text", lines: textBuf });
    textBuf = [];
  };

  let i = 0;
  while (i < lines.length) {
    if (OUTPUTS_HEADER_RE.test(lines[i])) {
      flushText();
      i++;
      const outputLines = [];
      while (i < lines.length && lines[i] !== "") {
        outputLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: "outputs", lines: outputLines });
      continue;
    }
    const diagMatch = DIAG_RE.exec(lines[i]);
    if (!diagMatch) {
      textBuf.push(lines[i]);
      i++;
      continue;
    }
    flushText();
    const level = diagMatch[1].toLowerCase(); // "error" | "warning"
    const summary = diagMatch[2];
    i++;
    if (lines[i] === "") i++;

    // "with ..." always precedes "on file line N" when present, but only
    // actually consume it once we've confirmed the location line follows --
    // otherwise leave `i` untouched so it falls through to detail text
    // like any other unrecognized line, instead of silently vanishing.
    let withContext = null;
    const withMatch = i < lines.length ? DIAG_WITH_RE.exec(lines[i]) : null;
    const locMatch = i + (withMatch ? 1 : 0) < lines.length ? DIAG_LOCATION_RE.exec(lines[i + (withMatch ? 1 : 0)]) : null;

    let location = null;
    if (locMatch) {
      if (withMatch) {
        withContext = withMatch[1];
        i++;
      }
      location = { file: locMatch[1], line: locMatch[2], block: locMatch[3] || null, withContext };
      i++;
    }

    const codeLines = [];
    while (i < lines.length && DIAG_CODE_RE.test(lines[i])) {
      codeLines.push(lines[i]);
      i++;
    }
    if (lines[i] === "") i++;

    const detail = [];
    while (i < lines.length && lines[i] !== "" && !DIAG_RE.test(lines[i])) {
      detail.push(lines[i]);
      i++;
    }
    blocks.push({ type: "diagnostic", level, summary, location, codeLines, detail });
  }
  flushText();
  return blocks;
}

function renderDiagCodeLine(line) {
  const m = DIAG_CODE_RE.exec(line);
  if (!m) return `<span class="diag-code-line">${escapeHtml(line)}</span>`;
  return `<span class="diag-code-line"><span class="diag-code-lineno">${escapeHtml(m[1])}</span><span class="diag-code-src">${escapeHtml(m[2])}</span></span>`;
}

function renderOutputsLineHtml(line) {
  const m = OUTPUTS_LINE_RE.exec(line);
  if (!m) return `<span class="outputs-line">${escapeHtml(line)}</span>`;
  const [, indent, symbol, rest] = m;
  const kind = symbol === "~" ? "update" : symbol === "+" ? "create" : "delete";
  return `<span class="outputs-line ${kind}">${escapeHtml(indent)}<span class="outputs-symbol">${symbol}</span>${escapeHtml(rest)}</span>`;
}

function renderLogBlockHtml(block) {
  if (block.type === "text") {
    return `<span class="log-text">${escapeHtml(block.lines.join("\n"))}</span>`;
  }
  if (block.type === "outputs") {
    return `<div class="outputs-block"><div class="outputs-head">Changes to Outputs</div><div class="outputs-body">${block.lines
      .map(renderOutputsLineHtml)
      .join("\n")}</div></div>`;
  }
  const withHtml = block.location && block.location.withContext
    ? `<div class="diag-location">with <span class="diag-file">${escapeHtml(block.location.withContext)}</span></div>`
    : "";
  const locationHtml = block.location
    ? `${withHtml}<div class="diag-location">on <span class="diag-file">${escapeHtml(block.location.file)}</span> line ${escapeHtml(
        block.location.line
      )}${block.location.block ? `, in ${escapeHtml(block.location.block)}` : ""}</div>`
    : "";
  const codeHtml = block.codeLines.length
    ? `<div class="diag-code">${block.codeLines.map(renderDiagCodeLine).join("")}</div>`
    : "";
  const detailHtml = block.detail.length ? `<div class="diag-detail">${escapeHtml(block.detail.join("\n"))}</div>` : "";
  return `<div class="diag-block ${block.level}">
    <div class="diag-head"><span class="diag-icon">${block.level === "error" ? ICON_BLOCKED : ICON_WARNING}</span><span class="diag-title">${escapeHtml(
    block.summary
  )}</span></div>
    ${locationHtml}${codeHtml}${detailHtml}
  </div>`;
}

let logLines = [];

function renderLogView() {
  logEl.innerHTML = parseLogBlocks(logLines).map(renderLogBlockHtml).join("");
  logEl.scrollTop = logEl.scrollHeight;
}

function resetLogView() {
  logLines = [];
  logEl.innerHTML = "";
}

function setLogLines(lines) {
  logLines = lines.slice();
  renderLogView();
}

function appendLogLine(line) {
  logLines.push(line);
  renderLogView();
}

// Exactly one of raw log / plan-diff table / live progress checklist is ever
// shown at a time in the detail panel -- funnel that switch through here.
// Deliberately doesn't touch either toolbar's visibility: each toolbar (and
// the "Show raw log"/"Show table"/"Show progress" button living inside it)
// must stay visible across a log<->diff or log<->progress toggle, or
// toggling to raw log would hide the very button needed to toggle back.
// Toolbars are shown once by showPlanDiff/showProgressView when that view
// has something to show, and reset to hidden only when a new run is
// selected (see selectRun).
function setDetailView(mode) {
  logEl.classList.toggle("hidden", mode !== "log");
  planDiffContainerEl.classList.toggle("hidden", mode !== "diff");
  progressListEl.classList.toggle("hidden", mode !== "progress");
}

function setDiffRowExpanded(tr, detailTr, expand) {
  detailTr.classList.toggle("expanded", expand);
  tr.querySelector(".expand-caret").innerHTML = expand ? "&#9662;" : "&#9656;";
}

const btnToggleAllDiffEl = document.getElementById("btn-toggle-all-diff");
btnToggleAllDiffEl.onclick = () => {
  const expand = btnToggleAllDiffEl.textContent === "Expand all";
  for (const tr of planDiffTableBodyEl.querySelectorAll(".diff-row")) {
    setDiffRowExpanded(tr, tr.nextElementSibling, expand);
  }
  btnToggleAllDiffEl.textContent = expand ? "Collapse all" : "Expand all";
};

const diffFilterInputEl = document.getElementById("diff-filter-input");

function applyDiffFilter() {
  const q = diffFilterInputEl.value.trim().toLowerCase();
  for (const tr of planDiffTableBodyEl.querySelectorAll(".diff-row")) {
    const matches = !q || tr.querySelector(".resource-address").textContent.toLowerCase().includes(q);
    tr.classList.toggle("hidden", !matches);
    // keep the detail row's filtered-hidden state in lockstep with its
    // parent's -- previously this only ever ADDED hidden (on a non-match)
    // and never removed it again once the filter no longer excluded the
    // row, leaving it stuck hidden even after typing a matching query again
    tr.nextElementSibling.classList.toggle("hidden", !matches);
  }
}
diffFilterInputEl.addEventListener("input", applyDiffFilter);

// Deliberately does NOT touch setDetailView itself -- it used to switch to
// "log" immediately and only to "diff" after the plan-diff fetch resolved,
// which meant every click on a finished plan run flashed the raw log for a
// moment before the table swapped in. The caller now owns the "what do we
// show while this is loading" decision and only asks for "diff" once it's
// actually ready.
async function showPlanDiff(run) {
  if (run.kind !== "plan" || run.status !== "success") return false;

  try {
    const diff = await api(`/api/runs/${run.run_id}/plan-diff`);
    if (diff.total === 0) return false; // "No changes" -- raw log already says so, nothing to tabulate

    diffFilterInputEl.value = "";
    btnToggleAllDiffEl.textContent = "Expand all";
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
        <td class="resource-address">${escapeHtml(rc.address)}<button class="copy-address-btn" data-tip="Copy resource address" aria-label="Copy resource address">&#128203;</button></td>
        <td class="changed-fields">${escapeHtml(rc.changed_fields.join(", "))}</td>
      `;
      tr.querySelector(".copy-address-btn").onclick = async (ev) => {
        ev.stopPropagation(); // don't also toggle the row's expand/collapse
        try {
          await navigator.clipboard.writeText(rc.address);
          toast("Resource address copied.", { type: "success", duration: 2000 });
        } catch (e) {
          toast("Could not copy -- select and copy the address manually.", { type: "error" });
        }
      };

      // The <tr> itself always stays in normal flow (table rows can't
      // reliably transition height/display across browsers) -- expand/
      // collapse instead animates an inner <div> wrapper's max-height, so
      // it eases open/closed instead of the old instant show/hide.
      const detailRows = buildDetailRows(rc);
      const detailTr = document.createElement("tr");
      detailTr.className = "diff-detail-row";
      const detailTd = document.createElement("td");
      detailTd.colSpan = 3;
      const innerContent = detailRows.length
        ? `<table class="attr-table">${detailRows
            .map(([k, v]) => `<tr><td class="attr-key">${escapeHtml(k)}</td><td class="attr-val">${v}</td></tr>`)
            .join("")}</table>`
        : `<span class="muted">No attribute details available.</span>`;
      detailTd.innerHTML = `<div class="diff-detail-inner">${innerContent}</div>`;
      detailTr.appendChild(detailTd);

      tr.onclick = () => setDiffRowExpanded(tr, detailTr, !detailTr.classList.contains("expanded"));

      planDiffTableBodyEl.appendChild(tr);
      planDiffTableBodyEl.appendChild(detailTr);
    }

    setDetailView("diff");
    planViewToolbarEl.classList.remove("hidden");
    btnToggleRawLogEl.textContent = "Show raw log";
    return true;
  } catch (e) {
    // no .tfplan file (expired/restarted) or parse failure -- just keep showing the raw log
    return false;
  }
}

btnToggleRawLogEl.onclick = () => {
  const tableCurrentlyShown = !planDiffContainerEl.classList.contains("hidden");
  setDetailView(tableCurrentlyShown ? "log" : "diff");
  btnToggleRawLogEl.textContent = tableCurrentlyShown ? "Show table" : "Show raw log";
};

// ---------- live progress checklist (plan/apply) ----------
//
// terraform's own plain-text output already narrates per-resource progress
// ("aws_instance.foo: Creating...", "... Still creating... [10s elapsed]",
// "... Creation complete after 1m8s [id=...]") -- parsed client-side into a
// checklist instead of leaving the user to track dozens of interleaved
// "Still X... [Ns elapsed]" lines by eye while an apply runs.
// "Refreshing state..." (unlike "Creating...") always has "[id=...]" tacked
// onto the same line -- without the optional trailing group below, that
// suffix broke the `$` anchor and every refresh line (i.e. the entire
// running phase of a plan, before anything is created/changed) silently
// failed to parse, so the checklist never appeared until much later.
const RESOURCE_START_RE = /^(.+?): (Creating|Destroying|Modifying|Reading|Refreshing state)\.\.\.\s*(?:\[id=(.+)\])?$/;
// "Still modifying/destroying..." packs the resource's real id AND the
// elapsed time into the same bracket ("[id=/subscriptions/..., 00m10s
// elapsed]") -- unlike "Still creating..." which is just "[10s elapsed]".
// Without stripping the optional "id=..., " prefix, the whole (often very
// long) Azure resource id ended up rendered as the "elapsed" detail text.
const RESOURCE_STILL_RE = /^(.+?): Still (creating|destroying|modifying|reading|refreshing state)\.\.\. \[(?:id=.+?, )?(.+?) elapsed\]$/;
const RESOURCE_DONE_RE = /^(.+?): (.+?) complete after ([^[]+?)\s*(?:\[id=(.+)])?$/;

function progressActionKind(verb) {
  const v = verb.toLowerCase();
  if (v.startsWith("creat")) return "create";
  if (v.startsWith("destr")) return "destroy";
  if (v.startsWith("modif")) return "update";
  if (v.startsWith("read")) return "read";
  if (v.startsWith("refresh")) return "refresh";
  return "other";
}

function parseProgressLine(line) {
  let m = RESOURCE_DONE_RE.exec(line);
  if (m) return { address: m[1], kind: progressActionKind(m[2]), phase: "done", detail: m[3].trim() };
  m = RESOURCE_STILL_RE.exec(line);
  if (m) return { address: m[1], kind: progressActionKind(m[2]), phase: "progress", detail: m[3].trim() };
  m = RESOURCE_START_RE.exec(line);
  if (m) {
    const kind = progressActionKind(m[2]);
    // Unlike Creating/Destroying/Modifying/Reading, terraform never prints a
    // matching "... refresh complete" line for "Refreshing state..." -- the
    // one line (already carrying the resource's id) IS the complete event.
    // Treating it as a "start" that some later line would finish left every
    // refreshed resource stuck at "starting..." forever, even on a
    // long-finished successful run.
    if (kind === "refresh") return { address: m[1], kind, phase: "done", detail: "" };
    return { address: m[1], kind, phase: "start" };
  }
  return null;
}

let currentProgress = new Map(); // address -> {address, kind, phase, detail} -- insertion order == first-seen order

function resetProgress() {
  currentProgress = new Map();
  progressListEl.innerHTML = "";
}

// Returns true if this line was a resource-progress line (caller uses that
// to know whether a re-render/auto-reveal is worth doing).
function ingestProgressLine(line) {
  const parsed = parseProgressLine(line);
  if (!parsed) return false;
  const entry = currentProgress.get(parsed.address) || { address: parsed.address };
  entry.kind = parsed.kind;
  if (parsed.phase === "done") {
    entry.phase = "done";
    entry.detail = parsed.detail;
  } else if (entry.phase !== "done") {
    entry.phase = "progress";
    if (parsed.phase === "progress") entry.detail = parsed.detail;
  }
  currentProgress.set(parsed.address, entry);
  return true;
}

function ingestProgressLines(lines) {
  let any = false;
  for (const line of lines) any = ingestProgressLine(line) || any;
  return any;
}

const PROGRESS_KIND_LABEL = { create: "create", update: "update", destroy: "destroy", read: "read", refresh: "refresh", other: "other" };

function progressRowHtml(e) {
  const done = e.phase === "done";
  const detailText = done ? (e.detail ? `done in ${e.detail}` : "done") : e.detail ? `${e.detail} elapsed` : "starting…";
  return `<li class="progress-row ${done ? "done" : "running"} kind-${e.kind}">
    <span class="progress-icon">${done ? ICON_CHECK : ""}</span>
    <span class="progress-address">${escapeHtml(e.address)}</span>
    <span class="action-badge ${e.kind}">${PROGRESS_KIND_LABEL[e.kind] || e.kind}</span>
    <span class="progress-detail muted">${escapeHtml(detailText)}</span>
  </li>`;
}

function renderProgressList() {
  const entries = [...currentProgress.values()];
  progressListEl.innerHTML = entries.map(progressRowHtml).join("");
  const done = entries.filter((e) => e.phase === "done").length;
  progressCountsEl.textContent = entries.length
    ? `${done} / ${entries.length} resource action${entries.length === 1 ? "" : "s"} finished`
    : "";
}

function showProgressView() {
  renderProgressList();
  setDetailView("progress");
  progressToolbarEl.classList.remove("hidden");
  btnToggleProgressLogEl.textContent = "Show raw log";
}

btnToggleProgressLogEl.onclick = () => {
  const progressCurrentlyShown = !progressListEl.classList.contains("hidden");
  setDetailView(progressCurrentlyShown ? "log" : "progress");
  btnToggleProgressLogEl.textContent = progressCurrentlyShown ? "Show progress" : "Show raw log";
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
  resetLogView();
  resetProgress();
  setDetailView("log");
  planViewToolbarEl.classList.add("hidden");
  progressToolbarEl.classList.add("hidden");
  if (currentEventSource) {
    currentEventSource.close();
    currentEventSource = null;
  }

  const detail = await api(`/api/runs/${runId}`);
  runTitleEl.textContent = detail.name
    ? `${detail.kind.toUpperCase()} "${detail.name}"`
    : `${detail.kind.toUpperCase()} — ${runId.slice(0, 8)}`;
  setRunStatus(detail.status);
  refreshRunsList();

  const showsProgress = detail.kind === "plan" || detail.kind === "apply";

  if (detail.status === "success" || detail.status === "failed") {
    // hadProgress only needs detail.lines already in hand -- no fetch
    // involved, so computing it doesn't cost a visible frame.
    const hadProgress = showsProgress && ingestProgressLines(detail.lines);

    // Only default to the progress checklist for a SUCCESSFUL run -- it only
    // ever shows completed create/update/destroy/read/refresh actions, never
    // the failure itself (many failures, like this schema-validation error,
    // aren't tied to any resource action at all), so defaulting to it on a
    // failed run hid the one thing you actually opened this run to see
    // behind an unlabeled extra click.
    if (detail.kind === "plan") {
      showPlanSummary(detail);
      // Don't paint the raw log while the plan-diff fetch is in flight --
      // that used to flash the raw terraform output for a moment before the
      // table swapped in on every click. Show a lightweight placeholder
      // instead, and only fall back to the real log if there's no diff to
      // show after all.
      logEl.innerHTML = `<div class="detail-loading">Loading…</div>`;
      setDetailView("log");
      const diffShown = await showPlanDiff(detail);
      if (!diffShown) {
        setLogLines(detail.lines);
        if (hadProgress && detail.status === "success") showProgressView();
      }
    } else if (detail.kind === "apply" && hadProgress && detail.status === "success") {
      setLogLines(detail.lines);
      showProgressView();
    } else {
      setLogLines(detail.lines);
      setDetailView("log");
    }
    if (detail.kind === "init") await refreshCurrentProjectInitState();
    return;
  }

  // Log content comes entirely from the stream below, not from `detail.lines`
  // here -- the server's subscribe() replays this run's full history into
  // the SSE stream before any live tail, so pre-filling it from this GET too
  // would show every line so far twice.
  const es = new EventSource(`/api/runs/${runId}/stream`);
  currentEventSource = es;
  let autoShownProgress = false;
  es.onmessage = (ev) => {
    appendLogLine(ev.data);
    if (!showsProgress || !ingestProgressLine(ev.data)) return;
    if (!autoShownProgress) {
      autoShownProgress = true;
      showProgressView();
    } else if (!progressListEl.classList.contains("hidden")) {
      renderProgressList();
    }
  };
  es.addEventListener("done", async () => {
    es.close();
    const finalDetail = await api(`/api/runs/${runId}`);
    setRunStatus(finalDetail.status);
    refreshRunsList();
    if (finalDetail.kind === "plan") {
      showPlanSummary(finalDetail);
      const diffShown = await showPlanDiff(finalDetail);
      if (!diffShown && currentProgress.size > 0 && finalDetail.status === "success") showProgressView();
    } else if (finalDetail.kind === "apply") {
      // A failed apply may have already auto-shown the live progress
      // checklist while it was still running (es.onmessage, above) --
      // switch back to the log/diagnostic-card view now that it's finished
      // and failed, since the checklist alone never shows why.
      if (currentProgress.size > 0 && finalDetail.status === "success") showProgressView();
      else if (finalDetail.status !== "success") setDetailView("log");
    }
    if (finalDetail.kind === "init") await refreshCurrentProjectInitState();
  });
}

async function runInit() {
  // The auth pill only reflects whatever was true when the workspace was
  // opened -- re-check now so a login/logout in another window shows up
  // before init runs, not just after it fails.
  refreshAuthPill(currentProject.id);
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

// ---------- tfvars pretty-config viewer ----------

const btnViewTfvarsEl = document.getElementById("btn-view-tfvars");
const tfvarsModalEl = document.getElementById("tfvars-modal");
const tfvarsPathEl = document.getElementById("tfvars-path");
const tfvarsToolbarEl = document.getElementById("tfvars-toolbar");
const btnToggleTfvarsRawEl = document.getElementById("btn-toggle-tfvars-raw");
const tfvarsErrorEl = document.getElementById("tfvars-error");
const tfvarsTreeEl = document.getElementById("tfvars-tree");
const tfvarsRawEl = document.getElementById("tfvars-raw");

function tfvarsPrimitiveHtml(value) {
  if (value === null) return `<span class="tfv-null">null</span>`;
  if (typeof value === "object" && "__ref__" in value) return `<span class="tfv-ref">${escapeHtml(value.__ref__)}</span>`;
  if (typeof value === "string") return `<span class="tfv-string">"${escapeHtml(value)}"</span>`;
  if (typeof value === "number") return `<span class="tfv-number">${value}</span>`;
  if (typeof value === "boolean") return `<span class="tfv-bool">${value}</span>`;
  return escapeHtml(String(value));
}

// Renders one key: value pair -- a plain row for a leaf (string/number/
// bool/null), or a collapsible <details> node for a non-empty list/map (an
// empty one still renders as a single leaf-like row, e.g. "tags = {}", since
// there's nothing to expand into).
function renderTfvarsEntry(key, value) {
  const isRef = value !== null && typeof value === "object" && "__ref__" in value;

  if (!isRef && Array.isArray(value)) {
    if (!value.length) return `<div class="tfv-row"><span class="tfv-key">${escapeHtml(key)}</span><span class="tfv-eq">=</span><span class="tfv-type">list · empty</span></div>`;
    const children = value.map((item, i) => renderTfvarsEntry(`[${i}]`, item)).join("");
    return `<details class="tfv-node"><summary><span class="tfv-key">${escapeHtml(key)}</span><span class="tfv-type">list · ${value.length}</span></summary><div class="tfv-children">${children}</div></details>`;
  }

  if (!isRef && value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (!keys.length) return `<div class="tfv-row"><span class="tfv-key">${escapeHtml(key)}</span><span class="tfv-eq">=</span><span class="tfv-type">map · empty</span></div>`;
    const children = keys.map((k) => renderTfvarsEntry(k, value[k])).join("");
    return `<details class="tfv-node"><summary><span class="tfv-key">${escapeHtml(key)}</span><span class="tfv-type">map · ${keys.length} key${keys.length === 1 ? "" : "s"}</span></summary><div class="tfv-children">${children}</div></details>`;
  }

  return `<div class="tfv-row"><span class="tfv-key">${escapeHtml(key)}</span><span class="tfv-eq">=</span>${tfvarsPrimitiveHtml(value)}</div>`;
}

function setTfvarsView(mode) {
  tfvarsTreeEl.classList.toggle("hidden", mode !== "tree");
  tfvarsRawEl.classList.toggle("hidden", mode !== "raw");
  btnToggleTfvarsRawEl.textContent = mode === "raw" ? "Show tree" : "Show raw file";
}

let tfvarsPollTimer = null;
let tfvarsLastRaw = null; // last-seen raw file content -- lets a silent poll skip re-rendering (and losing expanded-node/scroll state) when nothing actually changed
let tfvarsMode = "tree";

// `silent: true` is a background poll tick -- must never clobber the modal
// with an error toast/state over a transient failure (e.g. the file
// briefly locked while a text editor is saving it); a manual open (silent:
// false) does show the error, since that's a real "click and see" moment.
async function loadTfvars({ silent = false } = {}) {
  try {
    const result = await api(`/api/projects/${currentProject.id}/tfvars`);
    if (silent && result.raw === tfvarsLastRaw) return; // unchanged -- don't disturb anything
    const changed = tfvarsLastRaw !== null && result.raw !== tfvarsLastRaw;
    tfvarsLastRaw = result.raw;

    tfvarsPathEl.textContent = result.relative_path;
    tfvarsRawEl.textContent = result.raw;
    tfvarsErrorEl.classList.add("hidden");

    if (result.parsed) {
      const keys = Object.keys(result.parsed);
      tfvarsTreeEl.innerHTML = keys.length
        ? keys.map((k) => renderTfvarsEntry(k, result.parsed[k])).join("")
        : `<p class="muted">This file has no variable assignments.</p>`;
      tfvarsToolbarEl.classList.remove("hidden");
      setTfvarsView(tfvarsMode);
    } else {
      tfvarsErrorEl.textContent = `Could not parse this file as simple key/value tfvars (${result.parse_error}) -- showing the raw file instead.`;
      tfvarsErrorEl.classList.remove("hidden");
      tfvarsMode = "raw";
      setTfvarsView("raw");
    }
    if (changed) toast("tfvars file changed on disk -- config view refreshed.", { type: "info", duration: 3000 });
  } catch (e) {
    if (!silent) {
      tfvarsErrorEl.textContent = e.message;
      tfvarsErrorEl.classList.remove("hidden");
      setTfvarsView("raw");
    }
  }
}

btnViewTfvarsEl.onclick = async () => {
  tfvarsErrorEl.classList.add("hidden");
  tfvarsToolbarEl.classList.add("hidden");
  tfvarsTreeEl.innerHTML = "";
  tfvarsRawEl.textContent = "";
  tfvarsPathEl.textContent = "";
  tfvarsLastRaw = null;
  tfvarsMode = "tree";
  openModal(tfvarsModalEl);
  await loadTfvars();

  // Poll while the modal stays open so edits made outside the dashboard
  // (in an editor, or by Format) show up here without needing to close and
  // reopen it. Self-terminates by checking modalOverlayEl (not
  // tfvarsModalEl) each tick -- closeModals() only ever hides the shared
  // overlay, never the individual .modal div itself (only the NEXT
  // openModal() call re-hides every .modal before showing its target), so
  // checking tfvarsModalEl's own "hidden" class would never see it as
  // closed until some other modal happened to be opened later, leaving
  // this polling forever in the meantime.
  if (tfvarsPollTimer) clearInterval(tfvarsPollTimer);
  tfvarsPollTimer = setInterval(() => {
    if (modalOverlayEl.classList.contains("hidden")) {
      clearInterval(tfvarsPollTimer);
      tfvarsPollTimer = null;
      return;
    }
    loadTfvars({ silent: true });
  }, 2000);
};

btnToggleTfvarsRawEl.onclick = () => {
  tfvarsMode = tfvarsRawEl.classList.contains("hidden") ? "raw" : "tree";
  setTfvarsView(tfvarsMode);
};

// ---------- state resource browser ----------

const btnViewStateEl = document.getElementById("btn-view-state");
const stateModalEl = document.getElementById("state-modal");
const stateSummaryEl = document.getElementById("state-summary");
const stateFilterInputEl = document.getElementById("state-filter-input");
const stateErrorEl = document.getElementById("state-error");
const stateListEl = document.getElementById("state-list");

let allStateResources = [];
// Detail fetches are cached per address for the lifetime of one modal open --
// re-opening a resource you already expanded shouldn't re-hit terraform show.
let stateDetailCache = {};

function stateResourceRowHtml(r) {
  const highlightsHtml = r.highlights
    .map(([k, v]) => `<span class="state-highlight-chip"><span class="state-highlight-key">${escapeHtml(k)}</span>${escapeHtml(v)}</span>`)
    .join("");
  return `
    <button class="state-row" data-address="${escapeHtml(r.address)}">
      <div class="state-row-main">
        <span class="state-row-type">${escapeHtml(r.type)}</span>
        <span class="state-row-name">${escapeHtml(r.display_name)}</span>
        ${r.module !== "(root)" ? `<span class="state-row-module">${escapeHtml(r.module)}</span>` : ""}
      </div>
      <div class="state-row-address">${escapeHtml(r.address)}</div>
      ${highlightsHtml ? `<div class="state-row-highlights">${highlightsHtml}</div>` : ""}
    </button>
    <div class="state-detail-row" data-address="${escapeHtml(r.address)}">
      <div class="state-detail-inner"></div>
    </div>`;
}

function renderStateList(resources) {
  stateListEl.innerHTML = resources.length
    ? resources.map(stateResourceRowHtml).join("")
    : `<p class="muted">No resources match this filter.</p>`;

  stateListEl.querySelectorAll(".state-row").forEach((btn) => {
    btn.onclick = () => toggleStateDetail(btn);
  });
}

async function toggleStateDetail(btn) {
  const address = btn.dataset.address;
  const detailRow = stateListEl.querySelector(`.state-detail-row[data-address="${CSS.escape(address)}"]`);
  const opening = !detailRow.classList.contains("expanded");
  detailRow.classList.toggle("expanded", opening);
  btn.classList.toggle("expanded", opening);
  if (!opening) return;

  const inner = detailRow.querySelector(".state-detail-inner");
  if (stateDetailCache[address]) {
    inner.innerHTML = stateDetailCache[address];
    return;
  }
  inner.innerHTML = `<span class="muted">Loading…</span>`;
  try {
    const detail = await api(`/api/projects/${currentProject.id}/state/resource?address=${encodeURIComponent(address)}`);
    const keys = Object.keys(detail.values || {});
    const html = keys.length
      ? `<table class="attr-table">${keys
          .map((k) => `<tr><td class="attr-key">${escapeHtml(k)}</td><td class="attr-val">${escapeHtml(formatAttrValue(detail.values[k]))}</td></tr>`)
          .join("")}</table>`
      : `<span class="muted">No attributes.</span>`;
    stateDetailCache[address] = html;
    inner.innerHTML = html;
  } catch (e) {
    inner.innerHTML = `<span class="muted">Could not load details: ${escapeHtml(e.message)}</span>`;
  }
}

function applyStateFilter() {
  const q = stateFilterInputEl.value.trim().toLowerCase();
  const filtered = q
    ? allStateResources.filter(
        (r) => r.address.toLowerCase().includes(q) || r.type.toLowerCase().includes(q) || r.display_name.toLowerCase().includes(q)
      )
    : allStateResources;
  renderStateList(filtered);
}
stateFilterInputEl.addEventListener("input", applyStateFilter);

btnViewStateEl.onclick = async () => {
  stateErrorEl.classList.add("hidden");
  stateFilterInputEl.value = "";
  stateSummaryEl.textContent = "";
  stateListEl.innerHTML = `<p class="muted">Loading…</p>`;
  stateDetailCache = {};
  allStateResources = [];
  openModal(stateModalEl);

  try {
    allStateResources = await api(`/api/projects/${currentProject.id}/state/resources`);
    stateSummaryEl.textContent = allStateResources.length
      ? `${allStateResources.length} resource${allStateResources.length === 1 ? "" : "s"} in state.`
      : "Nothing in state yet -- run apply first.";
    renderStateList(allStateResources);
  } catch (e) {
    stateErrorEl.textContent = e.message;
    stateErrorEl.classList.remove("hidden");
    stateListEl.innerHTML = "";
  }
};

// ---------- module & provider source explorer ----------

const btnViewSourcesEl = document.getElementById("btn-view-sources");
const sourcesModalEl = document.getElementById("sources-modal");
const sourcesErrorEl = document.getElementById("sources-error");
const sourcesModulesListEl = document.getElementById("sources-modules-list");
const sourcesProvidersListEl = document.getElementById("sources-providers-list");

function moduleRowHtml(m) {
  return `
    <div class="source-row">
      <span class="source-row-name">${escapeHtml(m.name)}</span>
      <span class="source-row-source">${escapeHtml(m.source)}</span>
      <span class="source-row-version">${m.version ? escapeHtml(m.version) : `<span class="muted">unpinned</span>`}</span>
      <span class="source-row-file">${escapeHtml(m.file)}</span>
    </div>`;
}

function providerRowHtml(p) {
  return `
    <div class="source-row">
      <span class="source-row-name">${escapeHtml(p.name)}</span>
      <span class="source-row-source">${p.source ? escapeHtml(p.source) : `<span class="muted">-</span>`}</span>
      <span class="source-row-version">${p.version_constraint ? escapeHtml(p.version_constraint) : `<span class="muted">unconstrained</span>`}</span>
      <span class="source-row-file">${escapeHtml(p.file)}</span>
    </div>`;
}

btnViewSourcesEl.onclick = async () => {
  sourcesErrorEl.classList.add("hidden");
  sourcesModulesListEl.innerHTML = `<p class="muted">Loading…</p>`;
  sourcesProvidersListEl.innerHTML = "";
  openModal(sourcesModalEl);

  try {
    const { modules, providers } = await api(`/api/projects/${currentProject.id}/sources`);
    sourcesModulesListEl.innerHTML = modules.length
      ? modules.map(moduleRowHtml).join("")
      : `<p class="muted">No module blocks found in this deployment's .tf files.</p>`;
    sourcesProvidersListEl.innerHTML = providers.length
      ? providers.map(providerRowHtml).join("")
      : `<p class="muted">No required_providers block found.</p>`;
  } catch (e) {
    sourcesErrorEl.textContent = e.message;
    sourcesErrorEl.classList.remove("hidden");
    sourcesModulesListEl.innerHTML = "";
  }
};

// ---------- dependency graph (its own tab, same pattern as the editor) ----------

const btnViewGraphEl = document.getElementById("btn-view-graph");
const graphProjectNameEl = document.getElementById("graph-project-name");
const graphErrorEl = document.getElementById("graph-error");
const graphLegendEl = document.getElementById("graph-legend");
const graphContainerEl = document.getElementById("graph-container");
const chkGraphGroupModulesEl = document.getElementById("chk-graph-group-modules");
const graphDetailEmptyEl = document.getElementById("graph-detail-empty");
const graphDetailContentEl = document.getElementById("graph-detail-content");
const graphDetailTitleEl = document.getElementById("graph-detail-title");
const graphDependsOnListEl = document.getElementById("graph-depends-on-list");
const graphUsedByListEl = document.getElementById("graph-used-by-list");
const btnCloseGraphDetailEl = document.getElementById("btn-close-graph-detail");

// address -> [addresses it depends on] / [addresses that depend on it] --
// rebuilt from the edge list every time the graph reloads (initial load or
// the "Group by module" toggle), since a collapsed module id isn't the
// same node space as the per-resource view.
let graphDependsOn = new Map();
let graphUsedBy = new Map();
let graphSelectedNode = null;

function buildGraphDependencyMaps(edges) {
  graphDependsOn = new Map();
  graphUsedBy = new Map();
  for (const [from, to] of edges) {
    if (!graphDependsOn.has(from)) graphDependsOn.set(from, []);
    graphDependsOn.get(from).push(to);
    if (!graphUsedBy.has(to)) graphUsedBy.set(to, []);
    graphUsedBy.get(to).push(from);
  }
}

// Mirrors run_manager.py's _GRAPH_CATEGORY_STYLES -- just the "color" value
// from each category, purely for the legend key. The actual SVG arrives
// already colored from the server; this only has to LABEL what each color
// means, not reproduce the styling logic itself.
const GRAPH_LEGEND = [
  ["Data source", "#64748b"],
  ["Identity / role assignment", "#10b981"],
  ["Network", "#a78bfa"],
  ["Storage / data store", "#60a5fa"],
  ["Compute / AI", "#fbbf24"],
  ["Utility (time_static, etc.)", "#f472b6"],
  ["Other resource", "#94a3b8"],
];

async function showDependencyGraph(project, { pushHistory = true } = {}) {
  // Each of the editor/graph/workspace views opens in its own tab, so
  // there's no cross-tab conflict in reusing the same global the workspace
  // itself uses -- and the Back button's openWorkspace(currentProject)
  // call needs this set, the same way openWorkspace sets it for itself.
  currentProject = project;
  revealView(graphViewEl);
  hideBgParticles();
  renderBreadcrumb([
    { label: "IaC-Dashboard", onClick: showLanding },
    { label: currentOrg.name, onClick: () => showOrgView(currentOrg) },
    { label: project.name, onClick: () => openWorkspace(project) },
    { label: "Dependency Graph" },
  ]);
  btnBackEl.classList.remove("hidden");
  btnBackEl.textContent = "←";
  graphProjectNameEl.textContent = project.name;
  graphLegendEl.innerHTML = GRAPH_LEGEND.map(
    ([label, color]) =>
      `<span class="graph-legend-chip"><span class="graph-legend-dot" style="background:${color}"></span>${escapeHtml(label)}</span>`
  ).join("");
  document.title = `Graph — ${project.name} — IaC-Dashboard`;
  chkGraphGroupModulesEl.checked = false;

  if (pushHistory) {
    const url = `/graph/${encodeURIComponent(currentOrg.name)}/${encodeURIComponent(project.name)}`;
    if (location.pathname !== url) history.pushState({}, "", url);
  }

  await loadGraphSvg();
}

// Re-fetches whenever the "Group by module" toggle changes, not just on
// the initial view load -- the edge list drives the click-to-inspect
// panel, so it has to be rebuilt every time right alongside the SVG.
async function loadGraphSvg() {
  graphErrorEl.classList.add("hidden");
  graphContainerEl.innerHTML = `<p class="muted">Loading…</p>`;
  closeGraphDetail();
  const query = chkGraphGroupModulesEl.checked ? "?group=modules" : "";
  try {
    const data = await api(`/api/projects/${currentProject.id}/dependency-graph${query}`);
    graphContainerEl.innerHTML = data.svg;
    buildGraphDependencyMaps(data.edges);
  } catch (e) {
    graphErrorEl.textContent = e.message;
    graphErrorEl.classList.remove("hidden");
    graphContainerEl.innerHTML = "";
    buildGraphDependencyMaps([]);
  }
}
chkGraphGroupModulesEl.onchange = loadGraphSvg;

function graphDetailListHtml(addresses) {
  if (!addresses || !addresses.length) return `<li class="graph-detail-empty-msg">none</li>`;
  return addresses
    .map((addr) => `<li><button class="graph-detail-item" data-node="${escapeHtml(addr)}">${escapeHtml(addr)}</button></li>`)
    .join("");
}

function selectGraphNode(nodeId) {
  graphSelectedNode = nodeId;
  graphDetailEmptyEl.classList.add("hidden");
  graphDetailContentEl.classList.remove("hidden");
  graphDetailTitleEl.textContent = nodeId;
  graphDependsOnListEl.innerHTML = graphDetailListHtml(graphDependsOn.get(nodeId));
  graphUsedByListEl.innerHTML = graphDetailListHtml(graphUsedBy.get(nodeId));

  // Highlight the selected node and dim everything else, so the "what
  // connects to what" answer in the panel has an obvious visual anchor
  // back in the graph itself, not just a text list floating next to it.
  for (const nodeEl of graphContainerEl.querySelectorAll(".node")) {
    const title = nodeEl.querySelector("title")?.textContent;
    nodeEl.classList.toggle("graph-node-selected", title === nodeId);
    nodeEl.classList.toggle("graph-node-dimmed", title !== nodeId);
  }
}

function closeGraphDetail() {
  graphSelectedNode = null;
  graphDetailContentEl.classList.add("hidden");
  graphDetailEmptyEl.classList.remove("hidden");
  for (const nodeEl of graphContainerEl.querySelectorAll(".node")) {
    nodeEl.classList.remove("graph-node-selected", "graph-node-dimmed");
  }
}
btnCloseGraphDetailEl.onclick = closeGraphDetail;

// Delegated rather than per-node: the SVG (and every .node inside it) gets
// replaced wholesale on every load/toggle, so listeners attached directly
// to nodes would just be thrown away each time.
graphContainerEl.addEventListener("click", (ev) => {
  const nodeEl = ev.target.closest(".node");
  if (!nodeEl) return;
  const title = nodeEl.querySelector("title")?.textContent;
  if (title) selectGraphNode(title);
});
document.getElementById("graph-detail-content").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".graph-detail-item");
  if (btn) selectGraphNode(btn.dataset.node);
});

btnViewGraphEl.onclick = () => {
  const url = `/graph/${encodeURIComponent(currentOrg.name)}/${encodeURIComponent(currentProject.name)}`;
  window.open(url, "_blank");
};

// ---------- restart server ----------
// Called from the header dropdown menu (see "header menu" below).

async function restartServer() {
  let activeCount = 0;
  try {
    ({ count: activeCount } = await api("/api/server/active-runs"));
  } catch (e) {
    // if this check itself fails the server is already in trouble -- fall through to the confirm dialog anyway
  }

  const ok = await confirmDialog(
    (activeCount > 0
      ? `This will interrupt ${activeCount} run${activeCount === 1 ? "" : "s"} currently in progress (for any project, not just this one). `
      : "") +
      "The whole dashboard process will restart (stop.ps1 then start.ps1) -- it'll be unreachable for a few seconds, then this page will reload itself.",
    { title: "Restart the dashboard server?", okLabel: "Restart", danger: true }
  );
  if (!ok) return;

  try {
    await api("/api/server/restart", { method: "POST" });
  } catch (e) {
    toast(`Could not start restart: ${e.message}`, { type: "error" });
    return;
  }
  toast("Restarting -- this page will reload automatically once the server is back.", { type: "warning", duration: 8000 });

  // Poll for the server coming back up, then reload for a clean state
  // (rather than trying to re-sync every in-memory view/modal by hand).
  const pollUntilBack = async () => {
    for (let i = 0; i < 30; i++) {
      await new Promise((res) => setTimeout(res, 1000));
      try {
        const res = await fetch("/api/organizations", { cache: "no-store" });
        if (res.ok) {
          location.reload();
          return;
        }
      } catch (e) {
        // still down -- keep polling
      }
    }
  };
  pollUntilBack();
}

// ---------- open in VS Code ----------

function openFileEditorInNewTab() {
  const url = `/editor/${encodeURIComponent(currentOrg.name)}/${encodeURIComponent(currentProject.name)}`;
  window.open(url, "_blank");
}

btnOpenVscodeEl.onclick = async () => {
  const originalText = btnOpenVscodeEl.textContent;
  btnOpenVscodeEl.disabled = true;
  btnOpenVscodeEl.textContent = "Opening…";
  try {
    await api(`/api/projects/${currentProject.id}/open-vscode`, { method: "POST" });
  } catch (e) {
    // VS Code isn't guaranteed to be installed/on PATH on this machine
    // (see open_in_vscode in run_manager.py) -- rather than leave you with
    // just an error and no way to actually edit the files, fall back to
    // the editor this dashboard already has built in.
    toast(`Could not open VS Code (${e.message}) -- opening the in-app editor instead.`, {
      type: "error",
      duration: 7000,
    });
    openFileEditorInNewTab();
  } finally {
    btnOpenVscodeEl.disabled = false;
    btnOpenVscodeEl.textContent = originalText;
  }
};

btnOpenEditorEl.onclick = openFileEditorInNewTab;

// ---------- in-app file editor (Monaco) ----------
//
// Opens in its own browser tab (see the /editor/<org>/<project> route in
// restoreFromLocation above) rather than as another view swapped into the
// current tab -- editing is a separate, longer-lived task from watching a
// run, and a second tab means you can keep both on screen instead of
// bouncing back and forth. That tab is still the exact same SPA; it just
// boots straight into showFileEditor() instead of the landing page.

const editorProjectNameEl = document.getElementById("editor-project-name");
const editorFilePathEl = document.getElementById("editor-file-path");
const editorDirtyBadgeEl = document.getElementById("editor-dirty-badge");
const editorBlockedBadgeEl = document.getElementById("editor-blocked-badge");
const btnSaveFileEl = document.getElementById("btn-save-file");
const editorFileFilterEl = document.getElementById("editor-file-filter");
const editorFileTreeListEl = document.getElementById("editor-file-tree-list");
const editorEmptyStateEl = document.getElementById("editor-empty-state");
const monacoContainerEl = document.getElementById("monaco-container");

let editorProject = null;
let editorFiles = [];
let editorModels = new Map(); // path -> {model, originalContent}
let editorCurrentPath = null;
let monacoLoadPromise = null;

// The AMD loader + editor core is ~24MB vendored under static/vendor/monaco
// (see server.py's /vendor/{filepath:path} route) -- loaded lazily, once,
// only when the editor is actually opened, so every OTHER page load isn't
// paying for it.
function loadMonaco() {
  if (monacoLoadPromise) return monacoLoadPromise;
  monacoLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/monaco/vs/loader.js";
    script.onload = () => {
      window.require.config({ paths: { vs: "/vendor/monaco/vs" } });
      window.require(["vs/editor/editor.main"], () => resolve(window.monaco), reject);
    };
    script.onerror = () => reject(new Error("could not load the editor (static/vendor/monaco missing?)"));
    document.head.appendChild(script);
  });
  return monacoLoadPromise;
}

function guessMonacoLanguage(path) {
  const ext = path.split(".").pop().toLowerCase();
  if (["tf", "tfvars", "tfbackend", "hcl"].includes(ext)) return "hcl";
  if (ext === "json") return "json";
  if (ext === "md") return "markdown";
  if (ext === "yaml" || ext === "yml") return "yaml";
  return "plaintext";
}

function isEditorPathDirty(path) {
  const s = editorModels.get(path);
  return !!s && s.model.getValue() !== s.originalContent;
}

// Once a file's opened, its content lived only in the in-memory Monaco
// model -- an edit made outside the dashboard (another editor, git, a
// terraform fmt run) never showed up until the whole tab reloaded. This
// pulls the on-disk content back in, but only when there are no local
// unsaved edits to clobber; if the model is dirty, an external change is
// silently ignored here (Save will still overwrite it, same as any editor).
async function refreshEditorFileIfUnchangedLocally(path, { toastOnChange = false } = {}) {
  const state = editorModels.get(path);
  if (!state || state.model.getValue() !== state.originalContent) return;

  let data;
  try {
    data = await api(`/api/projects/${editorProject.id}/file?path=${encodeURIComponent(path)}`);
  } catch (e) {
    return; // transient (e.g. file briefly locked while something else saves it) -- next tick will retry
  }
  if (data.content === state.originalContent) return;

  const isActive = path === editorCurrentPath;
  const viewState = isActive && monacoEditorInstance ? monacoEditorInstance.saveViewState() : null;
  // originalContent MUST be updated before setValue, not after: setValue
  // fires onDidChangeModelContent synchronously, and that handler reads
  // originalContent to decide dirtiness -- updating it afterward meant the
  // dirty badge saw (new model value) !== (still-old originalContent) at
  // the instant the event fired, latched "unsaved changes" on, and nothing
  // ever re-checked it afterward to clear it, even though the two values
  // were actually equal again a line later.
  state.originalContent = data.content;
  state.model.setValue(data.content);
  if (isActive && monacoEditorInstance && viewState) monacoEditorInstance.restoreViewState(viewState);
  if (toastOnChange) toast(`${path} changed on disk -- reloaded.`, { type: "info", duration: 3500 });
}

let editorPollTimer = null;

function startEditorPoll() {
  stopEditorPoll();
  editorPollTimer = setInterval(() => {
    if (editorCurrentPath) refreshEditorFileIfUnchangedLocally(editorCurrentPath, { toastOnChange: true });
  }, 3000);
}

function stopEditorPoll() {
  if (editorPollTimer) {
    clearInterval(editorPollTimer);
    editorPollTimer = null;
  }
}

function hasAnyUnsavedEditorChanges() {
  return [...editorModels.keys()].some(isEditorPathDirty);
}

function updateEditorDirtyState() {
  const dirty = editorCurrentPath !== null && isEditorPathDirty(editorCurrentPath);
  editorDirtyBadgeEl.classList.toggle("hidden", !dirty);
  btnSaveFileEl.disabled = editorCurrentPath === null;
}

// Builds a real nested {name, type, children|entry} tree from the flat
// /files listing, folders-before-files then alphabetical at each level --
// only used when there's no filter text (see renderEditorFileTree), since
// filtering a tree in place means re-expanding every ancestor of a match,
// and a flat "path contains query" list finds the same file just as fast.
function buildEditorFileTree(entries) {
  const root = { name: "", type: "dir", children: new Map() };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    parts.forEach((name, i) => {
      if (i === parts.length - 1) {
        node.children.set(name, { name, type: "file", entry });
        return;
      }
      if (!node.children.has(name)) node.children.set(name, { name, type: "dir", children: new Map() });
      node = node.children.get(name);
    });
  }
  return root;
}

const EDITOR_ICON_EXTS = new Set(["tf", "tfvars", "tfbackend", "hcl", "json", "yaml", "yml", "md", "txt"]);

function editorFileIconHtml(path) {
  const ext = path.split(".").pop().toLowerCase();
  const cls = EDITOR_ICON_EXTS.has(ext) ? ext : "other";
  return `<span class="file-icon ext-${cls}"></span>`;
}

function editorFileRowHtml(entry, label) {
  const classes = ["editor-file-row"];
  if (!entry.editable) classes.push("unsupported");
  if (entry.path === editorCurrentPath) classes.push("active");
  if (isEditorPathDirty(entry.path)) classes.push("file-dirty");
  const tip = entry.editable ? "" : ` data-tip="This file type isn't editable here"`;
  return `<button class="${classes.join(" ")}" data-path="${escapeHtml(entry.path)}"${
    entry.editable ? "" : " disabled"
  }${tip}>${editorFileIconHtml(entry.path)}${escapeHtml(label)}</button>`;
}

// Which folders are expanded, keyed by their full slash-joined path from
// the project root -- collapsed (not present in this set) by default, since
// a real terraform project's full tree (modules/, every deployment, every
// environment file) is long enough that starting fully expanded meant
// scrolling past everything just to find one file.
let editorExpandedDirs = new Set();

function renderEditorFileTreeNode(node, parentPath = "") {
  const items = [...node.children.values()].sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return items
    .map((item) => {
      if (item.type !== "dir") return editorFileRowHtml(item.entry, item.name);
      const dirPath = parentPath ? `${parentPath}/${item.name}` : item.name;
      const open = editorExpandedDirs.has(dirPath);
      return `<details class="editor-dir" data-dir-path="${escapeHtml(dirPath)}"${
        open ? " open" : ""
      }><summary class="editor-file-row"><span class="file-dir">${escapeHtml(item.name)}/</span></summary>${renderEditorFileTreeNode(
        item,
        dirPath
      )}</details>`;
    })
    .join("");
}

function collectEditorDirPaths(node, parentPath, out) {
  for (const item of node.children.values()) {
    if (item.type !== "dir") continue;
    const dirPath = parentPath ? `${parentPath}/${item.name}` : item.name;
    out.push(dirPath);
    collectEditorDirPaths(item, dirPath, out);
  }
  return out;
}

// Called after opening a file so its folder (and every ancestor folder) is
// guaranteed visible -- otherwise jumping to a file via the filter box, or
// re-opening one after a poll refresh, could land you on a file buried
// inside folders that are still collapsed.
function expandEditorAncestorsOf(path) {
  const parts = path.split("/");
  let acc = "";
  for (let i = 0; i < parts.length - 1; i++) {
    acc = acc ? `${acc}/${parts[i]}` : parts[i];
    editorExpandedDirs.add(acc);
  }
}

function renderEditorFileTree() {
  const q = editorFileFilterEl.value.trim().toLowerCase();
  if (q) {
    const matches = editorFiles.filter((e) => e.path.toLowerCase().includes(q));
    editorFileTreeListEl.innerHTML = matches.length
      ? matches.map((e) => editorFileRowHtml(e, e.path)).join("")
      : `<p class="muted" style="padding:10px;">No files match.</p>`;
  } else {
    editorFileTreeListEl.innerHTML = renderEditorFileTreeNode(buildEditorFileTree(editorFiles));
  }
}
editorFileFilterEl.addEventListener("input", renderEditorFileTree);

// <details>'s own "toggle" event doesn't bubble, but a capturing listener
// still sees it on the way down to the target regardless -- one delegated
// listener instead of wiring one per folder (which get torn down and
// rebuilt on every render anyway).
editorFileTreeListEl.addEventListener(
  "toggle",
  (ev) => {
    const details = ev.target;
    if (!details.classList || !details.classList.contains("editor-dir")) return;
    const dirPath = details.dataset.dirPath;
    if (details.open) editorExpandedDirs.add(dirPath);
    else editorExpandedDirs.delete(dirPath);
  },
  true
);

const btnToggleAllEditorDirsEl = document.getElementById("btn-toggle-all-editor-dirs");
btnToggleAllEditorDirsEl.onclick = () => {
  const expanding = btnToggleAllEditorDirsEl.textContent === "Expand all";
  editorExpandedDirs = expanding ? new Set(collectEditorDirPaths(buildEditorFileTree(editorFiles), "", [])) : new Set();
  btnToggleAllEditorDirsEl.textContent = expanding ? "Collapse all" : "Expand all";
  renderEditorFileTree();
};

editorFileTreeListEl.onclick = (ev) => {
  const btn = ev.target.closest(".editor-file-row[data-path]");
  if (btn && !btn.disabled) openEditorFile(btn.dataset.path);
};

async function openEditorFile(path) {
  const entry = editorFiles.find((e) => e.path === path);
  if (!entry || !entry.editable) return;

  let monaco;
  try {
    monaco = await loadMonaco();
  } catch (e) {
    toast(e.message, { type: "error" });
    return;
  }

  if (!monacoEditorInstance) {
    editorEmptyStateEl.classList.add("hidden");
    monacoContainerEl.classList.remove("hidden");
    monacoEditorInstance = monaco.editor.create(monacoContainerEl, {
      theme: document.documentElement.dataset.theme === "dark" ? "vs-dark" : "vs",
      automaticLayout: true,
      fontSize: 13,
      fontFamily: "Cascadia Mono, Consolas, monospace",
      minimap: { enabled: true },
      wordWrap: "off",
    });
    monacoEditorInstance.onDidChangeModelContent(() => {
      updateEditorDirtyState();
      renderEditorFileTree();
      scheduleAutoSave();
    });
    monacoEditorInstance.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => btnSaveFileEl.click());
  }

  let state = editorModels.get(path);
  if (!state) {
    let data;
    try {
      data = await api(`/api/projects/${editorProject.id}/file?path=${encodeURIComponent(path)}`);
    } catch (e) {
      toast(`Could not open ${path}: ${e.message}`, { type: "error" });
      return;
    }
    const model = monaco.editor.createModel(data.content, guessMonacoLanguage(path));
    state = { model, originalContent: data.content };
    editorModels.set(path, state);
  } else {
    // Already cached from earlier in this session -- pull the latest disk
    // content in case it changed since then (edited elsewhere, or by a
    // fmt/apply run) while this file wasn't the one being watched by the
    // poll timer. No-ops if there are local unsaved edits.
    await refreshEditorFileIfUnchangedLocally(path);
  }

  editorCurrentPath = path;
  monacoEditorInstance.setModel(state.model);
  editorFilePathEl.textContent = path;
  updateEditorDirtyState();
  expandEditorAncestorsOf(path);
  renderEditorFileTree();
}

// Shared by the Save button and auto-save. `path` defaults to whatever's
// currently open, but auto-save passes the path it was SCHEDULED for
// explicitly -- its debounce timer fires ~1.5s later, and if the user
// switched to a different file in the meantime, editorCurrentPath would no
// longer be the file that was actually edited.
async function saveCurrentEditorFile({ silent = false, path = editorCurrentPath } = {}) {
  if (!path) return;
  const state = editorModels.get(path);
  if (!state || state.model.getValue() === state.originalContent) return; // nothing changed -- e.g. an auto-save tick after a manual save already ran
  const content = state.model.getValue();
  btnSaveFileEl.disabled = true;
  try {
    const result = await api(`/api/projects/${editorProject.id}/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path, content }),
    });
    state.originalContent = content;
    editorBlockedBadgeEl.classList.add("hidden");
    if (result.sync_warning) {
      // Cloud org project: the save itself landed on disk fine, but
      // committing/pushing it failed (no network, no credentials) -- flag
      // that distinctly, since silently succeeding here would mean this
      // edit never actually reaches the shared repo at all.
      toast(result.sync_warning, { type: "warning", duration: 8000 });
    } else if (!silent) {
      toast(`Saved ${path}.`, {
        type: "success",
        action: { label: "Validate", onClick: () => runFileEditorValidate() },
      });
    }
  } catch (e) {
    // The backend hard-blocks a save while a run is in progress for this
    // project (see write_project_file) -- that's the actual safety net, not
    // this badge. The badge just makes WHY it failed visible at a glance
    // instead of only in a toast that's gone in a few seconds.
    editorBlockedBadgeEl.classList.toggle("hidden", !/in progress/i.test(e.message));
    toast(`Could not save${silent ? " (auto-save)" : ""}: ${e.message}`, { type: "error", duration: 7000 });
  } finally {
    updateEditorDirtyState();
    renderEditorFileTree();
    btnSaveFileEl.disabled = false;
  }
}

btnSaveFileEl.onclick = () => saveCurrentEditorFile({ silent: false });

// ---------- editor auto-save ----------

const AUTOSAVE_KEY = "iac-dashboard-editor-autosave";
const AUTOSAVE_DEBOUNCE_MS = 1500;
const chkAutosaveEl = document.getElementById("chk-autosave");
const autosaveIndicatorEl = document.getElementById("autosave-indicator");
let editorAutoSaveEnabled = localStorage.getItem(AUTOSAVE_KEY) === "true";
let autoSaveDebounceTimer = null;

chkAutosaveEl.checked = editorAutoSaveEnabled;
autosaveIndicatorEl.classList.toggle("hidden", !editorAutoSaveEnabled);
chkAutosaveEl.onchange = () => {
  editorAutoSaveEnabled = chkAutosaveEl.checked;
  localStorage.setItem(AUTOSAVE_KEY, String(editorAutoSaveEnabled));
  autosaveIndicatorEl.classList.toggle("hidden", !editorAutoSaveEnabled);
};

function scheduleAutoSave() {
  if (!editorAutoSaveEnabled || !editorCurrentPath) return;
  const pathAtScheduleTime = editorCurrentPath;
  clearTimeout(autoSaveDebounceTimer);
  autoSaveDebounceTimer = setTimeout(() => saveCurrentEditorFile({ silent: true, path: pathAtScheduleTime }), AUTOSAVE_DEBOUNCE_MS);
}

// A standalone terraform-validate call for the editor tab -- it can't reuse
// runValidate() as-is, since that reads/writes the workspace tab's own run
// list and selects the run into ITS detail panel; here, all we want is the
// pass/fail verdict as a toast.
async function runFileEditorValidate() {
  try {
    const { run_id } = await api(`/api/projects/${editorProject.id}/validate`, { method: "POST" });
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const run = await api(`/api/runs/${run_id}`);
      if (run.status === "success" || run.status === "failed") {
        toast(run.status === "success" ? "Validate passed." : "Validate failed -- check the workspace tab for details.", {
          type: run.status === "success" ? "success" : "error",
        });
        return;
      }
    }
  } catch (e) {
    toast(`Could not run validate: ${e.message}`, { type: "error" });
  }
}

async function showFileEditor(project, { pushHistory = true } = {}) {
  editorProject = project;
  editorFiles = [];
  editorModels = new Map();
  editorCurrentPath = null;

  revealView(editorViewEl);
  hideBgParticles();
  renderBreadcrumb([
    { label: "IaC-Dashboard", onClick: showLanding },
    { label: currentOrg.name, onClick: () => showOrgView(currentOrg) },
    { label: project.name, onClick: () => openWorkspace(project) },
    { label: "Edit Files" },
  ]);
  btnBackEl.classList.remove("hidden");
  btnBackEl.textContent = "←";
  editorProjectNameEl.textContent = project.name;
  editorFilePathEl.textContent = "";
  editorDirtyBadgeEl.classList.add("hidden");
  editorBlockedBadgeEl.classList.add("hidden");
  editorEmptyStateEl.classList.remove("hidden");
  monacoContainerEl.classList.add("hidden");
  if (monacoEditorInstance) monacoEditorInstance.setModel(null);
  editorFileFilterEl.value = "";
  editorExpandedDirs = new Set();
  btnToggleAllEditorDirsEl.textContent = "Expand all";
  closeTerminal(); // switching projects (or a fresh load) -- any previous project's terminal session must not carry over
  document.title = `Edit — ${project.name} — IaC-Dashboard`;

  if (pushHistory) {
    const url = `/editor/${encodeURIComponent(currentOrg.name)}/${encodeURIComponent(project.name)}`;
    if (location.pathname !== url) history.pushState({}, "", url);
  }

  try {
    editorFiles = await api(`/api/projects/${project.id}/files`);
  } catch (e) {
    toast(`Could not list files: ${e.message}`, { type: "error" });
    editorFiles = [];
  }
  renderEditorFileTree();
  startEditorPoll();
}

// Editing happens in its own tab, so the two places changes could
// otherwise silently vanish are: closing/reloading THIS tab (native
// beforeunload), and this tab's own in-app Back button navigating away
// from the editor view without ever unloading the page.
window.addEventListener("beforeunload", (ev) => {
  if (!editorViewEl.classList.contains("hidden") && hasAnyUnsavedEditorChanges()) {
    ev.preventDefault();
    ev.returnValue = "";
  }
});

async function closeFileEditor() {
  if (hasAnyUnsavedEditorChanges()) {
    const ok = await confirmDialog("You have unsaved changes in the editor. Discard them and leave?", {
      title: "Discard unsaved changes?",
      okLabel: "Discard & leave",
    });
    if (!ok) return;
    clearTimeout(autoSaveDebounceTimer); // explicitly discarded -- a pending auto-save must not resurrect it after leaving
  }
  stopEditorPoll();
  closeTerminal();
  openWorkspace(editorProject);
}

// ---------- in-app terminal (real PTY over a websocket) ----------
//
// A real shell, not a sandboxed command runner -- cwd is fixed to this
// project's own deployment folder at spawn time (see spawn_terminal in
// run_manager.py), but once it's running it's exactly as capable as any
// terminal you'd open yourself: it can cd elsewhere, run anything. That's
// inherent to "give me a real terminal," not a bug to route around.

const btnToggleTerminalEl = document.getElementById("btn-toggle-terminal");
const terminalPanelEl = document.getElementById("terminal-panel");
const terminalPanelTitleEl = document.getElementById("terminal-panel-title");
const terminalStatusEl = document.getElementById("terminal-status");
const btnRestartTerminalEl = document.getElementById("btn-restart-terminal");
const btnCloseTerminalEl = document.getElementById("btn-close-terminal");
const xtermContainerEl = document.getElementById("xterm-container");

let xtermLoadPromise = null;
let xtermInstance = null;
let xtermFitAddon = null;
let terminalSocket = null;

function loadXterm() {
  if (xtermLoadPromise) return xtermLoadPromise;
  xtermLoadPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "/vendor/xterm/xterm.css";
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = "/vendor/xterm/xterm.js";
    script.onload = () => {
      const fitScript = document.createElement("script");
      fitScript.src = "/vendor/xterm/addon-fit.js";
      fitScript.onload = () => resolve({ Terminal: window.Terminal, FitAddon: window.FitAddon.FitAddon });
      fitScript.onerror = () => reject(new Error("could not load the terminal (static/vendor/xterm missing?)"));
      document.head.appendChild(fitScript);
    };
    script.onerror = () => reject(new Error("could not load the terminal (static/vendor/xterm missing?)"));
    document.head.appendChild(script);
  });
  return xtermLoadPromise;
}

function connectTerminalSocket() {
  const wsScheme = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(`${wsScheme}//${location.host}/api/projects/${editorProject.id}/terminal/ws`);
  terminalStatusEl.textContent = "connecting…";

  socket.onopen = () => {
    terminalStatusEl.textContent = "";
    if (xtermFitAddon) sendTerminalResize();
  };
  socket.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (e) {
      return;
    }
    if (msg.type === "output") xtermInstance.write(msg.data);
    else if (msg.type === "error") {
      terminalStatusEl.textContent = msg.message;
      xtermInstance.write(`\r\n\x1b[31m[${msg.message}]\x1b[0m\r\n`);
    } else if (msg.type === "exit") {
      terminalStatusEl.textContent = "shell exited";
      xtermInstance.write("\r\n\x1b[90m[process exited]\x1b[0m\r\n");
    }
  };
  socket.onclose = () => {
    if (terminalSocket === socket) terminalStatusEl.textContent = "disconnected";
  };
  socket.onerror = () => {
    terminalStatusEl.textContent = "connection error";
  };
  return socket;
}

function sendTerminalResize() {
  if (!terminalSocket || terminalSocket.readyState !== WebSocket.OPEN) return;
  xtermFitAddon.fit();
  terminalSocket.send(JSON.stringify({ type: "resize", rows: xtermInstance.rows, cols: xtermInstance.cols }));
}

async function openTerminal() {
  terminalPanelEl.classList.remove("hidden");
  terminalPanelTitleEl.textContent = `Terminal — ${editorProject.deployment}`;
  btnToggleTerminalEl.classList.add("active-toggle");

  if (!xtermInstance) {
    let libs;
    try {
      libs = await loadXterm();
    } catch (e) {
      toast(e.message, { type: "error" });
      return;
    }
    xtermInstance = new libs.Terminal({
      fontSize: 13,
      fontFamily: "Cascadia Mono, Consolas, monospace",
      theme: { background: "#131a30", foreground: "#d7e3fb" },
      cursorBlink: true,
      scrollback: 5000,
    });
    xtermFitAddon = new libs.FitAddon();
    xtermInstance.loadAddon(xtermFitAddon);
    xtermInstance.open(xtermContainerEl);
    xtermInstance.onData((data) => {
      if (terminalSocket && terminalSocket.readyState === WebSocket.OPEN) {
        terminalSocket.send(JSON.stringify({ type: "input", data }));
      }
    });
  }

  // Removing "hidden" a few lines up doesn't take effect in the layout
  // until the browser actually reflows -- fitting (or connecting the
  // socket, which lets PTY output start arriving) immediately after
  // `open()` was measuring a container that was still effectively 0x0.
  // xterm's DOM renderer painted those very first rows against that bogus
  // size and never repainted them once a later fit() corrected the
  // dimensions -- the buffer had the right text (confirmed via
  // buffer.active.getLine()) but the rows stayed visually blank.
  // Reading offsetHeight forces a synchronous layout flush right now --
  // deliberately NOT `await new Promise(requestAnimationFrame)`, which
  // depends on the tab actively compositing frames and can stall
  // indefinitely in a backgrounded/throttled tab.
  void xtermContainerEl.offsetHeight;
  xtermFitAddon.fit();

  if (!terminalSocket || terminalSocket.readyState === WebSocket.CLOSED) {
    terminalSocket = connectTerminalSocket(); // its onopen handler re-fits/resizes again, cheap insurance
  } else {
    sendTerminalResize();
  }
}

function hideTerminalPanel() {
  terminalPanelEl.classList.add("hidden");
  btnToggleTerminalEl.classList.remove("active-toggle");
}

function closeTerminal() {
  hideTerminalPanel();
  if (terminalSocket) {
    terminalSocket.close();
    terminalSocket = null;
  }
  if (xtermInstance) {
    xtermInstance.dispose();
    xtermInstance = null;
    xtermFitAddon = null;
  }
}

btnToggleTerminalEl.onclick = () => {
  if (terminalPanelEl.classList.contains("hidden")) openTerminal();
  else hideTerminalPanel();
};
btnCloseTerminalEl.onclick = closeTerminal;
btnRestartTerminalEl.onclick = () => {
  if (terminalSocket) terminalSocket.close();
  terminalSocket = connectTerminalSocket();
  if (xtermInstance) xtermInstance.clear();
  setTimeout(sendTerminalResize, 50);
};
window.addEventListener("resize", () => {
  if (!terminalPanelEl.classList.contains("hidden")) sendTerminalResize();
});

// ---------- tools: name availability checker ----------

const nameAvailabilityServiceSelectEl = document.getElementById("name-availability-service-select");
const nameAvailabilityHintEl = document.getElementById("name-availability-hint");
const storageNameInputEl = document.getElementById("storage-name-input");
const btnCheckStorageNameEl = document.getElementById("btn-check-storage-name");
const storageNameResultEl = document.getElementById("storage-name-result");

let nameAvailabilityServices = [];

function updateNameAvailabilityHint() {
  const svc = nameAvailabilityServices.find((s) => s.id === nameAvailabilityServiceSelectEl.value);
  nameAvailabilityHintEl.textContent = svc ? `Naming rules: ${svc.pattern_hint}.` : "";
}

async function loadNameAvailabilityServices() {
  try {
    nameAvailabilityServices = await api("/api/tools/name-availability-services");
    nameAvailabilityServiceSelectEl.innerHTML = nameAvailabilityServices
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)}</option>`)
      .join("");
    updateNameAvailabilityHint();
  } catch (e) {
    nameAvailabilityServiceSelectEl.innerHTML = `<option value="" disabled selected>could not load services</option>`;
  }
}
nameAvailabilityServiceSelectEl.onchange = updateNameAvailabilityHint;
loadNameAvailabilityServices();

async function checkNameAvailability() {
  const service = nameAvailabilityServiceSelectEl.value;
  const name = storageNameInputEl.value.trim();
  if (!service || !name) {
    storageNameInputEl.focus();
    return;
  }
  storageNameResultEl.className = "tool-result hidden";
  btnCheckStorageNameEl.disabled = true;
  btnCheckStorageNameEl.textContent = "Checking…";
  try {
    const result = await api("/api/tools/check-name-availability", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ service, name }),
    });
    storageNameResultEl.className = `tool-result ${result.name_available ? "ok" : "error"}`;
    storageNameResultEl.textContent = result.name_available
      ? `"${result.name}" is available.`
      : `"${result.name}" is NOT available -- ${result.message || result.reason || "already taken or invalid"}`;
  } catch (e) {
    storageNameResultEl.className = "tool-result error";
    storageNameResultEl.textContent = e.message;
  } finally {
    btnCheckStorageNameEl.disabled = false;
    btnCheckStorageNameEl.textContent = "Check";
  }
}
btnCheckStorageNameEl.onclick = checkNameAvailability;
storageNameInputEl.addEventListener("keydown", (ev) => {
  if (ev.key === "Enter") checkNameAvailability();
});

restoreFromLocation({ pushHistory: false });
