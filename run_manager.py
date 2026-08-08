"""
Core logic shared by the REST/SSE dashboard endpoints and the MCP tools in
server.py -- single source of truth so a project added, or a run started,
from the browser and from Claude via MCP show up in the same place.

Two persistent concepts:
  - Projects: named, saved {name, project_root, deployment, environment}
    workspaces (projects.json on disk). Add one via discover_project (scan a
    folder) + add_project (name + save it). Multiple can coexist.
  - Runs: init/plan/apply executions against a specific project, tracked
    in-memory for this server process's lifetime.

Nothing about any particular deployment is hardcoded: the state storage
account used to fetch ARM_ACCESS_KEY is read from each project's own
.tfbackend file. Never accepts arbitrary shell input from a request -- only
ever runs `az`, `terraform`, and (for the folder picker) a fixed PowerShell
snippet.
"""

import glob
import json
import os
import re
import queue
import secrets
import shutil
import subprocess
import tempfile

import run_store
import threading
import time
import uuid

CONFIRMATION_TTL_SECONDS = 10 * 60
PLAN_FILE_TTL_SECONDS = 30 * 60

# fmt/validate are quick local sanity checks, not meaningful audit events --
# they're excluded from persisted history and the dashboard's Runs list by
# default (still fully viewable/streamable right after you click them).
PERSISTED_KINDS = {"init", "plan", "apply"}

# All persisted state lives under DATA_DIR -- defaults to right next to this
# script (unchanged native behavior), but is overridable so it can point at
# a mounted volume instead (the Docker image sets IAC_DASHBOARD_DATA_DIR=
# /data) -- otherwise every container rebuild would start from zero with no
# saved organizations/projects/run history.
DATA_DIR = os.environ.get("IAC_DASHBOARD_DATA_DIR", os.path.dirname(__file__))
PROJECTS_FILE = os.path.join(DATA_DIR, "projects.json")
ORGS_FILE = os.path.join(DATA_DIR, "organizations.json")

# Everything a run produces (plan.tfplan, diff.json) lives here, scoped by
# project then run -- NOT inside the actual Terraform repo. Early versions
# put a .dashboard-plans/ folder inside the deployment directory itself,
# which polluted the user's real IaC repo with dashboard bookkeeping; this
# keeps all of that self-contained to the dashboard's own folder instead.
PROJECT_DATA_DIR = os.path.join(DATA_DIR, "project-data")


def _run_data_dir(project_id: str, run_id: str) -> str:
    return os.path.join(PROJECT_DATA_DIR, project_id, "runs", run_id)


class RunInProgressError(ValueError):
    pass


# ===================================================================================
# ORGANIZATIONS (persisted) -- the parent of Projects: /org/<org-name>/<project-name>
# ===================================================================================

_orgs_lock = threading.Lock()


