"""
IaC-Dashboard -- one process, two front doors onto the same state:

  1. A local web dashboard (this file's custom_route handlers + static/):
     a landing page listing saved Work Projects, an "Add Work Project" flow
     (name it, pick/browse a folder, pick deployment+environment), and a
     per-project workspace with Run Plan / Request Apply / Confirm & Apply
     and live output.
  2. An MCP server (the @server.tool() functions below) so Claude Code can
     drive the exact same add-project/init/plan/apply/status flow and relay
     results back to you in chat.

Both talk to run_manager.py, so a project added or a run started from either
side shows up in both places. Binds to 127.0.0.1 only -- this can trigger
real changes against real Azure subscriptions, it should never be reachable
off this machine.

Apply is never one-click from either side: request_apply() only returns a
confirmation token + plan summary, and confirm_apply() requires that exact
token. From the dashboard that means typing/pasting the shown code into the
confirm box. From MCP, Claude must show you the summary and only call
confirm_apply after you say yes in chat.
"""

import asyncio
import csv
import io
import json
import mimetypes
import os
import time
import urllib.parse

import uvicorn
from starlette.requests import Request
from starlette.responses import FileResponse, JSONResponse, RedirectResponse, Response, StreamingResponse
from starlette.routing import WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

import auth as ghauth
import run_manager as rm
from mcp.server.mcpserver import MCPServer

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
# 127.0.0.1 by default -- this can trigger real changes against real Azure
# subscriptions, it should never be reachable off this machine (see the
# module docstring). The Docker image overrides HOST to 0.0.0.0 (binding to
# loopback INSIDE a container makes it unreachable from the host entirely,
# a common container gotcha) -- docker-compose.yml then re-establishes the
# same "never reachable off this machine" guarantee by publishing the port
# as 127.0.0.1:8765:8765, not a bare 8765:8765.
HOST = os.environ.get("IAC_DASHBOARD_HOST", "127.0.0.1")
PORT = int(os.environ.get("IAC_DASHBOARD_PORT", "8765"))


async def _json_body(request: Request) -> tuple[dict | None, JSONResponse | None]:
    """Parse the request body as JSON, returning (body, None) on success or
    (None, error_response) on malformed/missing JSON -- callers just
    `if err: return err`."""
    try:
        body = await request.json()
    except ValueError:
        return None, JSONResponse({"error": "request body is not valid JSON"}, status_code=400)
    if not isinstance(body, dict):
        return None, JSONResponse({"error": "request body must be a JSON object"}, status_code=400)
    return body, None


server = MCPServer(
    name="IaC-Dashboard",
    instructions=(
        "Controls terraform init/plan/apply for named, saved Terraform IaC "
        "'projects' on this machine, grouped under Organizations "
        "(/<org-name>/<project-name>). Nothing is hardcoded to one "
        "deployment. Workflow: (1) call list_organizations -- if none exist "
        "yet, create one with add_organization(name) before anything else. "
        "(2) call list_projects(org_id) -- if the user already has one they "
        "mean, use its id. (3) To add a new one: EITHER discover_project"
        "(project_root) to scan an existing folder (must contain modules/ + "
        "tf-deployment* dirs), OR initialize_project_folder(project_root) "
        "to scaffold a brand-new empty folder into that same "
        "shape -- ask the user which they want. Either way, see what "
        "deployments/environments it offers, ask the user which one, what to "
        "name it if not already told, then add_project(org_id, name, "
        "project_root, deployment, environment). (4) init_project(project_id) -- required at least "
        "once before plan will work; fails clearly if the CLI login doesn't "
        "match what this project needs (e.g. not logged into Azure, or wrong "
        "subscription) instead of a confusing terraform error. (5) "
        "terraform_plan(project_id). (6) request_apply(plan_run_id) -- show "
        "the user the returned summary and get their explicit yes in chat "
        "BEFORE (7) confirm_apply(token). Never call confirm_apply on your "
        "own initiative."
    ),
)


# ===================================================================================
# MCP TOOLS
# ===================================================================================


@server.tool()
async def list_organizations() -> list:
    """List saved Organizations (name, id, how many projects each has).
    Projects must belong to an organization -- if this is empty, create one
    with add_organization before adding any project."""
    return rm.list_orgs()


@server.tool()
async def add_organization(name: str, mode: str = "local", repo_url: str | None = None) -> dict:
    """Create a new Organization. Projects are addressed as
    /<org-name>/<project-name>, so every project must belong to one --
    call this first if list_organizations came back empty.

    mode="cloud" (with repo_url set) makes this a Cloud organization: its
    projects' actual Terraform files, plus a manifest of which projects it
    has, live in that Git repo instead of only this machine -- someone
    else who creates an org with the SAME name and SAME repo_url ends up
    seeing the same projects. Relies entirely on git credentials already
    configured on this machine; repo_url must already be one you can
    clone/push to."""
    try:
        return await asyncio.to_thread(rm.add_org, name, mode, repo_url)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def delete_organization(org_id: str) -> dict:
    """Delete an Organization and cascade-delete every project inside it
    (same as deleting each project individually -- forgets local
    bookkeeping only, never touches real cloud resources). Confirm with the
    user before calling this."""
    await asyncio.to_thread(rm.remove_org, org_id)
    return {"ok": True}


@server.tool()
async def list_projects(org_id: str | None = None) -> list:
    """List saved Work Projects (name, folder, deployment, environment, and
    whether it's been terraform-init'd -- detected from .terraform/ on disk,
    so it stays accurate across restarts), optionally filtered to one
    org_id."""
    return rm.list_projects(org_id)


@server.tool()
async def discover_project(project_root: str) -> dict:
    """Scan an EXISTING folder (read-only, no side effects): it must contain
    a modules/ directory and at least one tf-deployment* directory. Returns
    each deployment found and the environments it supports (only
    environments with BOTH a matching
    environmentVariables/terraform.<env>.tfvars AND a
    backend/*.<env>.tfbackend file count). Call this before add_project when
    the user is pointing at a folder that already has Terraform code in it.
    For a brand-new empty folder, use initialize_project_folder instead."""
    try:
        return await asyncio.to_thread(rm.discover_project, project_root)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def initialize_project_folder(project_root: str) -> dict:
    """Scaffold a brand-new Terraform project into an EMPTY folder: an empty
    modules/ dir, plus tf-deployment/main.tf (azurerm provider),
    tf-deployment/backend/, and tf-deployment/environmentVariables/ with one
    placeholder "dev" tfvars+tfbackend pair. Refuses a non-empty folder --
    use discover_project for anything that already has content. Returns the
    same shape as discover_project (deployments/environments found), ready to
    pass into add_project -- but the generated files contain REPLACE_ME
    placeholders the user still needs to fill in with real values before init
    will actually succeed."""
    try:
        return await asyncio.to_thread(rm.initialize_project_folder, project_root)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def add_project(
    org_id: str,
    name: str,
    project_root: str,
    deployment: str,
    environment: str,
    retention_days: int | None = None,
) -> dict:
    """Save a new named Work Project, under an existing Organization
    (org_id), pointing at one deployment+environment discovered via
    discover_project or initialize_project_folder. Azure is the only
    supported cloud provider right now. retention_days auto-deletes
    finished init/plan/apply run history older than that many days
    (checked after every run and at server startup); omit it (or pass 0) to
    keep run history forever, the default. Does not run init yet -- call
    init_project with the returned id next."""
    try:
        return await asyncio.to_thread(
            rm.add_project, org_id, name, project_root, deployment, environment, "azure", retention_days
        )
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def update_project(
    project_root: str,
    deployment: str,
    environment: str,
    project_id: str,
    retention_days: int | None = None,
) -> dict:
    """Change a saved project's folder/deployment/environment in place (same
    id, same name, same run history). Name is not editable -- it's the
    stable key the dashboard's /project/<name> URLs are built on; delete and
    re-add the project if you genuinely need to rename it. If the folder/
    deployment/environment actually changed, the project is marked
    not-initialized again -- call init_project before terraform_plan after
    an update like that. retention_days is left unchanged if omitted; pass
    it explicitly (0 to mean "keep forever") to change it."""
    try:
        kwargs = {} if retention_days is None else {"retention_days": retention_days}
        return await asyncio.to_thread(rm.update_project, project_id, project_root, deployment, environment, **kwargs)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def delete_project(project_id: str) -> dict:
    """Remove a saved project from the dashboard. Does NOT run terraform
    destroy or touch any cloud resources -- only forgets this local
    bookkeeping entry. Confirm with the user before calling this."""
    await asyncio.to_thread(rm.remove_project, project_id)
    return {"ok": True}


@server.tool()
async def clear_project_runs(project_id: str) -> dict:
    """Delete the init/plan/apply run history for one project (and its
    saved .tfplan files). Refuses if a run is currently in progress for it.
    Confirm with the user before calling this."""
    try:
        await asyncio.to_thread(rm.clear_runs, project_id)
    except ValueError as e:
        return {"error": str(e)}
    return {"ok": True}


@server.tool()
async def check_auth(project_id: str) -> dict:
    """Check whether the current Azure CLI login can actually be used for this
    project, WITHOUT starting a run: verifies `az account show` succeeds and,
    if the tfvars names a subscription_id, that the logged-in identity can see
    it. Returns {authenticated, reason}. This is the same check that gates
    init/plan, so use it to tell the user to `az login` before they wait on a
    run that was going to be refused anyway."""
    try:
        return await asyncio.to_thread(rm.check_auth, project_id)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def check_name_availability(service: str, name: str) -> dict:
    """Check whether a name is globally available for an Azure service --
    several Azure resource types are namespaced across ALL of Azure, not
    just one subscription (storage accounts, key vaults, container
    registries, Cosmos DB accounts), which is exactly the kind of thing
    worth confirming before writing a name into tfvars. `service` is one of
    "storage_account", "key_vault", "container_registry", "cosmosdb_account"
    (call list_name_availability_services to get this list programmatically
    with hints). Read-only, not tied to any saved project."""
    try:
        return await asyncio.to_thread(rm.check_name_availability, service, name)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def list_name_availability_services() -> list:
    """List the Azure services check_name_availability can check a name
    against, each with a human label and a hint about that service's naming
    rules."""
    return rm.list_name_availability_services()


@server.tool()
async def get_tfvars(project_id: str) -> dict:
    """Read this project's tfvars file and return it parsed into a real
    nested dict/list/str/number/bool structure (`parsed`) instead of raw
    text -- so you can summarize or answer questions about its config
    directly. Also always returns the raw file text (`raw`) and, if parsing
    failed on something this simple HCL-lite parser doesn't handle (e.g. a
    heredoc or an interpolated expression), `parse_error` explaining why,
    with `parsed` set to null in that case -- fall back to `raw` then."""
    try:
        return await asyncio.to_thread(rm.get_tfvars, project_id)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def get_state_resources(project_id: str) -> list:
    """List everything actually deployed per this project's current
    Terraform state -- address, type, terraform-local name, the real Azure
    resource name, and a handful of highlight attributes (SKU/tier/size/
    location, whichever apply) per resource. Read-only: runs
    `terraform show -json` against local state, no plan, no Azure portal,
    doesn't touch the state lock. Requires init_project to have succeeded
    first. Empty list means the state is valid but nothing has been applied
    yet."""
    try:
        return await asyncio.to_thread(rm.get_state_resources, project_id)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def get_state_resource_detail(project_id: str, address: str) -> dict:
    """Full attribute values for one resource address from
    get_state_resources (e.g. "module.storage_account.azurerm_storage_account.this"),
    sensitive values redacted the same way plan diffs are."""
    try:
        return await asyncio.to_thread(rm.get_state_resource_detail, project_id, address)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def get_module_and_provider_sources(project_id: str) -> dict:
    """Modules and required providers this deployment's own .tf files
    declare -- {modules: [{name, source, version, file}], providers:
    [{name, source, version_constraint, file}]}. Parsed straight from the
    .tf source, not the lock file, so it reflects what's actually written
    in the config (including an unpinned local module's source path)."""
    try:
        return await asyncio.to_thread(rm.get_module_and_provider_sources, project_id)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def init_project(project_id: str) -> dict:
    """Run `terraform init` for a saved project and block until it finishes
    (up to 2 minutes). Must succeed at least once per server run before
    terraform_plan will work for that project."""
    try:
        run = rm.init_project(project_id)
    except ValueError as e:
        return {"error": str(e)}
    await asyncio.to_thread(rm.wait_for, run.id, 120)
    r = rm.get_run(run.id)
    return {**r.to_dict(), "tail": r.lines[-30:]}


@server.tool()
async def fmt(project_id: str) -> dict:
    """Run `terraform fmt -recursive` for this project: rewrites any
    badly-formatted .tf/.tfvars files in place and returns the list of files
    it reformatted (empty means everything was already formatted). Purely
    local -- no Azure calls, no init required -- and only ever changes
    whitespace/alignment, never what the config means, so it's safe to run
    unprompted. Covers the deployment directory and its subdirectories (so
    environmentVariables/*.tfvars is included); backend/*.tfbackend is
    skipped because terraform doesn't recognize that extension."""
    try:
        run = rm.run_fmt(project_id)
    except ValueError as e:
        return {"error": str(e)}
    await asyncio.to_thread(rm.wait_for, run.id, 60)
    r = rm.get_run(run.id)
    return {**r.to_dict(), "reformatted_files": [ln for ln in r.lines if ln.strip()], "tail": r.lines[-40:]}


@server.tool()
async def validate(project_id: str) -> dict:
    """Run `terraform validate` for this project -- checks config/schema
    only, no Azure calls, but requires init_project to have succeeded first."""
    try:
        run = rm.run_validate(project_id)
    except ValueError as e:
        return {"error": str(e)}
    await asyncio.to_thread(rm.wait_for, run.id, 60)
    r = rm.get_run(run.id)
    return {**r.to_dict(), "tail": r.lines[-40:]}


@server.tool()
async def terraform_plan(project_id: str, name: str) -> dict:
    """Run `terraform plan` for this project and block until it finishes (up
    to 5 minutes). `name` is a required short label for this plan run (e.g.
    'before refactor', 'adding cosmos') -- ask the user what to call it if
    they haven't said. Returns the run_id, status, a parsed add/change/destroy
    summary, and the last 30 log lines. Requires init_project to have
    succeeded for this project first. Always call this before request_apply."""
    try:
        run = rm.start_plan(project_id, name)
    except ValueError as e:
        return {"error": str(e)}
    await asyncio.to_thread(rm.wait_for, run.id, 300)
    r = rm.get_run(run.id)
    return {**r.to_dict(), "tail": r.lines[-30:]}