def _load_orgs() -> list[dict]:
    if not os.path.exists(ORGS_FILE):
        return []
    with open(ORGS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_orgs(orgs: list[dict]):
    with open(ORGS_FILE, "w", encoding="utf-8") as f:
        json.dump(orgs, f, indent=2)


def _validate_name(name: str, what: str) -> str:
    """Shared name validation for Organizations and Work Projects: both are
    stable, permanent keys the dashboard's own URLs are built on directly
    (/<org-name>/<project-name>, see server.py's SPA catch-all routes) --
    rejecting spaces (and other whitespace) up front means that URL never
    needs percent-encoding and never looks broken/copy-paste-unfriendly."""
    name = name.strip()
    if not name:
        raise ValueError(f"{what} name cannot be empty")
    if any(c.isspace() for c in name):
        raise ValueError(f"{what} name can't contain spaces -- use '-' or '_' instead (e.g. 'my-{what}')")
    return name


def add_org(name: str) -> dict:
    name = _validate_name(name, "organization")

    org = {"id": str(uuid.uuid4()), "name": name, "created_at": time.time()}
    with _orgs_lock:
        orgs = _load_orgs()
        if any(o["name"] == name for o in orgs):
            raise ValueError(f"an organization named '{name}' already exists -- pick a different name")
        orgs.append(org)
        _save_orgs(orgs)
    return org


def list_orgs() -> list[dict]:
    with _orgs_lock:
        orgs = _load_orgs()
    with _projects_lock:
        projects = _load_projects()
    for o in orgs:
        o["project_count"] = sum(1 for p in projects if p.get("org_id") == o["id"])
    return sorted(orgs, key=lambda o: o["created_at"], reverse=True)


def get_org(org_id: str) -> dict | None:
    with _orgs_lock:
        orgs = _load_orgs()
    return next((o for o in orgs if o["id"] == org_id), None)


def remove_org(org_id: str):
    """Delete an organization and cascade-delete every project inside it
    (each via remove_project, so run history/plan data is cleaned up the
    same way a direct project delete would)."""
    with _projects_lock:
        project_ids = [p["id"] for p in _load_projects() if p.get("org_id") == org_id]
    for pid in project_ids:
        remove_project(pid)

    with _orgs_lock:
        orgs = [o for o in _load_orgs() if o["id"] != org_id]
        _save_orgs(orgs)


# ===================================================================================
# PROJECTS (persisted)
# ===================================================================================

_projects_lock = threading.Lock()


def _is_initialized(project: dict) -> bool:
    """Whether `terraform init` has actually been run for this project's
    deployment directory, decided by looking for the `.terraform/` directory
    terraform creates.

    This used to be an in-memory set of project ids, which meant every
    project reported "not initialized yet this session" after a server
    restart and refused to plan -- even though the real .terraform/ was
    sitting on disk the whole time. Reading the filesystem is the honest
    answer, survives restarts for free, and self-corrects when a project is
    re-pointed at a different folder or deployment."""
    return os.path.isdir(os.path.join(project["project_root"], project["deployment"], ".terraform"))


def _load_projects() -> list[dict]:
    if not os.path.exists(PROJECTS_FILE):
        return []
    with open(PROJECTS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_projects(projects: list[dict]):
    with open(PROJECTS_FILE, "w", encoding="utf-8") as f:
        json.dump(projects, f, indent=2)


def discover_project(project_root: str) -> dict:
    """Validate a folder as a Terraform project: must contain a modules/
    dir and at least one tf-deployment* dir. Returns the environments each
    deployment supports -- an env only counts if it has BOTH
    environmentVariables/terraform.<env>.tfvars AND
    backend/azurerm.<env>.tfbackend (matching the exact env name), since
    both are required for terraform init to actually work. Read-only, no
    side effects -- the scan step before add_project."""
    project_root = os.path.normpath(project_root)
    if not os.path.isdir(project_root):
        raise ValueError(f"'{project_root}' is not a directory")

    modules_found = os.path.isdir(os.path.join(project_root, "modules"))

    deployments = []
    for entry in sorted(os.listdir(project_root)):
        full = os.path.join(project_root, entry)
        if not os.path.isdir(full) or not entry.startswith("tf-deployment"):
            continue
        deployments.append({"name": entry, "environments": _discover_environments(full)})

    if not modules_found:
        raise ValueError(f"no 'modules' directory found under '{project_root}' -- is this the right folder?")
    if not deployments:
        raise ValueError(f"no 'tf-deployment*' directories found under '{project_root}'")

    return {"project_root": project_root, "modules_found": modules_found, "deployments": deployments}


def _discover_environments(deployment_dir: str) -> list[str]:
    """An environment only counts if the SAME <env> name has both
    environmentVariables/terraform.<env>.tfvars AND
    backend/azurerm.<env>.tfbackend -- terraform init needs the backend file
    and terraform plan needs the tfvars file, so an environment missing
    either one can't actually be used.

    The `azurerm.` prefix is required, not merely conventional: _target_for()
    builds the backend path as backend/azurerm.<env>.tfbackend, so accepting
    any prefix here (as an earlier version did, for a since-removed AWS
    option) would offer environments that then fail at init because the file
    the run actually looks for doesn't exist."""
    tfvars_envs = set()
    for path in glob.glob(os.path.join(deployment_dir, "environmentVariables", "terraform.*.tfvars")):
        m = re.search(r"terraform\.([^.]+)\.tfvars$", os.path.basename(path))
        if m:
            tfvars_envs.add(m.group(1))

    backend_envs = set()
    for path in glob.glob(os.path.join(deployment_dir, "backend", "azurerm.*.tfbackend")):
        m = re.search(r"azurerm\.([^.]+)\.tfbackend$", os.path.basename(path))
        if m:
            backend_envs.add(m.group(1))

    return sorted(tfvars_envs & backend_envs)


# ===================================================================================
# NEW-FOLDER SCAFFOLDING ("Initialize new folder" in Add Work Project)
# ===================================================================================

# Azure only, deliberately. An AWS variant existed briefly and was removed:
# init/plan/apply all fetch ARM_ACCESS_KEY unconditionally (see
# _run_terraform), so an AWS project would pass its auth check and then die
# fetching an Azure storage key. Rather than ship a provider that looks
# supported but can't run, AWS is out until that's actually wired up.
_SCAFFOLD = {
    "backend_filename": "azurerm.dev.tfbackend",
    "main_tf": """terraform {
  required_version = ">= 1.5.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }

  backend "azurerm" {}
}

provider "azurerm" {
  subscription_id = var.subscription_id
  features {}
}

variable "subscription_id" {
  type = string
}

variable "resource_group_name" {
  type = string
}

variable "location" {
  type    = string
  default = "qatarcentral"
}
""",
    "backend_tfbackend": """# Fill in with your actual Terraform state backend storage account before running init.
resource_group_name  = "REPLACE_ME-rg"
storage_account_name = "REPLACE_ME"
container_name       = "tfstate"
key                  = "dev.tfstate"
""",
    "tfvars": """subscription_id     = "REPLACE_ME-subscription-id"
resource_group_name = "REPLACE_ME-rg"
location            = "qatarcentral"
""",
}


def initialize_project_folder(project_root: str) -> dict:
    """Scaffold a brand-new Terraform project into an EMPTY folder: an empty
    modules/ dir, and a tf-deployment/ dir with a minimal-but-real main.tf,
    one placeholder "dev" tfvars+tfbackend pair (so the folder is
    immediately usable through the same discover_project/add_project flow as
    an existing folder -- you still need to replace the REPLACE_ME
    placeholders with real values before init will actually succeed).
    Refuses a non-empty folder -- "select existing folder" is the flow for
    anything already populated."""
    project_root = os.path.normpath(project_root)
    if not os.path.isdir(project_root):
        raise ValueError(f"'{project_root}' is not a directory")
    if os.listdir(project_root):
        raise ValueError(
            f"'{project_root}' is not empty -- pick an empty folder to initialize, "
            "or use 'select existing folder' instead"
        )

    tpl = _SCAFFOLD
    deployment_dir = os.path.join(project_root, "tf-deployment")

    os.makedirs(os.path.join(project_root, "modules"), exist_ok=True)
    os.makedirs(os.path.join(deployment_dir, "backend"), exist_ok=True)
    os.makedirs(os.path.join(deployment_dir, "environmentVariables"), exist_ok=True)

    with open(os.path.join(deployment_dir, "main.tf"), "w", encoding="utf-8") as f:
        f.write(tpl["main_tf"])
    with open(os.path.join(deployment_dir, "backend", tpl["backend_filename"]), "w", encoding="utf-8") as f:
        f.write(tpl["backend_tfbackend"])
    with open(os.path.join(deployment_dir, "environmentVariables", "terraform.dev.tfvars"), "w", encoding="utf-8") as f:
        f.write(tpl["tfvars"])

    return discover_project(project_root)


def _validate_retention_days(value) -> int | None:
    """None/""/0 all mean "keep run history forever" (the historical
    behavior, and the default for any project that predates this setting --
    old projects.json records simply lack the key, and .get() reads that the
    same as an explicit None). Otherwise must be a positive whole number of
    days."""
    if value in (None, ""):
        return None
    try:
        days = int(value)
    except (TypeError, ValueError):
        raise ValueError("retention_days must be a whole number of days (or empty/0 for 'keep forever')")
    if days < 0:
        raise ValueError("retention_days can't be negative")
    return days or None


def add_project(
    org_id: str,
    name: str,
    project_root: str,
    deployment: str,
    environment: str,
    cloud_provider: str = "azure",
    retention_days: int | None = None,
) -> dict:
    # Kept as a stored field so an AWS (or other) provider can be added later
    # without migrating existing records -- but only azure is accepted today.
    if cloud_provider != "azure":
        raise ValueError("only 'azure' is supported right now")
    if get_org(org_id) is None:
        raise ValueError("unknown org_id -- create an organization first")

    name = _validate_name(name, "project")
    retention_days = _validate_retention_days(retention_days)

    discovered = discover_project(project_root)
    dep_names = [d["name"] for d in discovered["deployments"]]
    if deployment not in dep_names:
        raise ValueError(f"'{deployment}' is not a tf-deployment* folder under '{project_root}' (found: {dep_names})")

    dep_info = next(d for d in discovered["deployments"] if d["name"] == deployment)
    if environment not in dep_info["environments"]:
        raise ValueError(
            f"environment '{environment}' has no matching tfvars+tfbackend pair for '{deployment}' "
            f"(available: {dep_info['environments']})"
        )

    project = {
        "id": str(uuid.uuid4()),
        "org_id": org_id,
        "name": name,
        "project_root": discovered["project_root"],
        "deployment": deployment,
        "environment": environment,
        "cloud_provider": cloud_provider,
        "retention_days": retention_days,
        "created_at": time.time(),
    }

    with _projects_lock:
        projects = _load_projects()
        if any(p["org_id"] == org_id and p["name"] == name for p in projects):
            raise ValueError(f"a project named '{name}' already exists in this organization -- pick a different name")
        projects.append(project)
        _save_projects(projects)

    return project


def _decorate(project: dict) -> dict:
    """Add derived, non-stored fields to a project before it goes out over
    the API: whether it's init'd, and which tfvars/backend files this
    deployment+environment actually resolves to. Exposing the filenames
    keeps the naming convention defined in exactly one place (_target_for)
    instead of the dashboard's JS re-deriving it and drifting."""
    target = _target_for(project)
    return {
        **project,
        "initialized": _is_initialized(project),
        "tfvars_relative": target["tfvars_relative"],
        "backend_relative": target["backend_relative"],
    }


def list_projects(org_id: str | None = None) -> list[dict]:
    with _projects_lock:
        projects = _load_projects()
    if org_id:
        projects = [p for p in projects if p.get("org_id") == org_id]
    return sorted((_decorate(p) for p in projects), key=lambda p: p["created_at"], reverse=True)


def get_project(project_id: str) -> dict | None:
    """NOTE: returns the raw stored record (no derived fields) -- internal
    callers pass this straight to _target_for. API handlers should use
    get_project_view() so the client sees initialized/tfvars/backend too."""
    with _projects_lock:
        projects = _load_projects()
    return next((p for p in projects if p["id"] == project_id), None)


def get_project_view(project_id: str) -> dict | None:
    project = get_project(project_id)
    return _decorate(project) if project else None


def remove_project(project_id: str):
    with _projects_lock:
        projects = _load_projects()
        projects = [p for p in projects if p["id"] != project_id]
        _save_projects(projects)

    with _runs_lock:
        to_remove = [rid for rid, r in _runs.items() if r.target.get("project_id") == project_id]
        for rid in to_remove:
            del _runs[rid]
    run_store.delete_runs_for_project(project_id)

    project_dir = os.path.join(PROJECT_DATA_DIR, project_id)
    if os.path.isdir(project_dir):
        shutil.rmtree(project_dir, ignore_errors=True)


_UNSET = object()  # distinguishes "caller didn't mention retention_days" (keep existing) from an explicit None (clear it)


def update_project(
    project_id: str, project_root: str, deployment: str, environment: str, retention_days=_UNSET
) -> dict:
    """Change a saved project's folder/deployment/environment in place (same
    id, same name, same run history). Name is deliberately NOT editable --
    it's the stable key the dashboard's /project/<name> URLs are built on,
    so letting it change would break any bookmarked/shared link to this
    project. Delete and re-add it if you genuinely need to rename it.
    Re-validates the new folder/deployment/env the same way add_project
    does. Marks the project as not-yet-initialized again if the folder,
    deployment, or environment actually changed, since the old init no
    longer necessarily applies.

    retention_days left unspecified keeps whatever the project already had
    (so existing callers -- the MCP tool, older saved automations -- don't
    need to know about this field to keep editing the rest); pass it
    explicitly (including None, for "keep forever") to change it."""
    existing = get_project(project_id)
    if existing is None:
        raise ValueError("unknown project_id")

    discovered = discover_project(project_root)
    dep_names = [d["name"] for d in discovered["deployments"]]
    if deployment not in dep_names:
        raise ValueError(f"'{deployment}' is not a tf-deployment* folder under '{project_root}' (found: {dep_names})")

    dep_info = next(d for d in discovered["deployments"] if d["name"] == deployment)
    if environment not in dep_info["environments"]:
        raise ValueError(
            f"environment '{environment}' has no matching tfvars+tfbackend pair for '{deployment}' "
            f"(available: {dep_info['environments']})"
        )

    new_retention = existing.get("retention_days") if retention_days is _UNSET else _validate_retention_days(retention_days)

    # No need to reset any "initialized" flag when the folder/deployment
    # changes -- _is_initialized() reads .terraform/ from whatever directory
    # the project now points at, so it's correct automatically.
    updated = {
        **existing,
        "project_root": discovered["project_root"],
        "deployment": deployment,
        "environment": environment,
        "retention_days": new_retention,
    }

    with _projects_lock:
        projects = _load_projects()
        projects = [updated if p["id"] == project_id else p for p in projects]
        _save_projects(projects)

    return updated


def _target_for(project: dict) -> dict:
    deployment_dir = os.path.join(project["project_root"], project["deployment"])
    return {
        "project_id": project["id"],
        "project_name": project["name"],
        "deployment": project["deployment"],
        "environment": project["environment"],
        "dir": deployment_dir,
        "tfvars_relative": os.path.join("environmentVariables", f"terraform.{project['environment']}.tfvars"),
        "backend_relative": os.path.join("backend", f"azurerm.{project['environment']}.tfbackend"),
    }


def _source_mtimes(target: dict) -> dict:
    result = {}
    for key in ("tfvars_relative", "backend_relative"):
        path = os.path.join(target["dir"], target[key])
        try:
            result[key] = os.path.getmtime(path)
        except OSError:
            result[key] = None
    return result


# ===================================================================================
# TFVARS PARSING -- turns a .tfvars file into real nested dict/list/str/
# number/bool/None values instead of raw text, so the dashboard can show it
# as a pretty key/value tree. Deliberately a small hand-rolled HCL-lite
# parser rather than a real HCL library: tfvars only ever contain literal
# assignments (strings/numbers/bools/null/lists/maps, arbitrarily nested) --
# never expressions, functions, or resource references -- so that's all this
# needs to handle. Falls back to the raw file text (get_tfvars always
# returns that too) on anything it can't parse, same "never block on it,
# just don't show the pretty version" philosophy as get_plan_diff.
# ===================================================================================


class TfvarsParseError(ValueError):
    pass


_TFVARS_TOKEN_SPEC = [
    ("COMMENT", r"(?:\#|//)[^\n]*|/\*.*?\*/"),
    ("STRING", r'"(?:\\.|[^"\\])*"'),
    ("NUMBER", r"-?\d+(?:\.\d+)?"),
    ("NEWLINE", r"\n"),
    ("WS", r"[ \t\r]+"),
    ("IDENT", r"[A-Za-z_][A-Za-z0-9_-]*"),
    ("EQUALS", r"="),
    ("LBRACE", r"\{"),
    ("RBRACE", r"\}"),
    ("LBRACKET", r"\["),
    ("RBRACKET", r"\]"),
    ("COMMA", r","),
    ("MISMATCH", r"."),
]
_TFVARS_TOKEN_RE = re.compile(
    "|".join(f"(?P<{name}>{pattern})" for name, pattern in _TFVARS_TOKEN_SPEC), re.DOTALL
)
_SKIP_TOKEN_KINDS = {"COMMENT", "NEWLINE", "WS"}


def _tokenize_tfvars(text: str) -> list[tuple[str, str]]:
    tokens = []
    for m in _TFVARS_TOKEN_RE.finditer(text):
        kind = m.lastgroup
        if kind in _SKIP_TOKEN_KINDS:
            continue
        if kind == "MISMATCH":
            raise TfvarsParseError(f"unexpected character {m.group()!r} near position {m.start()}")
        tokens.append((kind, m.group()))
    return tokens


def _unquote_tfvars_string(raw: str) -> str:
    inner = raw[1:-1]
    return inner.replace('\\"', '"').replace("\\n", "\n").replace("\\t", "\t").replace("\\\\", "\\")


class _TfvarsParser:
    """Recursive-descent parser over the token stream from _tokenize_tfvars.
    Grammar (informally): document := (key '=' value)*; value := STRING |
    NUMBER | 'true' | 'false' | 'null' | '[' value* ']' | '{' (key '=' value)* '}'."""

    def __init__(self, tokens: list[tuple[str, str]]):
        self.tokens = tokens
        self.i = 0

    def _peek(self) -> tuple[str | None, str | None]:
        return self.tokens[self.i] if self.i < len(self.tokens) else (None, None)

    def _next(self) -> tuple[str | None, str | None]:
        tok = self._peek()
        self.i += 1
        return tok

    def _expect(self, kind: str) -> tuple[str, str]:
        tok = self._next()
        if tok[0] != kind:
            raise TfvarsParseError(f"expected {kind}, got {tok[0] or 'end of file'}")
        return tok

    def _key(self) -> str:
        kind, text = self._next()
        if kind == "IDENT":
            return text
        if kind == "STRING":
            return _unquote_tfvars_string(text)
        raise TfvarsParseError(f"expected a variable/key name, got {kind or 'end of file'}")

    def parse_document(self) -> dict:
        result = {}
        while self._peek()[0] is not None:
            key = self._key()
            self._expect("EQUALS")
            result[key] = self.parse_value()
        return result

    def parse_value(self):
        kind, text = self._next()
        if kind == "STRING":
            return _unquote_tfvars_string(text)
        if kind == "NUMBER":
            return float(text) if "." in text else int(text)
        if kind == "IDENT":
            if text == "true":
                return True
            if text == "false":
                return False
            if text == "null":
                return None
            # a bare identifier as a value means a variable/local reference --
            # tfvars can't actually contain those (only literals), but keep
            # this non-fatal and hand back the raw text rather than aborting
            # the whole file's parse over one odd line.
            return {"__ref__": text}
        if kind == "LBRACKET":
            items = []
            while self._peek()[0] != "RBRACKET":
                items.append(self.parse_value())
                if self._peek()[0] == "COMMA":
                    self._next()
            self._expect("RBRACKET")
            return items
        if kind == "LBRACE":
            obj = {}
            while self._peek()[0] != "RBRACE":
                key = self._key()
                self._expect("EQUALS")
                obj[key] = self.parse_value()
                if self._peek()[0] == "COMMA":
                    self._next()
            self._expect("RBRACE")
            return obj
        raise TfvarsParseError(f"unexpected token {kind or 'end of file'} {text or ''}".strip())


def parse_tfvars(text: str) -> dict:
    return _TfvarsParser(_tokenize_tfvars(text)).parse_document()


def get_tfvars(project_id: str) -> dict:
    """Read and parse a project's tfvars file for the "pretty config" view --
    read-only, no side effects. Always returns the raw file text (so the UI
    can fall back to it), plus `parsed` (a nested dict) when parsing
    succeeded or `parse_error` (a message) when it didn't -- deliberately
    never raises just because the file has something this parser can't
    handle."""
    project = get_project(project_id)
    if project is None:
        raise ValueError("unknown project_id")
    target = _target_for(project)
    path = os.path.join(target["dir"], target["tfvars_relative"])
    try:
        with open(path, "r", encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        raise ValueError(f"could not read {target['tfvars_relative']}: {e}")

    try:
        parsed = parse_tfvars(raw)
        parse_error = None
    except TfvarsParseError as e:
        parsed = None
        parse_error = str(e)

    return {
        "relative_path": target["tfvars_relative"],
        "raw": raw,
        "parsed": parsed,
        "parse_error": parse_error,
    }


_SUBSCRIPTION_ID_RE = re.compile(r'subscription_id\s*=\s*"([^"]+)"')


def _read_expected_subscription(target: dict) -> str | None:
    """The subscription_id this project's tfvars pins, if any."""
    try:
        with open(os.path.join(target["dir"], target["tfvars_relative"]), "r", encoding="utf-8") as f:
            m = _SUBSCRIPTION_ID_RE.search(f.read())
            return m.group(1) if m else None
    except OSError:
        return None


def _azure_auth_state(target: dict) -> dict:
    """Gather everything needed to both decide and *explain* Azure auth.
    Never raises -- callers interpret the state via _auth_verdict()."""
    state = {
        "cli_found": False,
        "logged_in": False,
        "current": None,  # {name, id, user, tenant} of the active az login
        "expected_subscription_id": _read_expected_subscription(target),
        "accessible_count": 0,
        "subscription_ok": None,  # True / False / None = couldn't determine
        "list_failed": False,
    }

    try:
        az = _resolve_executable("az")
    except RuntimeError:
        return state
    state["cli_found"] = True

    show = subprocess.run([az, "account", "show", "-o", "json"], capture_output=True, text=True, timeout=30)
    if show.returncode != 0:
        return state
    state["logged_in"] = True
    try:
        acct = json.loads(show.stdout)
        state["current"] = {
            "name": acct.get("name"),
            "id": acct.get("id"),
            "user": (acct.get("user") or {}).get("name"),
            "tenant": acct.get("tenantId"),
        }
    except json.JSONDecodeError:
        pass

    if state["expected_subscription_id"]:
        lst = subprocess.run(
            [az, "account", "list", "--query", "[].id", "-o", "tsv"], capture_output=True, text=True, timeout=30
        )
        # Distinguish "definitely not accessible" from "couldn't find out".
        # Without this returncode check a failed/slow `az account list` yields
        # an empty list, which then reads as "your account has no access to
        # that subscription" -- accusing the user of a problem they don't
        # have, and blocking a run that would have worked.
        if lst.returncode != 0:
            state["list_failed"] = True
            return state

        # ids are GUIDs; compare case/whitespace-insensitively so a differently
        # cased tfvars value isn't reported as a mismatch
        accessible = {s.strip().lower() for s in lst.stdout.split() if s.strip()}
        state["accessible_count"] = len(accessible)
        state["subscription_ok"] = state["expected_subscription_id"].strip().lower() in accessible

    return state


def _auth_verdict(state: dict, target: dict) -> dict:
    """Turn raw auth state into {authenticated, reason, fix, details} --
    `details` being the human-readable lines the dashboard shows on hover.
    Single source of truth so the pill's explanation and the error that
    blocks init/plan can never drift apart."""
    tfvars = target["tfvars_relative"]
    expected = state["expected_subscription_id"]

    if not state["cli_found"]:
        return {
            "authenticated": False,
            "reason": "Azure CLI ('az') not found on PATH.",
            "fix": "Install the Azure CLI, then run: az login",
            "details": [
                "Azure CLI ('az') was not found on PATH.",
                "The dashboard needs it to authenticate and to fetch the state-storage key.",
                "Fix: install the Azure CLI, then run  az login",
            ],
        }

    if not state["logged_in"]:
        details = [
            "Not signed in to Azure.",
            "Fix: run  az login",
        ]
        if expected:
            details.append(f"This project expects subscription {expected} (from {tfvars}).")
        return {
            "authenticated": False,
            "reason": "Not authenticated to Azure.",
            "fix": "Run: az login",
            "details": details,
        }

    cur = state["current"] or {}
    signed_in_as = cur.get("user") or "unknown account"
    cur_sub = f"{cur.get('name')} ({cur.get('id')})" if cur.get("id") else "unknown subscription"

    if state["subscription_ok"] is False:
        return {
            "authenticated": False,
            "reason": f"Signed-in account has no access to subscription {expected}.",
            "fix": "Either az login with an account that has access, or correct subscription_id in the tfvars.",
            "details": [
                f"Signed in as: {signed_in_as}",
                f"Active subscription: {cur_sub}",
                f"This account can see {state['accessible_count']} subscription(s), "
                f"but NOT {expected}.",
                f"That id comes from subscription_id in {tfvars}.",
                "Fix either side:",
                "  - az login  (to an account with access to that subscription), or",
                f"  - correct subscription_id in {tfvars}",
            ],
        }

    details = [
        "Authenticated to Azure -- init/plan/apply will run against real infrastructure.",
        f"Signed in as: {signed_in_as}",
        f"Active subscription: {cur_sub}",
    ]
    if expected and state.get("list_failed"):
        # authenticated, but we couldn't confirm the subscription -- say so
        # rather than silently implying it was verified
        details.append(f"subscription_id in {tfvars}: {expected}")
        details.append("Could not list your subscriptions to confirm access, so this one is unverified.")
    elif expected:
        details.append(f"subscription_id in {tfvars}: {expected} (accessible to this login).")
    else:
        details.append(f"{tfvars} pins no subscription_id -- the provider decides which subscription is used.")
    if cur.get("tenant"):
        details.append(f"Tenant: {cur['tenant']}")

    return {"authenticated": True, "reason": None, "fix": None, "details": details}


def _check_cloud_auth(project: dict, target: dict):
    """Pre-flight check run before init/plan: verify the current CLI login
    matches what this project needs, so a confusing terraform-level auth
    failure never happens -- fail fast here instead with a clear message.

    Azure: `az account show` must succeed (some account is logged in), AND
    if this project's tfvars references a subscription_id, that id must be
    among the subscriptions the logged-in identity can actually see (`az
    account list`) -- catches "logged into the wrong tenant" as well as
    "not logged in at all".

    Azure is the only supported provider (see _SCAFFOLD), so there's no
    provider branch here. Shares _azure_auth_state/_auth_verdict with the
    check_auth probe the dashboard's status pill uses, so the two can never
    disagree about whether a run would be allowed."""
    verdict = _auth_verdict(_azure_auth_state(target), target)
    if not verdict["authenticated"]:
        raise ValueError(f"{verdict['reason']} {verdict['fix']}")


def check_auth(project_id: str) -> dict:
    """Non-raising probe of the same check that gates init/plan, so the UI can
    show live auth state instead of just asserting "real Azure changes" and
    only finding out it's wrong when a run fails.

    Returns {authenticated, reason, fix, details} -- `details` being
    explanatory lines for the UI to show on hover (who you're signed in as,
    which subscription is active, which one the tfvars asks for, and the
    concrete command to fix a mismatch). Deliberately shares
    _azure_auth_state/_auth_verdict with the pre-flight guard, so if this
    says authenticated, init/plan will not be blocked for auth reasons, and
    vice versa."""
    project = get_project(project_id)
    if project is None:
        raise ValueError("unknown project_id")
    target = _target_for(project)
    return _auth_verdict(_azure_auth_state(target), target)


def _check_plan_not_stale(run: "Run"):
    """Refuse to apply a plan if its tfvars or backend file has changed on
    disk since the plan was generated -- the plan file itself would still
    apply "successfully" but against config that's no longer what's on
    disk, which is exactly the kind of surprise this check exists to catch.
    Fails open (skips the check) if the mtimes were never recorded, e.g. a
    run reloaded from before this feature existed."""
    if not run.source_mtimes:
        return
    current = _source_mtimes(run.target)
    labels = {"tfvars_relative": "the tfvars file", "backend_relative": "the backend file"}
    for key, recorded_mtime in run.source_mtimes.items():
        if recorded_mtime is None:
            continue
        if current.get(key) != recorded_mtime:
            raise ValueError(
                f"{labels.get(key, key)} has changed on disk since this plan was generated -- "
                "re-run plan before applying, this plan no longer reflects what's on disk"
            )


# ===================================================================================
# NATIVE FOLDER PICKER
# ===================================================================================

_FOLDER_PICKER_SCRIPT = """
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# A real WinForms dialog with no owner can open BEHIND other windows (e.g.
# the browser) without stealing focus -- give it a tiny invisible TopMost
# owner form so it's forced to the front and focused.
$owner = New-Object System.Windows.Forms.Form
$owner.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
$owner.Size = New-Object System.Drawing.Size(0, 0)
$owner.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::None
$owner.ShowInTaskbar = $false
$owner.TopMost = $true
$owner.Show()
$owner.Activate()

$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "Select the IaC project folder (contains modules/ and tf-deployment*)"
$dialog.ShowNewFolderButton = $false

$result = $dialog.ShowDialog($owner)
$owner.Close()

if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    Write-Output $dialog.SelectedPath
}
"""


def open_folder_dialog() -> str | None:
    """Pop a native Windows folder-browser dialog on this machine (the
    server and the browser are on the same box for this tool) and return
    the chosen path, or None if the user cancelled. Blocks the calling
    thread until the dialog closes -- callers must run this off the event
    loop (asyncio.to_thread).

    Windows-only (WinForms via PowerShell) -- inside a Linux container (or
    any non-Windows host) there's no GUI to pop a dialog on anyway, so this
    fails fast with a message telling the user to type the path instead,
    rather than a confusing 'powershell not found' error."""
    if os.name != "nt":
        raise RuntimeError(
            "the native folder browser is Windows-only -- type the project path directly "
            "(e.g. a path under a volume you mounted, like /workspace/my-project)"
        )
    powershell_exe = _resolve_executable("powershell")
    result = subprocess.run(
        [powershell_exe, "-NoProfile", "-NonInteractive", "-Sta", "-Command", _FOLDER_PICKER_SCRIPT],
        capture_output=True,
        text=True,
        timeout=300,
    )
    path = result.stdout.strip()
    return path or None


def open_in_vscode(project_id: str) -> dict:
    """Launch VS Code (the `code` CLI) pointed at this project's ROOT folder
    (not just the deployment subfolder) on this same machine -- a
    convenience action, same spirit as open_folder_dialog above. Opening
    just the deployment folder would hide the sibling modules/ directory
    its own .tf files actually reference (relative paths), so the project
    root -- modules/ and every tf-deployment*/ side by side -- is what's
    actually useful to have open. Dashboard-only, not an MCP tool: this
    opens a GUI window on the user's own desktop, which isn't something an
    agent should trigger on your behalf. Fails clearly if `code` isn't on
    PATH (fresh installs need "Shell Command: Install 'code' command in
    PATH" from VS Code's own Command Palette) or if this dashboard is
    running somewhere with no desktop to open a window on (e.g. Docker)."""
    project = get_project(project_id)
    if project is None:
        raise ValueError("unknown project_id")

    try:
        code_exe = _resolve_executable("code")
    except RuntimeError:
        raise ValueError(
            "VS Code's 'code' command isn't on PATH -- in VS Code, open the Command Palette and run "
            "\"Shell Command: Install 'code' command in PATH\", then try again"
        )

    try:
        subprocess.Popen([code_exe, project["project_root"]], close_fds=True)
    except OSError as e:
        raise ValueError(f"could not launch VS Code: {e}")

    return {"ok": True, "path": project["project_root"]}


def count_active_runs() -> int:
    """How many projects currently have an init/fmt/validate/plan/apply in
    flight -- used by the dashboard to warn "this will interrupt N run(s)"
    before a restart, rather than just a generic warning."""
    with _runs_lock:
        return len(_active_run_by_project)


def restart_server() -> dict:
    """Restart this whole server process via the same stop.ps1/start.ps1
    PID-file mechanism the user would run by hand -- spawns a short,
    detached PowerShell script that waits a couple seconds (long enough for
    this request's HTTP response to actually reach the browser first), then
    runs stop.ps1 (which kills *this* process by its own PID) followed by
    start.ps1 (which launches the replacement). Deliberately not exposed as
    an MCP tool -- restarting is disruptive (kills any run currently in
    flight) and should only ever be a deliberate human action from the
    dashboard, never something an agent decides to do on its own.

    Windows-only (stop.ps1/start.ps1 are PowerShell) -- running in Docker,
    restart the container instead (`docker compose restart`), which
    achieves the same thing without needing this at all."""
    if os.name != "nt":
        raise ValueError(
            "self-restart isn't supported outside Windows -- if this is running in Docker, "
            "restart the container instead (`docker compose restart`)"
        )
    root = os.path.dirname(__file__)
    stop_script = os.path.join(root, "stop.ps1")
    start_script = os.path.join(root, "start.ps1")
    script = (
        "Start-Sleep -Seconds 2\n"
        f'& "{stop_script}"\n'
        "Start-Sleep -Seconds 1\n"
        f'& "{start_script}"\n'
    )
    fd, script_path = tempfile.mkstemp(suffix=".ps1", prefix="iac-dashboard-restart-")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(script)

    powershell_exe = _resolve_executable("powershell")
    # CREATE_NO_WINDOW, not DETACHED_PROCESS: powershell.exe tries to
    # allocate a console for itself on launch, and DETACHED_PROCESS (no
    # console at all) makes that allocation hang indefinitely -- the script
    # never even reaches its first line. CREATE_NO_WINDOW gives it a real
    # (just invisible) console instead, which is what actually lets it run
    # unattended. stdin/out/err are explicitly closed rather than inherited
    # from this process's own (already redirected-to-a-logfile) handles.
    subprocess.Popen(
        [powershell_exe, "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script_path],
        creationflags=subprocess.CREATE_NO_WINDOW,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
    return {"ok": True, "note": "restarting -- the dashboard will be unreachable for a few seconds"}


# ===================================================================================
# RUNS
# ===================================================================================


class Run:
    def __init__(self, run_id: str, kind: str, target: dict, name: str = "", is_destroy: bool = False):
        self.id = run_id
        self.kind = kind  # "init" | "fmt" | "validate" | "plan" | "apply"
        self.target = target
        self.name = name  # user-given label, e.g. "before refactor" -- required for plan runs
        self.is_destroy = is_destroy  # True for a `plan -destroy` (and the apply run made from it)
        self.status = "queued"  # queued | running | success | failed
        self.lines: list[str] = []
        self.subscribers: list["queue.Queue"] = []
        self.lock = threading.Lock()
        self.summary: dict | None = None
        self.plan_file: str | None = None
        self.source_mtimes: dict | None = None  # {tfvars: mtime, backend: mtime} recorded at plan time
        self.plan_diff_cache: dict | None = None  # computed once right after the plan finishes -- see get_plan_diff
        self.related_plan_run_id: str | None = None
        self.proc: subprocess.Popen | None = None  # live terraform process, so cancel_run can kill it
        self.cancelled = False
        self.created_at = time.time()
        self.finished_at: float | None = None

    def append(self, line: str):
        with self.lock:
            self.lines.append(line)
            for q in self.subscribers:
                q.put(line)

    def close(self, status: str):
        with self.lock:
            self.status = status
            self.finished_at = time.time()
            for q in self.subscribers:
                q.put(None)
        if self.kind in PERSISTED_KINDS:
            run_store.save_run(self)
            _enforce_retention(self.target.get("project_id"))

    @classmethod
    def from_persisted(cls, d: dict) -> "Run":
        """Rehydrate a finished (or crash-recovered) run loaded from
        run_store -- no live subscribers, since nothing's streaming to it
        anymore."""
        run = cls(d["run_id"], d["kind"], d["target"], name=d["name"], is_destroy=d["is_destroy"])
        run.status = d["status"]
        run.lines = d["lines"]
        run.summary = d["summary"]
        run.plan_file = d["plan_file"]
        run.related_plan_run_id = d["related_plan_run_id"]
        run.created_at = d["created_at"]
        run.finished_at = d["finished_at"]
        return run

    def subscribe(self) -> "queue.Queue":
        q: "queue.Queue" = queue.Queue()
        with self.lock:
            for line in self.lines:
                q.put(line)
            if self.status in ("success", "failed"):
                q.put(None)
            else:
                self.subscribers.append(q)
        return q

    def to_dict(self, include_lines: bool = False) -> dict:
        d = {
            "run_id": self.id,
            "kind": self.kind,
            "name": self.name,
            "is_destroy": self.is_destroy,
            "target": self.target,
            "status": self.status,
            "summary": self.summary,
            "created_at": self.created_at,
            "finished_at": self.finished_at,
            "related_plan_run_id": self.related_plan_run_id,
        }
        if include_lines:
            d["lines"] = self.lines
        return d


_runs: dict[str, Run] = {}
_pending_confirmations: dict[str, dict] = {}
_runs_lock = threading.Lock()
_active_run_by_project: dict[str, str] = {}  # project_id -> run_id currently in flight for it


def _resolve_executable(name: str) -> str:
    """`az`/`powershell` (and other CLI tools) are .cmd/.exe-resolved-via-PATHEXT
    on Windows -- subprocess won't resolve those from a bare name without
    shell=True, so look up the real path via PATHEXT instead."""
    resolved = shutil.which(name)
    if resolved is None:
        raise RuntimeError(f"'{name}' not found on PATH")
    return resolved


_TFBACKEND_KV_RE = re.compile(r'^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"', re.MULTILINE)


def _parse_tfbackend(path: str) -> dict:
    """Parse a .tfbackend file's `key = "value"` lines. Comments (#) are
    skipped implicitly because the regex is anchored to the start of a line
    and requires an identifier first."""
    try:
        with open(path, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError as e:
        raise RuntimeError(f"could not read backend config '{path}': {e}")
    return {m.group(1): m.group(2) for m in _TFBACKEND_KV_RE.finditer(content)}


def _get_arm_access_key(target: dict) -> str:
    """Fetch the state-storage account key for THIS project, reading the
    account and resource group out of the project's own .tfbackend file.

    These were originally two module-level constants hardcoded to one
    sandbox's storage account, which meant every project -- whatever its
    backend actually said -- had the key of that one account fetched for it.
    Any project on a different storage account simply could not init, and the
    "Initialize new folder" scaffold (which writes a REPLACE_ME account) could
    never work even once you filled it in. The .tfbackend file already
    declares both values, so it's the honest source."""
    backend_path = os.path.join(target["dir"], target["backend_relative"])
    cfg = _parse_tfbackend(backend_path)

    account = cfg.get("storage_account_name")
    group = cfg.get("resource_group_name")
    missing = [k for k, v in (("storage_account_name", account), ("resource_group_name", group)) if not v]
    if missing:
        raise RuntimeError(
            f"{', '.join(missing)} missing from {target['backend_relative']} -- "
            "needed to fetch the state storage account key"
        )
    if "REPLACE_ME" in f"{account}{group}":
        raise RuntimeError(
            f"{target['backend_relative']} still contains REPLACE_ME placeholders -- "
            "fill in your real storage account and resource group before running init"
        )

    result = subprocess.run(
        [
            _resolve_executable("az"),
            "storage",
            "account",
            "keys",
            "list",
            "--account-name",
            account,
            "-g",
            group,
            "--query",
            "[0].value",
            "-o",
            "tsv",
        ],
        capture_output=True,
        text=True,
        timeout=30,
    )
    key = result.stdout.strip()
    if result.returncode != 0 or not key:
        raise RuntimeError(
            f"az storage account keys list failed for account '{account}' in group '{group}': "
            f"{result.stderr.strip()}"
        )
    return key


_PLAN_SUMMARY_RE = re.compile(
    r"Plan:\s*(\d+)\s*to add,\s*(\d+)\s*to change,\s*(\d+)\s*to destroy"
)


def _parse_plan_summary(lines: list[str]) -> dict:
    for line in lines:
        if "No changes." in line:
            return {"add": 0, "change": 0, "destroy": 0, "no_changes": True}
        m = _PLAN_SUMMARY_RE.search(line)
        if m:
            return {
                "add": int(m.group(1)),
                "change": int(m.group(2)),
                "destroy": int(m.group(3)),
                "no_changes": False,
            }
    return {
        "add": None,
        "change": None,
        "destroy": None,
        "no_changes": False,
        "note": "no summary line found -- check log, run likely errored",
    }


def _acquire_active(project_id: str, run_id: str):
    with _runs_lock:
        existing = _active_run_by_project.get(project_id)
        if existing is not None:
            active = _runs.get(existing)
            active_status = active.status if active else "unknown"
            raise RunInProgressError(
                f"another run ({existing[:8]}, status={active_status}) is already in "
                "progress for this project -- wait for it to finish before starting another"
            )
        _active_run_by_project[project_id] = run_id


def _release_active(project_id: str, run_id: str):
    with _runs_lock:
        if _active_run_by_project.get(project_id) == run_id:
            del _active_run_by_project[project_id]


def _register_run(run: "Run"):
    """Add a freshly-created run to the in-memory dict and persist its
    initial (queued/running) state immediately -- so if the server dies
    mid-run, there's still a record of it (bootstrap() below reconciles a
    still-'running' row into an honest 'failed' on the next startup)."""
    with _runs_lock:
        _runs[run.id] = run
    if run.kind in PERSISTED_KINDS:
        run_store.save_run(run)


def _gc_run_data():
    """Reclaim disk under project-data/. Two rules:

      - A run directory whose run no longer exists (history cleared, or the
        server died between makedirs and registering the run) is deleted
        outright.
      - Otherwise the big binary `plan.tfplan` is deleted once the run is
        past PLAN_FILE_TTL_SECONDS, since an expired plan can never be
        applied anyway (request_apply_confirmation rejects it on age). The
        small `diff.json` is kept forever, so the structured diff of a
        historic plan stays viewable indefinitely -- get_plan_diff reads the
        cache and never needs the .tfplan back.

    Called at startup and after each plan; failures are ignored, since this
    is opportunistic housekeeping and must never break a run."""
    if not os.path.isdir(PROJECT_DATA_DIR):
        return
    now = time.time()
    for project_id in os.listdir(PROJECT_DATA_DIR):
        runs_dir = os.path.join(PROJECT_DATA_DIR, project_id, "runs")
        if not os.path.isdir(runs_dir):
            continue
        for run_id in os.listdir(runs_dir):
            run_dir = os.path.join(runs_dir, run_id)
            run = _runs.get(run_id)
            try:
                if run is None:
                    shutil.rmtree(run_dir, ignore_errors=True)
                    continue
                plan_file = os.path.join(run_dir, "plan.tfplan")
                if os.path.exists(plan_file) and now - run.created_at > PLAN_FILE_TTL_SECONDS:
                    os.remove(plan_file)
                    run.plan_file = None
            except OSError:
                pass


def _enforce_retention(project_id: str | None):
    """Delete finished init/plan/apply runs older than that project's own
    `retention_days` -- a per-project opt-in (unset/0 means "keep forever",
    the historical behavior, so every project that predates this setting is
    unaffected). A run still queued/running is never touched regardless of
    age (there isn't one this old in practice, but the check is there so
    this can never race a run that's still writing to itself).

    Called after every init/plan/apply finishes (see Run.close) and once at
    startup (covering runs that aged past the limit while the server was
    down, or a retention_days lowered via update_project) -- so cleanup
    happens automatically rather than needing a cron job or a button."""
    if not project_id:
        return
    project = get_project(project_id)
    if project is None:
        return
    days = project.get("retention_days")
    if not days:
        return
    cutoff = time.time() - days * 86400

    with _runs_lock:
        to_remove = [
            rid
            for rid, r in _runs.items()
            if r.target.get("project_id") == project_id
            and r.kind in PERSISTED_KINDS
            and r.status in ("success", "failed")
            and r.created_at < cutoff
        ]
        for rid in to_remove:
            del _runs[rid]

    for rid in to_remove:
        run_store.delete_run(rid)
        run_dir = _run_data_dir(project_id, rid)
        if os.path.isdir(run_dir):
            shutil.rmtree(run_dir, ignore_errors=True)


def bootstrap():
    """Call once at server startup: rehydrate run history from disk so a
    restart doesn't wipe it. Does NOT touch
    _active_run_by_project -- those are inherently tied to this process's
    actual terraform subprocesses, which are gone regardless."""
    for d in run_store.load_all_runs():
        run = Run.from_persisted(d)
        _runs[run.id] = run
    _gc_run_data()  # after loading, so runs still in history aren't mistaken for orphans
    with _projects_lock:
        projects = _load_projects()
    for p in projects:
        _enforce_retention(p["id"])


def _run_terraform(run: Run, cwd: str, args: list[str], needs_arm_key: bool = True):
    project_id = run.target["project_id"]
    run.status = "running"
    try:
        env = dict(os.environ)
        if needs_arm_key:
            try:
                env["ARM_ACCESS_KEY"] = _get_arm_access_key(run.target)
            except Exception as e:  # noqa: BLE001 - surface any failure into the run log
                run.append(f"ERROR fetching ARM_ACCESS_KEY: {e}")
                run.close("failed")
                return

        try:
            terraform_exe = _resolve_executable("terraform")
        except RuntimeError as e:
            run.append(f"ERROR: {e}")
            run.close("failed")
            return

        try:
            proc = subprocess.Popen(
                [terraform_exe, *args],
                cwd=cwd,
                env=env,
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,
            )
        except FileNotFoundError:
            run.append("ERROR: terraform executable not found on PATH")
            run.close("failed")
            return

        run.proc = proc
        assert proc.stdout is not None
        for line in proc.stdout:
            run.append(line.rstrip("\n"))
        code = proc.wait()
        if run.cancelled:
            run.append("")
            run.append("-- cancelled by user --")
            run.close("failed")
        else:
            run.close("success" if code == 0 else "failed")
    finally:
        run.proc = None
        _release_active(project_id, run.id)


def cancel_run(run_id: str) -> dict:
    """Kill the terraform process for an in-flight run, freeing the
    one-run-at-a-time lock on its project (previously a hung run held that
    lock until the whole server was restarted).

    Kills the whole process tree, not just terraform itself: terraform
    launches each provider as a child process, and killing only the parent
    leaves those orphaned and still holding the state lock.

    Cancelling `apply` is genuinely risky and callers must warn about it --
    terraform may have already created some resources (so state can be left
    partially applied) and a hard kill can leave the state file locked,
    needing `terraform force-unlock`. Cancelling init/fmt/validate/plan is
    safe; none of them mutate infrastructure."""
    run = _runs.get(run_id)
    if run is None:
        raise ValueError("unknown run_id")
    if run.status not in ("queued", "running"):
        raise ValueError(f"run is not in progress (status={run.status})")

    run.cancelled = True
    proc = run.proc
    if proc is None:
        # Still in the queued window before Popen -- mark it and let the
        # thread notice; nothing to kill yet.
        return {"ok": True, "note": "run marked cancelled before terraform started"}

    killed_tree = False
    if os.name == "nt":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
                timeout=15,
                check=False,
            )
            killed_tree = True
        except (OSError, subprocess.SubprocessError):
            pass
    if not killed_tree:
        proc.terminate()

    return {"ok": True, "run_id": run_id, "was": run.kind}


def init_project(project_id: str) -> Run:
    project = get_project(project_id)
    if project is None:
        raise ValueError("unknown project_id")
    target = _target_for(project)
    _check_cloud_auth(project, target)

    run_id = str(uuid.uuid4())
    _acquire_active(project_id, run_id)
    run = Run(run_id, "init", target)
    _register_run(run)

    def _do():
        _run_terraform(
            run,
            target["dir"],
            ["init", f"-backend-config={target['backend_relative']}", "-reconfigure", "-no-color"],
        )

    threading.Thread(target=_do, daemon=True).start()
    return run


def run_fmt(project_id: str) -> Run:
    """`terraform fmt -recursive` over the deployment directory: rewrites
    any badly-formatted .tf/.tfvars files in place and logs which ones it
    touched. Purely local -- no ARM/Azure calls, no init required -- and
    only ever changes whitespace/alignment, never what the config means.

    There deliberately isn't a read-only `-check` mode. It existed, and was
    dropped as useless: since formatting is cosmetic and idempotent,
    "tell me which files are misformatted" is strictly less useful than
    just fixing them.

    `-recursive` is essential. Without it terraform only looks at *.tf in
    the directory it's pointed at, so the tfvars under environmentVariables/
    -- the files most likely to be hand-edited and misaligned -- were
    silently never touched. Terraform still only formats the extensions it
    recognizes (.tf/.tfvars), so backend/*.tfbackend files are left alone
    regardless.

    Also note `-diff` is deliberately absent: terraform implements it by
    shelling out to a Unix `diff` binary that doesn't exist on Windows, so
    it failed with `exec: "diff": executable file not found in %PATH%`."""
    project = get_project(project_id)
    if project is None:
        raise ValueError("unknown project_id")
    target = _target_for(project)

    run_id = str(uuid.uuid4())
    _acquire_active(project_id, run_id)
    run = Run(run_id, "fmt", target)
    _register_run(run)

    def _do():
        _run_terraform(run, target["dir"], ["fmt", "-recursive", "-no-color"], needs_arm_key=False)

    threading.Thread(target=_do, daemon=True).start()
    return run


def run_validate(project_id: str) -> Run:
    """`terraform validate` -- checks config/schema only, no ARM/Azure
    calls, but DOES need init to have run at least once (provider schemas
    come from .terraform/)."""
    project = get_project(project_id)
    if project is None:
        raise ValueError("unknown project_id")
    if not _is_initialized(project):
        raise ValueError("project has not been initialized yet -- call init_project first")
    target = _target_for(project)

    run_id = str(uuid.uuid4())
    _acquire_active(project_id, run_id)
    run = Run(run_id, "validate", target)
    _register_run(run)

    def _do():
        _run_terraform(run, target["dir"], ["validate", "-no-color"], needs_arm_key=False)

    threading.Thread(target=_do, daemon=True).start()
    return run


def start_plan(project_id: str, name: str, destroy: bool = False) -> Run:
    name = (name or "").strip()
    if not name:
        raise ValueError("every plan run needs a name -- pass a short label (e.g. 'before refactor')")

    project = get_project(project_id)
    if project is None:
        raise ValueError("unknown project_id")
    if not _is_initialized(project):
        raise ValueError("project has not been initialized yet -- call init_project first")
    target = _target_for(project)
    _check_cloud_auth(project, target)

    run_id = str(uuid.uuid4())
    _acquire_active(project_id, run_id)

    # Each run gets its own directory -- under this dashboard's own
    # project-data/<project_id>/runs/<run_id>/, NOT inside the Terraform repo
    # itself -- holding everything that run produced (plan.tfplan, and
    # diff.json once computed below). Keeping them together means the
    # plan-diff cache can be read straight off disk on a cold get_plan_diff()
    # call (e.g. after a server restart, when the in-memory
    # Run.plan_diff_cache is gone) instead of re-shelling out to
    # `terraform show -json` every time.
    run_dir = _run_data_dir(project_id, run_id)
    os.makedirs(run_dir, exist_ok=True)
    plan_file = os.path.join(run_dir, "plan.tfplan")

    run = Run(run_id, "plan", target, name=name, is_destroy=destroy)
    run.source_mtimes = _source_mtimes(target)
    _register_run(run)

    def _do():
        args = ["plan", f"-var-file={target['tfvars_relative']}", f"-out={plan_file}", "-no-color"]
        if destroy:
            args.append("-destroy")
        _run_terraform(run, target["dir"], args)
        # run.close() (inside _run_terraform) already persisted this run --
        # but summary/plan_file are only known afterward, so re-persist now
        # that they're set, or the DB copy is permanently stuck without them.
        run.summary = _parse_plan_summary(run.lines)
        run.plan_file = plan_file if run.status == "success" else None
        run_store.save_run(run)

        if run.status == "success":
            try:
                run.plan_diff_cache = _compute_plan_diff(run)
                with open(os.path.join(run_dir, "diff.json"), "w", encoding="utf-8") as f:
                    json.dump(run.plan_diff_cache, f)
            except (ValueError, OSError):
                pass  # get_plan_diff() will just recompute (and surface any error) on demand

        _gc_run_data()  # sweep expired .tfplan files from earlier runs

    threading.Thread(target=_do, daemon=True).start()
    return run


_ACTION_MAP = {
    frozenset(["no-op"]): "no-op",
    frozenset(["create"]): "create",
    frozenset(["update"]): "update",
    frozenset(["delete"]): "delete",
    frozenset(["delete", "create"]): "replace",
    frozenset(["create", "delete"]): "replace",
    frozenset(["read"]): "read",
}


def _classify_actions(actions: list[str]) -> str:
    return _ACTION_MAP.get(frozenset(actions), "/".join(actions))


def _redact_sensitive(values: dict, sensitive_marks) -> dict:
    """terraform show -json does NOT redact sensitive values in
    before/after itself -- it ships them in cleartext alongside a separate
    *_sensitive map marking which top-level keys are sensitive (CMK key
    URIs, connection strings, etc. in this repo's modules). Redact those
    before this ever reaches a browser or an MCP response."""
    if not isinstance(values, dict):
        return values
    marks = sensitive_marks if isinstance(sensitive_marks, dict) else {}
    return {k: ("(sensitive value)" if marks.get(k) is True else v) for k, v in values.items()}


def _differing_keys(a: dict, b: dict) -> set:
    a, b = a or {}, b or {}
    return {k for k in set(a.keys()) | set(b.keys()) if a.get(k) != b.get(k)}


def get_plan_diff(run_id: str) -> dict:
    """Parse a completed plan's saved .tfplan file (via `terraform show
    -json`) into a resource-by-resource create/update/delete/replace table
    -- the structured alternative to scrolling the raw plan log. Works on
    any plan run whose .tfplan file still exists, historic ones included.
    Returns instantly from cache (in-memory, or the on-disk diff.json next
    to that run's plan.tfplan if the server restarted since) for any plan
    that finished successfully -- start_plan computes and writes that cache
    proactively, right after the plan itself finishes, specifically so this
    never has to re-shell out to `terraform show -json` -- and its couple
    of seconds of real subprocess latency -- at the moment you actually
    want to look."""
    run = _runs.get(run_id)
    if run is None:
        raise ValueError("unknown run_id")
    if run.kind != "plan":
        raise ValueError("run is not a plan")
    if run.plan_diff_cache is not None:
        return run.plan_diff_cache

    if run.plan_file:
        diff_file = os.path.join(os.path.dirname(run.plan_file), "diff.json")
        if os.path.exists(diff_file):
            try:
                with open(diff_file, "r", encoding="utf-8") as f:
                    run.plan_diff_cache = json.load(f)
                return run.plan_diff_cache
            except (OSError, json.JSONDecodeError):
                pass  # fall through to recomputing below

    return _compute_plan_diff(run)


def _compute_plan_diff(run: "Run") -> dict:
    if run.status != "success":
        raise ValueError(f"plan run is not successful (status={run.status})")
    if not run.plan_file or not os.path.exists(run.plan_file):
        raise ValueError("saved plan file is missing or expired -- re-run plan")

    terraform_exe = _resolve_executable("terraform")
    result = subprocess.run(
        [terraform_exe, "show", "-json", run.plan_file],
        cwd=run.target["dir"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=60,
    )
    if result.returncode != 0:
        raise ValueError(f"terraform show -json failed: {result.stderr.strip()[:500]}")

    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise ValueError(f"could not parse terraform show -json output: {e}")

    resource_changes = []
    for rc in data.get("resource_changes", []):
        actions = rc["change"]["actions"]
        if actions == ["no-op"]:
            continue
        action = _classify_actions(actions)

        before = rc["change"].get("before") or {}
        after = rc["change"].get("after") or {}
        after_unknown = rc["change"].get("after_unknown") or {}
        changed_fields = []
        if action in ("update", "replace"):
            for key in sorted(set(before.keys()) | set(after.keys())):
                if before.get(key) != after.get(key):
                    changed_fields.append(key)

        resource_changes.append(
            {
                "address": rc["address"],
                "type": rc["type"],
                "name": rc["name"],
                "action": action,
                "changed_fields": changed_fields,
                "before": _redact_sensitive(before, rc["change"].get("before_sensitive")),
                "after": _redact_sensitive(after, rc["change"].get("after_sensitive")),
                # keys present here (regardless of value) won't be known until apply --
                # e.g. an id generated by Azure -- shown as "(known after apply)"
                "unknown_after_apply": sorted(k for k, v in after_unknown.items() if v is True),
            }
        )

    return {"run_id": run.id, "resource_changes": resource_changes, "total": len(resource_changes)}


def compare_plans(run_id_a: str, run_id_b: str) -> dict:
    """Compare two plan runs for the SAME project, resource by resource --
    for catching "why does this look different from last time" drift rather
    than just reviewing one plan in isolation. Only returns entries that
    actually differ between the two (a resource identically present/absent
    in both isn't noise worth showing). Always labeled older/newer by
    created_at, regardless of the order the two ids were passed in."""
    run_a = _runs.get(run_id_a)
    run_b = _runs.get(run_id_b)
    if run_a is None or run_b is None:
        raise ValueError("one or both run_ids are unknown")
    if run_a.kind != "plan" or run_b.kind != "plan":
        raise ValueError("both runs must be plans")
    if run_a.id == run_b.id:
        raise ValueError("pick two different plan runs to compare")
    if run_a.target["project_id"] != run_b.target["project_id"]:
        raise ValueError("both plans must be for the same project")

    older, newer = (run_a, run_b) if run_a.created_at <= run_b.created_at else (run_b, run_a)

    diff_older = get_plan_diff(older.id)
    diff_newer = get_plan_diff(newer.id)
    by_address_older = {rc["address"]: rc for rc in diff_older["resource_changes"]}
    by_address_newer = {rc["address"]: rc for rc in diff_newer["resource_changes"]}

    differences = []
    for address in sorted(set(by_address_older) | set(by_address_newer)):
        a = by_address_older.get(address)
        b = by_address_newer.get(address)

        if a is None:
            differences.append(
                {"address": address, "type": b["type"], "name": b["name"], "status": "added_in_newer_plan", "newer_action": b["action"]}
            )
        elif b is None:
            differences.append(
                {"address": address, "type": a["type"], "name": a["name"], "status": "removed_in_newer_plan", "older_action": a["action"]}
            )
        elif a["action"] != b["action"]:
            differences.append(
                {
                    "address": address,
                    "type": a["type"],
                    "name": a["name"],
                    "status": "action_changed",
                    "older_action": a["action"],
                    "newer_action": b["action"],
                }
            )
        else:
            # Same action on both sides -- compare the actual resulting
            # value each plan produces for every attribute (the "after" for
            # create/update/replace, or "before" for delete, since that's
            # what's actually being acted on), not just which field names
            # each plan happens to list as "changed" relative to current
            # state. This is what actually answers "is this plan going to
            # do something different from that other plan" -- e.g. both
            # plans still creating this resource, but with a different sku.
            values_a = a["before"] if a["action"] == "delete" else a["after"]
            values_b = b["before"] if b["action"] == "delete" else b["after"]
            unknown_a, unknown_b = set(a["unknown_after_apply"]), set(b["unknown_after_apply"])

            diff_keys = _differing_keys(values_a, values_b)
            if diff_keys:
                field_diffs = []
                for key in sorted(diff_keys):
                    older_value = "(known after apply)" if key in unknown_a else values_a.get(key)
                    newer_value = "(known after apply)" if key in unknown_b else values_b.get(key)
                    field_diffs.append({"field": key, "older_value": older_value, "newer_value": newer_value})
                differences.append(
                    {
                        "address": address,
                        "type": a["type"],
                        "name": a["name"],
                        "status": "changed_fields_differ",
                        "action": a["action"],
                        "field_diffs": field_diffs,
                    }
                )
            # identical action + identical resulting values -- not a difference, omitted

    return {
        "older_run_id": older.id,
        "older_run_name": older.name,
        "older_created_at": older.created_at,
        "newer_run_id": newer.id,
        "newer_run_name": newer.name,
        "newer_created_at": newer.created_at,
        "differences": differences,
        "total_differences": len(differences),
    }


def _latest_plan_run_id(project_id: str) -> str | None:
    plan_runs = [r for r in _runs.values() if r.kind == "plan" and r.target.get("project_id") == project_id]
    if not plan_runs:
        return None
    return max(plan_runs, key=lambda r: r.created_at).id


def request_apply_confirmation(plan_run_id: str) -> dict:
    run = _runs.get(plan_run_id)
    if run is None:
        raise ValueError("unknown plan_run_id")
    if run.kind != "plan":
        raise ValueError("run is not a plan")
    if run.status != "success":
        raise ValueError(f"plan run is not successful (status={run.status})")
    if not run.plan_file or not os.path.exists(run.plan_file):
        raise ValueError("saved plan file is missing or expired -- run plan again")
    if time.time() - run.created_at > PLAN_FILE_TTL_SECONDS:
        raise ValueError("plan is stale (>30 min old) -- re-run plan before applying")
    if plan_run_id != _latest_plan_run_id(run.target["project_id"]):
        raise ValueError(
            "a newer plan exists for this project -- only the most recent plan can be applied "
            "(older ones may no longer reflect the real state); open the latest plan, or re-run plan"
        )
    _check_plan_not_stale(run)

    token = secrets.token_hex(3).upper()
    expires_at = time.time() + CONFIRMATION_TTL_SECONDS
    with _runs_lock:
        _pending_confirmations[token] = {"plan_run_id": plan_run_id, "expires_at": expires_at}

    warning = (
        f"This will DESTROY the resources listed above in {run.target['project_name']} "
        f"({run.target['deployment']}/{run.target['environment']}). This is irreversible. "
        "Confirm the summary above with the user before calling confirm_apply."
        if run.is_destroy
        else
        f"This will make real changes against {run.target['project_name']} "
        f"({run.target['deployment']}/{run.target['environment']}). Confirm "
        "the summary above with the user before calling confirm_apply."
    )

    return {
        "token": token,
        "summary": run.summary,
        "target": run.target,
        "is_destroy": run.is_destroy,
        "expires_in_seconds": CONFIRMATION_TTL_SECONDS,
        "warning": warning,
    }


def confirm_apply(token: str) -> Run:
    with _runs_lock:
        entry = _pending_confirmations.pop(token, None)
    if entry is None:
        raise ValueError("invalid or already-used confirmation token")
    if time.time() > entry["expires_at"]:
        raise ValueError("confirmation token expired -- request a new one")

    plan_run_id = entry["plan_run_id"]
    plan_run = _runs.get(plan_run_id)
    if plan_run is None or not plan_run.plan_file or not os.path.exists(plan_run.plan_file):
        raise ValueError("plan file for this confirmation is missing -- re-run plan and request again")
    _check_plan_not_stale(plan_run)  # re-check even though request_apply already did -- time passed in between

    project_id = plan_run.target["project_id"]
    run_id = str(uuid.uuid4())
    _acquire_active(project_id, run_id)

    run = Run(run_id, "apply", plan_run.target, is_destroy=plan_run.is_destroy)
    run.related_plan_run_id = plan_run_id
    _register_run(run)

    plan_file = plan_run.plan_file

    def _do():
        _run_terraform(run, plan_run.target["dir"], ["apply", "-no-color", plan_file])

    threading.Thread(target=_do, daemon=True).start()
    return run


def get_run(run_id: str) -> Run | None:
    return _runs.get(run_id)


def list_runs_summary(project_id: str | None = None, limit: int = 50, include_checks: bool = False) -> list[dict]:
    """By default only shows init/plan/apply -- the meaningful audit trail.
    Pass include_checks=True to also see fmt/validate runs (they're never
    persisted, so this only surfaces ones still in memory this session)."""
    runs = sorted(_runs.values(), key=lambda r: r.created_at, reverse=True)
    if project_id:
        runs = [r for r in runs if r.target.get("project_id") == project_id]
    if not include_checks:
        runs = [r for r in runs if r.kind in PERSISTED_KINDS]
    return [r.to_dict() for r in runs[:limit]]


def clear_runs(project_id: str):
    """Delete run history (init/plan/apply) for one project. Refuses if a
    run for this project is currently in flight. Also cleans up this
    project's saved plan.tfplan/diff.json files so nothing points at a run
    that no longer exists."""
    if project_id in _active_run_by_project:
        raise ValueError("a run is currently in progress for this project -- wait for it to finish first")

    with _runs_lock:
        to_remove = [rid for rid, r in _runs.items() if r.target.get("project_id") == project_id]
        for rid in to_remove:
            del _runs[rid]

    run_store.delete_runs_for_project(project_id)

    project_dir = os.path.join(PROJECT_DATA_DIR, project_id)
    if os.path.isdir(project_dir):
        shutil.rmtree(project_dir, ignore_errors=True)


def wait_for(run_id: str, timeout: float = 300) -> bool:
    """Block (from a worker thread) until the run finishes or timeout. Returns True if finished."""
    deadline = time.time() + timeout
    run = _runs.get(run_id)
    if run is None:
        return False
    while time.time() < deadline:
        if run.status in ("success", "failed"):
            return True
        time.sleep(0.5)
    return False