@server.tool()
async def plan_destroy(project_id: str, name: str) -> dict:
    """Run `terraform plan -destroy` for this project -- plans tearing down
    EVERYTHING this deployment manages. Same rules as terraform_plan (name
    required, requires init_project first). This only plans; it does not
    destroy anything by itself. As with any plan, follow up with
    request_apply then confirm_apply (after explicit user approval) to
    actually run the destroy."""
    try:
        run = rm.start_plan(project_id, name, destroy=True)
    except ValueError as e:
        return {"error": str(e)}
    await asyncio.to_thread(rm.wait_for, run.id, 300)
    r = rm.get_run(run.id)
    return {**r.to_dict(), "tail": r.lines[-30:]}


@server.tool()
async def request_apply(plan_run_id: str) -> dict:
    """Request permission to apply a previously-run successful plan.
    Returns a one-time confirmation token plus the plan's add/change/destroy
    summary. This does NOT apply anything. Show the summary to the user and
    only proceed to confirm_apply after they explicitly approve it in chat.
    Fails if the tfvars/backend file changed on disk since the plan was
    generated -- re-run terraform_plan in that case."""
    try:
        return await asyncio.to_thread(rm.request_apply_confirmation, plan_run_id)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def confirm_apply(token: str) -> dict:
    """Execute `terraform apply` using the plan tied to this confirmation
    token, and block until it finishes (up to 10 minutes). Only call this
    after the user has explicitly approved the plan summary shown by
    request_apply in this conversation -- never call it unprompted."""
    try:
        run = await asyncio.to_thread(rm.confirm_apply, token)
    except ValueError as e:
        return {"error": str(e)}
    await asyncio.to_thread(rm.wait_for, run.id, 600)
    r = rm.get_run(run.id)
    return {**r.to_dict(), "tail": r.lines[-40:]}


@server.tool()
async def cancel_run(run_id: str) -> dict:
    """Kill the terraform process for a run that's still queued/running,
    releasing the one-run-at-a-time lock on its project. Safe for
    init/fmt/validate/plan -- none of them change infrastructure. For an
    APPLY, warn the user first and get their explicit yes: terraform may have
    already created some resources, so state can be left partially applied,
    and the hard kill can leave the state file locked (needing `terraform
    force-unlock`)."""
    try:
        return await asyncio.to_thread(rm.cancel_run, run_id)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def get_run_status(run_id: str) -> dict:
    """Poll the current status and log tail of an init/plan/apply run by id."""
    r = rm.get_run(run_id)
    if r is None:
        return {"error": "run not found"}
    return {**r.to_dict(), "tail": r.lines[-40:]}


@server.tool()
async def get_plan_diff(run_id: str) -> dict:
    """Get a structured resource-by-resource create/update/delete/replace
    table for a completed plan run, parsed from its saved .tfplan file --
    much more useful to summarize for the user than the raw log. Each entry
    includes before/after attribute values (sensitive ones redacted to
    "(sensitive value)") and, for updates/replaces, which top-level
    attributes actually changed. Use this after terraform_plan/plan_destroy
    instead of dumping the raw log tail when you want to describe what a
    plan will do."""
    try:
        return await asyncio.to_thread(rm.get_plan_diff, run_id)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def compare_plans(run_id_a: str, run_id_b: str) -> dict:
    """Compare two plan runs for the SAME project, resource by resource --
    use this to answer "why does this plan look different from last time"
    instead of eyeballing two separate get_plan_diff results. Only returns
    resources that actually differ between the two plans (added/removed/
    changed action/changed fields) -- always labeled older/newer by
    timestamp regardless of argument order."""
    try:
        return await asyncio.to_thread(rm.compare_plans, run_id_a, run_id_b)
    except ValueError as e:
        return {"error": str(e)}


@server.tool()
async def list_runs(project_id: str | None = None, include_checks: bool = False) -> list:
    """List recent runs (most recent first), optionally filtered to one
    project_id. Only shows init/plan/apply by default -- pass
    include_checks=True to also see fmt/validate (those are never
    persisted, so only ones from this server session are ever visible)."""
    return rm.list_runs_summary(project_id, include_checks=include_checks)


# ===================================================================================
# DASHBOARD -- static files
# ===================================================================================


_NO_STORE_HEADERS = {"Cache-Control": "no-store, must-revalidate"}


@server.custom_route("/", methods=["GET"])
async def index(request: Request):
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), headers=_NO_STORE_HEADERS)


@server.custom_route("/app.js", methods=["GET"])
async def app_js(request: Request):
    return FileResponse(
        os.path.join(STATIC_DIR, "app.js"), media_type="application/javascript", headers=_NO_STORE_HEADERS
    )


@server.custom_route("/style.css", methods=["GET"])
async def style_css(request: Request):
    return FileResponse(os.path.join(STATIC_DIR, "style.css"), media_type="text/css", headers=_NO_STORE_HEADERS)


_FAVICON_SVG = (
    b"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'>"
    b"<rect width='32' height='32' rx='7' fill='#2563eb'/>"
    b"<polyline points='9,10 16,16 9,22' fill='none' stroke='white' stroke-width='3' "
    b"stroke-linecap='round' stroke-linejoin='round'/>"
    b"<rect x='18' y='20' width='7' height='3' rx='1' fill='white'/></svg>"
)


@server.custom_route("/favicon.ico", methods=["GET"])
async def favicon(request: Request):
    """Browsers request this directly regardless of the <link rel="icon">
    in index.html/the GitHub login page -- without a real answer here it
    used to 307 through the auth gate to /auth/login on every unauthenticated
    page (harmless but noisy), and some browsers would show a stale icon
    inherited from whatever page the tab was on last (e.g. github.com's own
    octocat, mid device-flow login) instead of ever getting IaC-Dashboard's
    own icon."""
    return Response(_FAVICON_SVG, media_type="image/svg+xml", headers={"Cache-Control": "public, max-age=86400"})


_VENDOR_DIR = os.path.join(STATIC_DIR, "vendor")


@server.custom_route("/vendor/{filepath:path}", methods=["GET"])
async def vendor_asset(request: Request):
    """Serves vendored third-party assets (currently: the Monaco editor's
    prebuilt AMD bundle, for the in-app file editor) -- these are content-
    hashed by their own build and never change post-install, so unlike the
    dashboard's own JS/CSS above this is safe (and worth it, ~150 small
    files) to let the browser cache normally instead of no-store."""
    filepath = request.path_params["filepath"]
    full_path = os.path.normpath(os.path.join(_VENDOR_DIR, filepath))
    if not full_path.startswith(os.path.normpath(_VENDOR_DIR) + os.sep) or not os.path.isfile(full_path):
        return Response(status_code=404)
    media_type, _ = mimetypes.guess_type(full_path)
    return FileResponse(full_path, media_type=media_type or "application/octet-stream")


# ===================================================================================
# DASHBOARD -- GitHub sign-in (Device Flow)
# ===================================================================================
# Entirely opt-in: without GITHUB_OAUTH_CLIENT_ID set, these routes still
# exist but AuthGateMiddleware below never redirects anyone to them -- the
# dashboard runs exactly as before. See README for setup.
#
# Device Flow instead of the usual browser-redirect OAuth flow: no callback
# URL to keep in sync with this machine's LAN IP (which changes across
# networks). /auth/login asks GitHub for a device code and shows it in a
# small standalone page; that page's own JS polls /auth/device/status until
# the user approves it at github.com/login/device from any device.


_GITHUB_MARK_SVG = (
    '<svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">'
    '<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49'
    "-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 "
    "1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 "
    "0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56."
    "82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 "
    '8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
)

_COPY_ICON_SVG = (
    '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" '
    'stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/>'
    '<path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>'
)


def _device_login_html(pending: dict | None) -> str:
    """Two-stage page: a plain "Login with GitHub" landing state (no device
    code minted yet -- clicking the button calls /auth/device/start), and
    an in-progress state with the code + expiry countdown + poll loop,
    shown directly on load if `pending` (an already in-flight login) is
    passed."""
    has_pending = pending is not None
    user_code = pending["user_code"] if pending else ""
    verification_uri = pending["verification_uri"] if pending else ""
    poll_ms = max(pending["interval"], 3) * 1000 if pending else 5000
    expires_at = pending["expires_at"] if pending else 0
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><title>Sign in with GitHub</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%232563eb'/%3E%3Cpolyline points='9,10 16,16 9,22' fill='none' stroke='white' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'/%3E%3Crect x='18' y='20' width='7' height='3' rx='1' fill='white'/%3E%3C/svg%3E" />
<style>
  * {{ box-sizing: border-box; }}
  body {{ font-family: system-ui, -apple-system, sans-serif; background: radial-gradient(circle at 50% 0%, #182238, #0b0f1a 65%);
          color:#e7e7ec; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:20px; }}
  .card {{ background:#151b2c; border:1px solid #262f47; border-radius:16px; padding:40px 40px 34px;
           text-align:center; max-width:400px; width:100%; box-shadow: 0 20px 60px rgba(0,0,0,0.45); }}
  .app-title {{ font-size:24px; font-weight:750; margin:0 0 4px; color:#eef1f8; letter-spacing:-0.01em; }}
  .tagline {{ font-size:13px; color:#5b8def; font-weight:600; margin:0 0 28px; }}
  h1 {{ font-size:16px; font-weight:650; margin:0 0 8px; color:#eef1f8; }}
  p.sub {{ font-size:13px; color:#8b93ab; margin:0 0 24px; line-height:1.5; }}
  .btn-github {{ display:flex; align-items:center; justify-content:center; gap:10px; width:100%;
           background:#1f2733; color:#fff; border:1px solid #333f56; text-decoration:none;
           padding:12px 20px; border-radius:10px; font-weight:600; font-size:14px; cursor:pointer;
           transition: background 0.15s ease, border-color 0.15s ease; }}
  .btn-github:hover {{ background:#28324450; border-color:#4b5878; }}
  a.btn-primary {{ display:block; background:#2563eb; color:#fff; text-decoration:none;
           padding:12px 20px; border-radius:10px; font-weight:650; font-size:14px; margin-bottom:16px;
           transition: background 0.15s ease; }}
  a.btn-primary:hover {{ background:#1d4ed8; }}
  .code-row {{ display:flex; align-items:stretch; gap:8px; margin-bottom:10px; }}
  .code {{ flex:1; font-size:28px; font-weight:700; letter-spacing:4px; background:#0d121f;
           border:1px solid #262f47; border-radius:10px; padding:14px 6px; font-family: ui-monospace, "SF Mono", Consolas, monospace; }}
  .btn-copy {{ flex-shrink:0; width:44px; background:#1f2733; border:1px solid #333f56; border-radius:10px;
           color:#aab4cc; cursor:pointer; display:flex; align-items:center; justify-content:center;
           transition: background 0.15s ease, color 0.15s ease; }}
  .btn-copy:hover {{ background:#28324450; color:#fff; }}
  .btn-copy.copied {{ color:#34d399; border-color:#1c5f47; }}
  #expiry {{ font-size:12px; color:#6b7590; margin-bottom:18px; }}
  #expiry.soon {{ color:#e5a53f; }}
  #status {{ font-size:13px; color:#7c8499; }}
  #status.err {{ color:#f28b8b; }}
  .hidden {{ display:none; }}
  .spinner {{ display:inline-block; width:11px; height:11px; border:2px solid #384565; border-top-color:#5b8def;
           border-radius:50%; animation:spin 0.8s linear infinite; margin-right:7px; vertical-align:-1px; }}
  @keyframes spin {{ to {{ transform:rotate(360deg); }} }}
</style></head>
<body>
  <div class="card">
    <div class="app-title">IaC-Dashboard</div>
    <div class="tagline">Your IaC Management Tool</div>

    <div id="stage-login" class="{'hidden' if has_pending else ''}">
      <p class="sub">Sign in with GitHub to continue.</p>
      <button id="btn-start" class="btn-github">{_GITHUB_MARK_SVG}<span>Login with GitHub</span></button>
    </div>

    <div id="stage-code" class="{'' if has_pending else 'hidden'}">
      <h1>Enter this code on GitHub</h1>
      <p class="sub">Go to <strong>{verification_uri}</strong> and enter the code below.</p>
      <div class="code-row">
        <div class="code" id="code-text">{user_code}</div>
        <button id="btn-copy" class="btn-copy" title="Copy code">{_COPY_ICON_SVG}</button>
      </div>
      <div id="expiry"></div>
      <a id="link-github" class="btn-primary" href="{verification_uri}" target="_blank" rel="noopener">Open GitHub &amp; enter code</a>
      <div id="status"><span class="spinner"></span>Waiting for approval&hellip;</div>
    </div>
  </div>
  <script>
    const stageLogin = document.getElementById("stage-login");
    const stageCode = document.getElementById("stage-code");
    const statusEl = document.getElementById("status");
    const codeTextEl = document.getElementById("code-text");
    const linkEl = document.getElementById("link-github");
    const copyBtn = document.getElementById("btn-copy");
    const expiryEl = document.getElementById("expiry");
    let nextDelayMs = {poll_ms};
    let expiresAt = {expires_at};
    let expiryTimer = null;

    function startExpiryCountdown() {{
      if (expiryTimer) clearInterval(expiryTimer);
      function tick() {{
        const remaining = expiresAt - Math.floor(Date.now() / 1000);
        if (remaining <= 0) {{
          expiryEl.textContent = "Code expired";
          expiryEl.classList.add("soon");
          clearInterval(expiryTimer);
          return;
        }}
        const m = Math.floor(remaining / 60);
        const s = remaining % 60;
        expiryEl.textContent = `Expires in ${{m}}:${{String(s).padStart(2, "0")}}`;
        expiryEl.classList.toggle("soon", remaining < 60);
      }}
      tick();
      expiryTimer = setInterval(tick, 1000);
    }}
    if (expiresAt > 0) startExpiryCountdown();

    copyBtn.onclick = async () => {{
      try {{
        await navigator.clipboard.writeText(codeTextEl.textContent.trim());
        copyBtn.classList.add("copied");
        setTimeout(() => copyBtn.classList.remove("copied"), 1500);
      }} catch (e) {{ /* clipboard permission denied -- code is still visible to copy by hand */ }}
    }};

    // Opened via window.open() (not a plain target="_blank" navigation) so
    // we keep a handle to it -- lets us close that tab ourselves the
    // moment sign-in completes, instead of leaving GitHub's "you're all
    // set" page sitting open after you're already back in the dashboard.
    // Only works if you approved from THIS button; approving from a
    // different device/tab leaves githubWindow null, which is a harmless
    // no-op below.
    let githubWindow = null;
    linkEl.addEventListener("click", (e) => {{
      const w = window.open(linkEl.href, "_blank");
      if (w) {{
        // Got a handle -- stop the anchor's own navigation so this click
        // doesn't ALSO open a second tab via its normal target="_blank".
        e.preventDefault();
        githubWindow = w;
      }}
      // If window.open was blocked (returns null -- a popup-blocking
      // extension, strict Brave Shields settings, etc.), don't
      // preventDefault: let the anchor's own target="_blank" navigation
      // go through normally instead, same as before this feature existed.
      // Auto-close just silently won't apply to that tab.
    }});

    async function poll() {{
      try {{
        const res = await fetch("/auth/device/status");
        const body = await res.json();
        if (body.status === "complete") {{
          statusEl.innerHTML = "Signed in! Redirecting&hellip;";
          if (githubWindow && !githubWindow.closed) {{
            try {{ githubWindow.close(); }} catch (e) {{ /* ignore */ }}
          }}
          window.location.href = "/";
          return;
        }}
        if (body.status === "error") {{
          statusEl.textContent = body.message;
          statusEl.classList.add("err");
          return;
        }}
        // "pending" carries GitHub's current required interval -- when it
        // sends slow_down, that interval goes UP, and polling faster than
        // whatever it just told us guarantees the next poll gets slow_down
        // again too, forever. Always use the latest value it gave us.
        if (body.interval) nextDelayMs = Math.max(body.interval, 3) * 1000;
      }} catch (e) {{
        statusEl.textContent = "Connection error, retrying...";
      }}
      setTimeout(poll, nextDelayMs);
    }}

    document.getElementById("btn-start").onclick = async () => {{
      try {{
        const res = await fetch("/auth/device/start", {{ method: "POST" }});
        const body = await res.json();
        if (!res.ok) {{ statusEl.textContent = body.error || "Could not start sign-in."; return; }}
        codeTextEl.textContent = body.user_code;
        linkEl.href = body.verification_uri;
        stageLogin.classList.add("hidden");
        stageCode.classList.remove("hidden");
        nextDelayMs = Math.max(body.interval, 3) * 1000;
        expiresAt = body.expires_at;
        startExpiryCountdown();
        setTimeout(poll, nextDelayMs);
      }} catch (e) {{
        statusEl.textContent = "Could not reach the server.";
      }}
    }};

    {"setTimeout(poll, nextDelayMs);" if has_pending else ""}
  </script>
</body></html>"""


@server.custom_route("/auth/login", methods=["GET"])
async def auth_login(request: Request):
    if not ghauth.GITHUB_AUTH_ENABLED:
        return JSONResponse({"error": "GitHub sign-in is not configured on this server"}, status_code=404)
    # Reuse an in-flight login unchanged if this browser already has a
    # valid one, rather than always landing on the plain "Sign in" stage --
    # otherwise navigating back to this URL while a code is still being
    # approved would abandon it.
    pending = ghauth.read_device_pending_cookie(request.cookies.get(ghauth.DEVICE_PENDING_COOKIE))
    return Response(_device_login_html(pending), media_type="text/html")


@server.custom_route("/auth/device/start", methods=["POST"])
async def auth_device_start(request: Request):
    if not ghauth.GITHUB_AUTH_ENABLED:
        return JSONResponse({"error": "GitHub sign-in is not configured on this server"}, status_code=404)

    # Same in-flight reuse as /auth/login itself -- clicking "Sign in with
    # GitHub" twice (e.g. a slow first click, then a second while the first
    # request is still in flight) must not mint a second code and silently
    # abandon the first.
    pending = ghauth.read_device_pending_cookie(request.cookies.get(ghauth.DEVICE_PENDING_COOKIE))
    if pending:
        return JSONResponse(
            {
                "user_code": pending["user_code"],
                "verification_uri": pending["verification_uri"],
                "interval": pending["interval"],
                "expires_at": pending["expires_at"],
            }
        )

    try:
        device = await asyncio.to_thread(ghauth.request_device_code)
        user_code = device["user_code"]
        verification_uri = device["verification_uri"]
        interval = device["interval"]
        expires_in = device["expires_in"]
    except Exception as e:
        return JSONResponse({"error": f"could not start GitHub sign-in: {e}"}, status_code=502)

    expires_at = int(time.time()) + expires_in
    resp = JSONResponse(
        {"user_code": user_code, "verification_uri": verification_uri, "interval": interval, "expires_at": expires_at}
    )
    resp.set_cookie(
        ghauth.DEVICE_PENDING_COOKIE,
        ghauth.create_device_pending_cookie_value(device["device_code"], user_code, verification_uri, interval, expires_at),
        max_age=expires_in,
        httponly=True,
        samesite="lax",
    )
    return resp


@server.custom_route("/auth/device/status", methods=["GET"])
async def auth_device_status(request: Request):
    if not ghauth.GITHUB_AUTH_ENABLED:
        return JSONResponse({"status": "error", "message": "GitHub sign-in is not configured on this server"})
    pending = ghauth.read_device_pending_cookie(request.cookies.get(ghauth.DEVICE_PENDING_COOKIE))
    if not pending:
        return JSONResponse({"status": "error", "message": "Login attempt expired -- refresh this page to try again."})
    device_code = pending["device_code"]
    user_code = pending["user_code"]
    verification_uri = pending["verification_uri"]
    interval = pending["interval"]
    expires_at = pending["expires_at"]

    try:
        result = await asyncio.to_thread(ghauth.poll_device_token, device_code)
    except Exception as e:
        return JSONResponse({"status": "error", "message": f"GitHub sign-in failed: {e}"})

    if result.get("access_token"):
        try:
            user = await asyncio.to_thread(ghauth.fetch_github_user, result["access_token"])
            login = user["login"]
        except Exception as e:
            return JSONResponse({"status": "error", "message": f"Signed in, but couldn't read GitHub profile: {e}"})
        resp = JSONResponse({"status": "complete"})
        resp.set_cookie(
            ghauth.SESSION_COOKIE,
            ghauth.create_session_cookie_value(login),
            max_age=ghauth.SESSION_TTL_SECONDS,
            httponly=True,
            samesite="lax",
        )
        resp.delete_cookie(ghauth.DEVICE_PENDING_COOKIE)
        return resp

    error = result.get("error")
    if error == "authorization_pending":
        return JSONResponse({"status": "pending", "interval": interval})
    if error == "slow_down":
        # GitHub's own remedy for polling too fast: it tells us the new,
        # longer interval to use -- if we don't actually honor it (the bug
        # here originally), it keeps demanding an even longer wait forever
        # and the poll can never succeed, no matter how long you wait or
        # how many times you approve the code.
        new_interval = result.get("interval", interval + 5)
        remaining = max(1, expires_at - int(time.time()))
        resp = JSONResponse({"status": "pending", "interval": new_interval})
        resp.set_cookie(
            ghauth.DEVICE_PENDING_COOKIE,
            ghauth.create_device_pending_cookie_value(device_code, user_code, verification_uri, new_interval, expires_at),
            max_age=remaining,
            httponly=True,
            samesite="lax",
        )
        return resp
    if error == "expired_token":
        return JSONResponse({"status": "error", "message": "Code expired -- refresh this page to get a new one."})
    if error == "access_denied":
        return JSONResponse({"status": "error", "message": "Sign-in was denied."})
    return JSONResponse({"status": "error", "message": result.get("error_description") or "Unexpected response from GitHub."})


@server.custom_route("/auth/logout", methods=["GET", "POST"])
async def auth_logout(request: Request):
    resp = RedirectResponse(url="/auth/login" if ghauth.GITHUB_AUTH_ENABLED else "/")
    resp.delete_cookie(ghauth.SESSION_COOKIE)
    return resp


@server.custom_route("/api/auth/me", methods=["GET"])
async def api_auth_me(request: Request):
    if not ghauth.GITHUB_AUTH_ENABLED:
        return JSONResponse({"enabled": False, "login": None})
    login = ghauth.read_session_cookie(request.cookies.get(ghauth.SESSION_COOKIE))
    return JSONResponse({"enabled": True, "login": login})


# ===================================================================================
# DASHBOARD -- REST API
# ===================================================================================


@server.custom_route("/api/server/active-runs", methods=["GET"])
async def api_active_runs(request: Request):
    """How many projects have an init/fmt/validate/plan/apply in flight right
    now -- the dashboard checks this before letting you confirm a restart,
    so the warning can say how many runs it's about to interrupt."""
    return JSONResponse({"count": rm.count_active_runs()})


@server.custom_route("/api/server/terraform-version", methods=["GET"])
async def api_terraform_version(request: Request):
    return JSONResponse({"version": await asyncio.to_thread(rm.get_terraform_version)})


@server.custom_route("/api/notifications/recent", methods=["GET"])
async def api_recent_notifications(request: Request):
    """Cross-project feed of recently finished runs, for the notification
    bell -- polled by the dashboard regardless of which project (if any) is
    currently open."""
    return JSONResponse(rm.list_recent_completions())


@server.custom_route("/api/server/restart", methods=["POST"])
async def api_restart_server(request: Request):
    """Restart the whole dashboard process. No confirmation token here (unlike
    apply) -- the dashboard UI itself gates this behind a confirm dialog,
    since it's a purely local, human-only action; deliberately not exposed
    as an MCP tool."""
    try:
        return JSONResponse(await asyncio.to_thread(rm.restart_server))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/tools/name-availability-services", methods=["GET"])
async def api_name_availability_services(request: Request):
    return JSONResponse(rm.list_name_availability_services())


@server.custom_route("/api/tools/check-name-availability", methods=["POST"])
async def api_check_name_availability(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    missing = [k for k in ("service", "name") if k not in body]
    if missing:
        return JSONResponse({"error": f"missing required field(s): {missing}"}, status_code=400)
    try:
        return JSONResponse(await asyncio.to_thread(rm.check_name_availability, body["service"], body["name"]))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/browse-folder", methods=["POST"])
async def api_browse_folder(request: Request):
    """Pops a native Windows folder picker on this machine and returns the
    chosen path. Blocks (in a worker thread) until the user picks or
    cancels. An optional org_id in the body both seeds the dialog's
    starting folder (from that org's last-browsed path, if any) and gets
    updated with whatever the user picks this time -- a pure convenience
    hint, org_id is optional and this still works with none at all."""
    body, _ = await _json_body(request)
    org_id = (body or {}).get("org_id")
    initial_dir = None
    if org_id:
        org = rm.get_org(org_id)
        if org:
            initial_dir = org.get("last_browsed_path")
    try:
        path = await asyncio.to_thread(rm.open_folder_dialog, initial_dir)
    except RuntimeError as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    if path and org_id:
        await asyncio.to_thread(rm.set_org_last_browsed_path, org_id, path)
    return JSONResponse({"path": path})


@server.custom_route("/api/projects/{project_id}/open-vscode", methods=["POST"])
async def api_open_vscode(request: Request):
    """Launches VS Code on this same machine, pointed at the project's
    deployment folder. Dashboard-only (not an MCP tool) -- opens a GUI
    window on the user's own desktop."""
    try:
        return JSONResponse(await asyncio.to_thread(rm.open_in_vscode, request.path_params["project_id"]))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/project/discover", methods=["POST"])
async def api_discover(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    if "project_root" not in body:
        return JSONResponse({"error": "missing 'project_root'"}, status_code=400)
    try:
        result = rm.discover_project(body["project_root"])
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/project/initialize", methods=["POST"])
async def api_initialize_project_folder(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    if "project_root" not in body:
        return JSONResponse({"error": "missing 'project_root'"}, status_code=400)
    try:
        result = await asyncio.to_thread(rm.initialize_project_folder, body["project_root"])
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/organizations", methods=["GET"])
async def api_list_orgs(request: Request):
    return JSONResponse(rm.list_orgs())


@server.custom_route("/api/organizations", methods=["POST"])
async def api_add_org(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    if "name" not in body:
        return JSONResponse({"error": "missing 'name'"}, status_code=400)
    try:
        # add_org clones the repo for mode="cloud" -- a real network call,
        # so it runs off the event loop like any other git/terraform
        # subprocess call in this file.
        org = await asyncio.to_thread(rm.add_org, body["name"], body.get("mode", "local"), body.get("repo_url"))
        return JSONResponse(org)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/organizations/{org_id}", methods=["DELETE"])
async def api_delete_org(request: Request):
    rm.remove_org(request.path_params["org_id"])
    return JSONResponse({"ok": True})


@server.custom_route("/api/organizations/{org_id}/sync", methods=["POST"])
async def api_sync_org(request: Request):
    """Pull the latest from a Cloud org's repo and pick up any new projects
    someone else pushed. A no-op (returns {"pulled": false, "warning": null})
    for a Local org."""
    try:
        result = await asyncio.to_thread(rm.sync_cloud_org, request.path_params["org_id"])
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects", methods=["GET"])
async def api_list_projects(request: Request):
    return JSONResponse(rm.list_projects(request.query_params.get("org_id")))


@server.custom_route("/api/projects", methods=["POST"])
async def api_add_project(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    missing = [k for k in ("org_id", "name", "project_root", "deployment", "environment") if k not in body]
    if missing:
        return JSONResponse({"error": f"missing required field(s): {missing}"}, status_code=400)
    try:
        project = rm.add_project(
            body["org_id"],
            body["name"],
            body["project_root"],
            body["deployment"],
            body["environment"],
            retention_days=body.get("retention_days"),
        )
        return JSONResponse(project)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}", methods=["GET"])
async def api_get_project(request: Request):
    project = rm.get_project_view(request.path_params["project_id"])
    if project is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(project)


@server.custom_route("/api/projects/{project_id}", methods=["DELETE"])
async def api_delete_project(request: Request):
    rm.remove_project(request.path_params["project_id"])
    return JSONResponse({"ok": True})


@server.custom_route("/api/projects/{project_id}", methods=["PUT"])
async def api_update_project(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    missing = [k for k in ("project_root", "deployment", "environment") if k not in body]
    if missing:
        return JSONResponse({"error": f"missing required field(s): {missing}"}, status_code=400)
    try:
        project = rm.update_project(
            request.path_params["project_id"],
            body["project_root"],
            body["deployment"],
            body["environment"],
            retention_days=body.get("retention_days"),
        )
        return JSONResponse(project)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}/runs", methods=["DELETE"])
async def api_clear_runs(request: Request):
    try:
        rm.clear_runs(request.path_params["project_id"])
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    return JSONResponse({"ok": True})


@server.custom_route("/api/projects/{project_id}/auth-check", methods=["GET"])
async def api_auth_check(request: Request):
    try:
        return JSONResponse(await asyncio.to_thread(rm.check_auth, request.path_params["project_id"]))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=404)


@server.custom_route("/api/projects/{project_id}/tfvars", methods=["GET"])
async def api_tfvars(request: Request):
    try:
        return JSONResponse(await asyncio.to_thread(rm.get_tfvars, request.path_params["project_id"]))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}/state/resources", methods=["GET"])
async def api_state_resources(request: Request):
    """List (address/type/name/highlight attrs) of everything actually
    deployed per the current state -- read-only, no plan or Azure portal
    needed."""
    try:
        return JSONResponse(await asyncio.to_thread(rm.get_state_resources, request.path_params["project_id"]))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}/state/resource", methods=["GET"])
async def api_state_resource_detail(request: Request):
    address = request.query_params.get("address", "")
    try:
        return JSONResponse(await asyncio.to_thread(rm.get_state_resource_detail, request.path_params["project_id"], address))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}/sources", methods=["GET"])
async def api_module_and_provider_sources(request: Request):
    """Modules and required providers this deployment's own .tf files
    declare, parsed straight from source -- not the lock file."""
    try:
        return JSONResponse(await asyncio.to_thread(rm.get_module_and_provider_sources, request.path_params["project_id"]))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}/dependency-graph", methods=["GET"])
async def api_dependency_graph(request: Request):
    """Styled SVG of this project's terraform dependency graph
    (terraform graph | dot -Tsvg, colour-coded by resource category) plus
    its raw edge list, as {svg, edges} -- the edges drive the click-to-
    inspect "what does this depend on" panel. ?group=modules collapses
    each module to a single node -- the per-resource view on a real
    deployment is a hairball, this is the "what depends on what" view
    instead."""
    group_by_module = request.query_params.get("group") == "modules"
    try:
        result = await asyncio.to_thread(rm.get_dependency_graph, request.path_params["project_id"], group_by_module)
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}/files", methods=["GET"])
async def api_list_project_files(request: Request):
    """File tree for the in-app editor's file browser."""
    try:
        return JSONResponse(await asyncio.to_thread(rm.list_project_files, request.path_params["project_id"]))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}/file", methods=["GET"])
async def api_read_project_file(request: Request):
    path = request.query_params.get("path", "")
    try:
        return JSONResponse(await asyncio.to_thread(rm.read_project_file, request.path_params["project_id"], path))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}/file", methods=["PUT"])
async def api_write_project_file(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    if "path" not in body or "content" not in body:
        return JSONResponse({"error": "missing required field(s): path, content"}, status_code=400)
    try:
        result = await asyncio.to_thread(rm.write_project_file, request.path_params["project_id"], body["path"], body["content"])
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=409 if "in progress" in str(e) else 400)


@server.custom_route("/api/projects/{project_id}/versions", methods=["GET"])
async def api_project_versions(request: Request):
    """Terraform CLI version plus the provider versions selected for this
    project's initialized working directory."""
    try:
        return JSONResponse(await asyncio.to_thread(rm.get_project_versions, request.path_params["project_id"]))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/projects/{project_id}/init", methods=["POST"])
async def api_init_project(request: Request):
    try:
        run = rm.init_project(request.path_params["project_id"])
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    return JSONResponse({"run_id": run.id})


@server.custom_route("/api/projects/{project_id}/fmt", methods=["POST"])
async def api_fmt(request: Request):
    """Reformats .tf/.tfvars in place. Takes no body -- there's no read-only
    mode (see run_fmt)."""
    try:
        run = rm.run_fmt(request.path_params["project_id"])
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    return JSONResponse({"run_id": run.id})


@server.custom_route("/api/projects/{project_id}/validate", methods=["POST"])
async def api_validate(request: Request):
    try:
        run = rm.run_validate(request.path_params["project_id"])
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    return JSONResponse({"run_id": run.id})


@server.custom_route("/api/projects/{project_id}/plan", methods=["POST"])
async def api_plan(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    try:
        run = rm.start_plan(
            request.path_params["project_id"], body.get("name", ""), destroy=bool(body.get("destroy", False))
        )
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    return JSONResponse({"run_id": run.id})


@server.custom_route("/api/runs", methods=["GET"])
async def api_runs(request: Request):
    project_id = request.query_params.get("project_id")
    include_checks = request.query_params.get("include_checks") == "true"
    return JSONResponse(rm.list_runs_summary(project_id, include_checks=include_checks))


@server.custom_route("/api/runs/{run_id}", methods=["GET"])
async def api_run_detail(request: Request):
    run_id = request.path_params["run_id"]
    r = rm.get_run(run_id)
    if r is None:
        return JSONResponse({"error": "not found"}, status_code=404)
    return JSONResponse(r.to_dict(include_lines=True))


@server.custom_route("/api/runs/{run_id}/cancel", methods=["POST"])
async def api_cancel_run(request: Request):
    try:
        return JSONResponse(await asyncio.to_thread(rm.cancel_run, request.path_params["run_id"]))
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=409)


@server.custom_route("/api/runs/{run_id}/plan-diff", methods=["GET"])
async def api_plan_diff(request: Request):
    try:
        result = await asyncio.to_thread(rm.get_plan_diff, request.path_params["run_id"])
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/runs/{run_id}/plan-diff/export", methods=["GET"])
async def api_plan_diff_export(request: Request):
    run_id = request.path_params["run_id"]
    fmt = request.query_params.get("format", "json")
    try:
        diff = await asyncio.to_thread(rm.get_plan_diff, run_id)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)

    short_id = run_id[:8]

    if fmt == "csv":
        buf = io.StringIO()
        writer = csv.writer(buf)
        writer.writerow(["action", "address", "type", "name", "changed_fields"])
        for rc in diff["resource_changes"]:
            writer.writerow([rc["action"], rc["address"], rc["type"], rc["name"], "; ".join(rc["changed_fields"])])
        return Response(
            buf.getvalue(),
            media_type="text/csv",
            headers={"Content-Disposition": f'attachment; filename="plan-diff-{short_id}.csv"'},
        )

    if fmt != "json":
        return JSONResponse({"error": f"unknown format '{fmt}' -- use 'json' or 'csv'"}, status_code=400)

    return Response(
        json.dumps(diff, indent=2),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="plan-diff-{short_id}.json"'},
    )


@server.custom_route("/api/runs/{run_id}/compare/{other_run_id}", methods=["GET"])
async def api_compare_plans(request: Request):
    try:
        result = await asyncio.to_thread(
            rm.compare_plans, request.path_params["run_id"], request.path_params["other_run_id"]
        )
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/runs/{run_id}/stream", methods=["GET"])
async def api_run_stream(request: Request):
    run_id = request.path_params["run_id"]
    r = rm.get_run(run_id)
    if r is None:
        return JSONResponse({"error": "not found"}, status_code=404)

    q = r.subscribe()

    async def event_gen():
        while True:
            line = await asyncio.to_thread(q.get)
            if line is None:
                yield "event: done\ndata: end\n\n"
                break
            safe = line.replace("\r", "")
            yield f"data: {safe}\n\n"

    return StreamingResponse(event_gen(), media_type="text/event-stream")


@server.custom_route("/api/apply/request", methods=["POST"])
async def api_apply_request(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    if "plan_run_id" not in body:
        return JSONResponse({"error": "missing 'plan_run_id'"}, status_code=400)
    try:
        result = rm.request_apply_confirmation(body["plan_run_id"])
        return JSONResponse(result)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


@server.custom_route("/api/apply/confirm", methods=["POST"])
async def api_apply_confirm(request: Request):
    body, err = await _json_body(request)
    if err:
        return err
    if "token" not in body:
        return JSONResponse({"error": "missing 'token'"}, status_code=400)
    try:
        run = rm.confirm_apply(body["token"])
        return JSONResponse({"run_id": run.id})
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=400)


# ===================================================================================
# SPA CATCH-ALL ROUTES -- /<org-name> and /<org-name>/<project-name>
# ===================================================================================
#
# Registered LAST (custom_route appends in decoration order, and routes are
# matched in that same order) so every exact-path route above -- app.js,
# style.css, and all /api/* endpoints -- is always tried first. Only requests
# that don't match any of those fall through to these single/double-segment
# catch-alls, which is what makes /<org-name>/<project-name> work without an
# /org/ prefix shadowing the dashboard's own static assets and API.


@server.custom_route("/{org_name}", methods=["GET"])
async def org_deep_link(request: Request):
    """SPA fallback: /<org-name> is a client-side route (app.js reads the
    path and opens that org's projects grid)."""
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), headers=_NO_STORE_HEADERS)


@server.custom_route("/{org_name}/{project_name}", methods=["GET"])
async def project_deep_link(request: Request):
    """SPA fallback: /<org-name>/<project-name> is a client-side route
    (app.js reads the path and opens that project's workspace). Serving the
    same shell here is what makes a direct navigation or a page refresh on
    that URL work, instead of 404ing."""
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), headers=_NO_STORE_HEADERS)


@server.custom_route("/editor/{org_name}/{project_name}", methods=["GET"])
async def editor_deep_link(request: Request):
    """SPA fallback for the in-app file editor's own tab -- see the
    /editor/<org>/<project> route in app.js's restoreFromLocation()."""
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), headers=_NO_STORE_HEADERS)


@server.custom_route("/graph/{org_name}/{project_name}", methods=["GET"])
async def graph_deep_link(request: Request):
    """SPA fallback for the dependency graph's own tab -- see the
    /graph/<org>/<project> route in app.js's restoreFromLocation()."""
    return FileResponse(os.path.join(STATIC_DIR, "index.html"), headers=_NO_STORE_HEADERS)


# ===================================================================================
# DASHBOARD -- in-app terminal (real PTY over a websocket)
# ===================================================================================
# @server.custom_route only registers plain HTTP routes (its `methods`
# param is HTTP-verb-shaped), so this bypasses it and appends a raw
# Starlette WebSocketRoute straight into the same routes list that decorator
# builds up -- streamable_http_app() below consumes that list either way.


async def terminal_ws(websocket: WebSocket):
    project_id = websocket.path_params["project_id"]
    await websocket.accept()
    try:
        session = await asyncio.to_thread(rm.spawn_terminal, project_id)
    except (ValueError, RuntimeError) as e:
        await websocket.send_text(json.dumps({"type": "error", "message": str(e)}))
        await websocket.close()
        return

    async def pump_output():
        loop = asyncio.get_event_loop()
        while True:
            data = await loop.run_in_executor(None, session.output_queue.get)
            if data is None:  # sentinel -- the PTY's own read loop ended (shell exited)
                await websocket.send_text(json.dumps({"type": "exit"}))
                break
            await websocket.send_text(json.dumps({"type": "output", "data": data}))

    output_task = asyncio.create_task(pump_output())
    try:
        while True:
            msg = await websocket.receive_text()
            try:
                parsed = json.loads(msg)
            except json.JSONDecodeError:
                continue
            kind = parsed.get("type")
            if kind == "input":
                await asyncio.to_thread(session.write, parsed.get("data", ""))
            elif kind == "resize":
                await asyncio.to_thread(session.resize, int(parsed.get("rows", 24)), int(parsed.get("cols", 80)))
    except WebSocketDisconnect:
        pass
    finally:
        output_task.cancel()
        await asyncio.to_thread(session.close)


server._custom_starlette_routes.append(WebSocketRoute("/api/projects/{project_id}/terminal/ws", terminal_ws))


# ===================================================================================
# Auth gate -- wraps the whole ASGI app (not just custom_route handlers) so it
# also covers the /mcp mount and the terminal websocket. Two independent,
# both opt-in, checks:
#   - /mcp*        -- MCP_SHARED_SECRET bearer token (see auth.py)
#   - everything else -- GitHub session cookie, once GITHUB_OAUTH_CLIENT_ID/
#     SECRET are configured; unauthenticated page loads get redirected to
#     /auth/login, unauthenticated /api/* calls get a 401 JSON body instead
#     (they're fetch() calls, not navigations, so a redirect would be silent
#     and confusing), unauthenticated websocket connects just get closed.
# ===================================================================================

_PUBLIC_PATH_PREFIXES = ("/auth/", "/vendor/", "/.well-known/")
_PUBLIC_PATHS = {"/style.css", "/app.js", "/api/auth/me", "/favicon.ico"}


class AuthGateMiddleware:
    def __init__(self, inner_app):
        self.inner_app = inner_app

    async def __call__(self, scope, receive, send):
        if scope["type"] not in ("http", "websocket"):
            await self.inner_app(scope, receive, send)
            return

        path = scope["path"]
        headers = dict(scope["headers"])

        if path.startswith("/mcp"):
            auth_header = headers.get(b"authorization", b"").decode()
            if not ghauth.mcp_request_authorized(auth_header):
                if scope["type"] == "websocket":
                    await send({"type": "websocket.close", "code": 4401})
                else:
                    await JSONResponse({"error": "unauthorized"}, status_code=401)(scope, receive, send)
                return
            await self.inner_app(scope, receive, send)
            return

        if not ghauth.GITHUB_AUTH_ENABLED or path.startswith(_PUBLIC_PATH_PREFIXES) or path in _PUBLIC_PATHS:
            await self.inner_app(scope, receive, send)
            return

        cookie_header = headers.get(b"cookie", b"").decode()
        session_token = None
        for part in cookie_header.split(";"):
            name, _, value = part.strip().partition("=")
            if name == ghauth.SESSION_COOKIE:
                session_token = value
                break
        login = ghauth.read_session_cookie(session_token)

        if login:
            await self.inner_app(scope, receive, send)
            return

        if scope["type"] == "websocket":
            await send({"type": "websocket.close", "code": 4401})
            return

        if path.startswith("/api/"):
            await JSONResponse({"error": "not authenticated"}, status_code=401)(scope, receive, send)
            return

        next_param = urllib.parse.quote(path)
        await RedirectResponse(url=f"/auth/login?next={next_param}")(scope, receive, send)


app = AuthGateMiddleware(server.streamable_http_app(host=HOST))


if __name__ == "__main__":
    rm.bootstrap()
    print(f"IaC-Dashboard listening on http://{HOST}:{PORT}")
    print(f"  Dashboard:  http://{HOST}:{PORT}/")
    print(f"  MCP (HTTP): http://{HOST}:{PORT}/mcp")
    if ghauth.GITHUB_AUTH_ENABLED:
        print("  GitHub sign-in: ENABLED -- any GitHub account can sign in.")
    else:
        print("  GitHub sign-in: disabled (GITHUB_OAUTH_CLIENT_ID/SECRET not set) -- dashboard is open, no login.")
    if ghauth.MCP_SHARED_SECRET:
        print("  MCP endpoint: protected by shared secret.")
    else:
        print("  MCP endpoint: open (MCP_SHARED_SECRET not set).")
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
