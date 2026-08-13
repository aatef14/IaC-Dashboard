# IaC-Dashboard

One local process, two ways in, one shared state:

- **Web dashboard** — open http://127.0.0.1:8765/. A landing page lists your
  **Organizations** (`/<org-name>`); open one to see its **Work Projects**
  (`/<org-name>/<project-name>`). **Add Work Project** names one and points
  it at a folder + deployment + environment. Open a project to Format,
  Validate, Run Plan (or Plan Destroy), and Request Apply -> confirm code ->
  Confirm & Apply.
- **MCP server** — the same actions exposed as MCP tools at
  `http://127.0.0.1:8765/mcp`, so Claude Code can drive it and report back
  to you in chat.

A project added, or a run started, from one side shows up in the other (same
saved organizations/projects, same run history, same in-progress lock).

Every project belongs to an Organization -- create one first (there's nowhere
else to put a project). Nothing about the target folder is hardcoded. A
"project folder" is any folder that contains a `modules/` directory and one
or more `tf-deployment*` directories -- either point at one
that already exists ("Select existing folder"), or have the dashboard
generate a minimal starter one into an empty folder ("Initialize new folder",
scaffolds `modules/` + `tf-deployment/main.tf` + placeholder
backend/tfvars for the azurerm provider).
Environments are auto-discovered per deployment as the intersection of
`environmentVariables/terraform.<env>.tfvars` and
`backend/azurerm.<env>.tfbackend` files -- an environment only shows up if
both exist for the same `<env>` name. The `azurerm.` prefix is required, not
just conventional: the run builds that exact path, so accepting other
prefixes would offer environments that then fail at init.

Before `init`/`plan` actually run, the dashboard checks you're authenticated
to the right Azure account for that project: that `az account show` succeeds
and, if the tfvars references a `subscription_id`, that it's one your login
can actually see (`az account list`). It fails with a clear message ("please
authenticate...") instead of a confusing terraform-level error if not.

Opening a project also runs that same check up front and shows the result as
a pill in the title bar -- **Real Azure Change Activated** when you're
authenticated, **Not Authenticated** (hover for the reason) when you're not --
so a bad or missing login is visible immediately rather than only when a run
fails. The `check_auth` MCP tool exposes the same probe without starting a run.

## Getting started (new machine)

Requirements:
- **Windows**, with **PowerShell** -- the native folder picker, the
  Restart Server button, and `.\start.ps1`/`.\stop.ps1` themselves all shell
  out to PowerShell/`taskkill`. Not on Windows (or want it running somewhere
  other than your own desktop)? See **Running with Docker** below instead --
  those two features just fail with a clear message there rather than
  working, everything else is identical.
- **Python 3.10+** on PATH -- the one thing `install.ps1` below can't
  install for you (it needs Python to already exist to install everything
  else). Get it from [python.org](https://python.org) (check "Add
  python.exe to PATH" during install) if you don't have it.

Setup -- clone it, run one script, done:

```powershell
git clone https://github.com/aatef14/IaC-Dashboard.git
cd IaC-Dashboard
.\install.ps1
```

That's it. `install.ps1` checks for every external tool this dashboard shells
out to -- **Terraform**, **Azure CLI**, **Git** (Git Bash, used by the
in-app terminal), **Graphviz** (used by the dependency graph view) -- and
installs whichever are missing via `winget` (Windows' built-in package
manager, no manual downloads), then runs `pip install -r requirements.txt`
for the Python side. Safe to re-run any time; every check is a no-op if the
tool's already there, and it never touches your saved projects/orgs/run
history. Prints a summary at the end so you can see at a glance what's
covered and what (if anything) needs installing by hand -- **VS Code's
`code` CLI** is the one thing it only checks, never installs, since it's
entirely optional (only needed for the **Open in VS Code** button; the
in-app editor works without it) -- VS Code's own Command Palette -> "Shell
Command: Install 'code' command in PATH" adds it if you want it.

Once every required tool is present, `install.ps1` automatically runs
`start.ps1` for you -- **the dashboard opens in your default browser** at
the end of setup, no separate step needed. If any required tool is still
missing (e.g. `winget` itself isn't available, or Python wasn't
pre-installed), it tells you exactly what to install and stops there --
re-run `.\install.ps1` (or just `.\start.ps1` once tools are on PATH) after
fixing it.

You'll also want to run `az login` at some point to sign in to the Azure
account this dashboard should manage infrastructure for -- you can do this
before or after `install.ps1`; it's only needed once you actually plan/apply
against real infrastructure (browsing and planning UI works without it, and
a **Not Authenticated** pill just reminds you it's still needed).

First run creates `organizations.json`, `projects.json`, `runs.db`, and
`project-data/` next to the code -- all git-ignored, all yours, nothing
shared with anyone else who clones this repo.

There's nothing to configure before first use: no config file, no
environment variables, no storage account to pre-register. Everything --
which folder, which deployment, which environment, which Azure subscription
-- is supplied per-project the first time you click **Add Work Project**,
either by pointing at Terraform code you already have or by having the
dashboard scaffold a minimal starting point into an empty folder (see
below). The one thing you bring yourself is a Terraform project shaped like
the layout in "Expected folder structure" -- this dashboard drives
`terraform`, it doesn't replace writing your own `.tf` files.

Binds to all network interfaces (`0.0.0.0`) by default, so it stays reachable
at your machine's current LAN IP no matter which Wi-Fi/network you're on --
`start.ps1` auto-detects and prints that IP every time it starts. **By
default it has no authentication of its own** and can run real `terraform
apply` calls against real cloud infrastructure, write to real files, and
open a real shell -- so treat that LAN reachability as "anyone on this
network can drive this dashboard," not just a convenience, unless you've set
up GitHub sign-in (see **GitHub sign-in** below). If you want it restricted
back to just this machine instead, set `$env:IAC_DASHBOARD_HOST =
"127.0.0.1"` before running `.\start.ps1`. If several people need their own
dashboard, each should run their own instance against their own Azure login
rather than sharing one.

## Starting / stopping

Runs detached in the background so it survives closing the terminal, and
opens your default browser to it automatically.

```powershell
.\start.ps1   # starts it, prints the PID + local/LAN URLs, opens your browser
.\stop.ps1    # stops it
```

Logs land in `server.log` / `server.log.err` in this folder. To run it in the
foreground instead (e.g. while debugging): `python server.py`.

## GitHub sign-in (optional)

Off by default -- the dashboard runs exactly as it always has (open, no
login) until you configure this. Worth turning on once you're sharing your
LAN IP with anyone else, since that otherwise means anyone on the network
can drive real Terraform runs with zero login at all.

Uses GitHub's **Device Flow** rather than the usual browser-redirect OAuth
login -- deliberately, since a redirect-based flow needs a fixed callback
URL and this dashboard's LAN IP changes across networks (see **Starting /
stopping** above). Device Flow has no callback URL at all: you open
`github.com/login/device`, type in a short code, and the dashboard (which
is polling in the background) picks up the sign-in the moment you approve
it -- works identically no matter which network you're on. It also doesn't
need a client secret (same model the `gh` CLI uses), so setup is one field:

1. Create a GitHub OAuth App: **github.com -> Settings -> Developer settings
   -> OAuth Apps -> New OAuth App**.
   - Homepage URL / Authorization callback URL: neither is actually used by
     Device Flow, so any value satisfies GitHub's "this field is required"
     validation -- e.g. this repo's URL for both.
   - Tick **Enable Device Flow** in the app's settings.
   - Note the **Client ID** (that's the only credential needed -- no secret).
2. Copy `secrets.example.ps1` to `secrets.local.ps1` (git-ignored -- stays
   local to this machine) and fill in `GITHUB_OAUTH_CLIENT_ID`. `start.ps1`
   picks it up automatically on every future start, no need to set env vars
   by hand each time.
3. `.\stop.ps1` then `.\start.ps1` (or just re-run `install.ps1`).

Once configured, visiting the dashboard shows a code + a link to
`github.com/login/device` instead of the normal UI until you approve it --
then it redirects straight into the dashboard. Any GitHub account can sign
in -- there's no allowlist, so anyone who reaches the dashboard's URL and
has a GitHub account gets in after approving. Signed-in users appear in the
header menu (top-right &#9776;), which also has **Sign out**.

The MCP endpoint (`/mcp`, used by Claude Code) is separate from this --
GitHub's OAuth flow doesn't fit a non-browser MCP client. If you want it
protected too, set `MCP_SHARED_SECRET` in the same `secrets.local.ps1` to
any random string, then add a matching header to the `.mcp.json` in
whichever repo connects to it:

```json
{
  "mcpServers": {
    "IaC-Dashboard": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <the same random string>" }
    }
  }
}
```

Leaving `MCP_SHARED_SECRET` unset keeps `/mcp` open, independent of whether
GitHub sign-in is configured for the web dashboard.

## Running with Docker

An alternative to the native Windows setup above -- useful for running this
somewhere other than your own desktop (e.g. a shared box a small team uses).
Two things that need a real Windows desktop to work at all fail with a clear
message instead of a confusing one when running in a container:

- **Browse...** (the native folder picker) -- type the project path directly
  (e.g. a path under a volume you've mounted, like `/workspace/my-repo`).
- **Restart Server** -- restart the container instead:
  `docker compose restart`.

```bash
git clone https://github.com/aatef14/IaC-Dashboard.git
cd IaC-Dashboard
# Point this at wherever your actual Terraform project(s) live on the host
mkdir -p terraform-projects
docker compose up -d --build
```

Then open http://127.0.0.1:8765/ -- same dashboard, same MCP endpoint. Two
volumes matter here (see `docker-compose.yml`):

- `dashboard-data` (a named volume, `/data` in the container) -- holds
  `organizations.json`/`projects.json`/`runs.db`/`project-data/`, so a
  rebuild doesn't wipe your saved projects and run history.
- `./terraform-projects` (a bind mount, `/workspace` in the container) --
  put (or symlink) your real Terraform repo(s) here, then point **Add Work
  Project** at the matching path under `/workspace`.

`docker-compose.yml` publishes the port as `127.0.0.1:8765:8765`, not a bare
`8765:8765` -- same "never reachable off this machine" guarantee as the
native app's `127.0.0.1` bind, just re-established at the Docker layer
instead (binding to `127.0.0.1` *inside* a container would make it
unreachable from the host entirely, so the image binds `0.0.0.0` internally
and the port mapping is what actually restricts it to localhost).

## Using it

1. **New Organization** on the landing page -- give it a name (no spaces --
   it's the stable key `/<org-name>/<project-name>` URLs are built on). Open it.
2. **Add Work Project** -- give it a name (also no spaces, also permanent --
   see below), then either **Select existing folder** (Browse to it, Scan
   Folder) or **Initialize new folder** (Browse to an empty folder,
   Initialize Folder -- generates starter files you still need to fill in
   with real values). Pick deployment + environment, Create Project. This
   saves it and runs `terraform init` automatically.
3. Open the project card. **Open in VS Code** launches VS Code (the `code`
   CLI) on this same machine, pointed at the project's ROOT folder (not just
   the deployment subfolder -- that would hide the sibling `modules/`
   directory its `.tf` files actually reference by relative path) -- needs
   `code` on PATH (VS Code's Command Palette ->
   "Shell Command: Install 'code' command in PATH" if it isn't yet).
   **Format** and **Validate** are local, no-cloud-calls actions. Format
   runs `terraform fmt -recursive`, rewriting any badly-formatted
   `.tf`/`.tfvars` files in place (whitespace and alignment only, never
   meaning) and reporting which ones it touched. Because it's recursive,
   `environmentVariables/*.tfvars` is covered -- but `backend/*.tfbackend`
   is not, since Terraform doesn't recognize that extension. **View Config
   (tfvars)** shows that environment's tfvars file parsed into a readable,
   collapsible tree instead of raw HCL -- it live-refreshes while open, so
   edits made outside the dashboard (in an editor, or by Format) show up
   without needing to reopen it.
4. **Run Plan** (name it) and watch it stream, or **Plan Destroy** to plan
   tearing the whole deployment down instead (still just a plan -- see
   Apply safety below). A successful plan shows a structured
   create/update/delete/replace table instead of raw log text -- click any
   row to see that resource's actual attribute values (sensitive ones
   redacted), toggle back to the raw log any time, or download the table as
   JSON/CSV for a change record. **Compare with...** diffs this plan against
   any other successful plan for the same project -- only resources that
   actually differ (added, removed, action changed, or same action but
   different fields/values) show up, so you can see "what changed since
   last time" without cross-referencing two plans by eye.
5. **Request Apply** -- returns a 6-character code + the add/change/destroy
   summary. Nothing is applied yet. Blocked outright if the tfvars/backend
   file changed on disk since this plan was generated (re-plan first), or if
   a newer plan already exists for this project (only the latest plan for a
   project can ever be applied -- older ones stop offering Request Apply).
6. Type the code into the confirm box and **Confirm & Apply**.
7. Hover a project card's **⋮** to edit its folder/deployment/environment,
   clear its run history, or delete it (delete never touches real cloud
   resources -- it only forgets the local bookkeeping entry). Same menu on
   an Organization card deletes it and cascades to every project inside it.

Project **name is permanent** once created (unique within its organization)
-- it's the stable key `/<org-name>/<project-name>` URLs and MCP lookups
are built on, so renaming isn't offered (delete and re-add if you genuinely
need a different name).

## Cloud organizations

By default (**Local**), an Organization's projects live only on this
machine -- if you share your LAN IP, everyone's looking at your one shared
instance. **Cloud** mode is the alternative: each person runs their own
separate dashboard instance, but a Cloud org's projects -- the actual
Terraform files AND which projects exist -- live in a Git repo you provide,
so everyone stays in sync through that repo instead of one shared server.

- When creating an Organization, pick **Cloud** and give it a Git repo URL.
  The dashboard clones it into `cloud-orgs/<org-id>/repo` (git-ignored,
  machine-local) and reads a manifest already there (if any) to populate
  this org's project list.
- **Add Work Project** for a Cloud org works exactly like a Local one, just
  rooted inside that clone -- Browse opens there by default. Creating,
  editing, or deleting a project commits and pushes the change (the actual
  project files, plus a small manifest at `.iac-dashboard/projects.json`
  listing every project) automatically.
- **To join an existing Cloud org from another machine**: create an
  Organization with the **same name** and the **same repo URL**. There's no
  shared id across machines -- that name+URL match is the only thing
  linking them. Opening the org pulls the latest and picks up any projects
  someone else added; this also happens automatically every time you open
  it, not just once at creation.
- Uses whatever git credentials already work on this machine (SSH key,
  Windows Credential Manager, a cached HTTPS token) -- the dashboard never
  handles credentials itself. A private repo you don't have access to
  fails with git's own auth error; if it's someone else's repo, they need
  to add you as a collaborator on GitHub first.
- **Use a private repo.** Real project data -- tfvars values, resource
  names, file paths -- gets committed into whatever repo you provide. The
  dashboard does a best-effort check against a public github.com repo and
  warns you at creation time, but that check is heuristic (only understands
  github.com URLs, skips silently on a network hiccup) -- don't rely on it
  as the only safeguard.
- Sync is add-only: if someone deletes a project, it disappears from *their*
  view, but other machines that already synced it keep their local copy
  (deleting it yourself removes it everywhere, same as adding one).
- Run history, Azure auth, and the `initialized` (`.terraform/` present)
  state stay local per machine either way -- never shared, same as a Local
  org.
- Saving a file edit in the in-app editor for a Cloud org's project pulls,
  writes, commits, and pushes automatically -- not just project creation/
  deletion. A push failure surfaces as "saved locally but couldn't push"
  instead of failing silently.

### Running your own instance (Desktop app)

The paragraph above says "each person runs their own separate dashboard
instance" -- **IaCDashboard.exe** is what makes that a double-click instead
of installing Python and running `python server.py` from a clone of this
repo:

- Build it with `.\build_desktop_app.ps1` (or ask whoever maintains this repo
  for the built `.exe`) and hand the single file to anyone who wants their
  own instance. No Python install needed on their machine.
- Running it starts the dashboard bound to `127.0.0.1` only (never
  LAN-shared -- this is meant to be genuinely theirs, not another shared
  server), opens it in their default browser automatically, and leaves a
  small tray icon running in the background (right-click it to Quit).
- Their data -- organizations, projects, run history -- lives entirely in
  `%LOCALAPPDATA%\IaCDashboard` on their own machine, completely separate
  from anyone else's. To join a Cloud org someone else already created,
  create an Organization with the same name + repo URL, same as described
  above -- New Organization now also probes the repo URL as you type it and
  pre-fills the name for you if it can find one (see `org.json`/manifest in
  the repo).
- **Installs Git, Terraform, and the Azure CLI itself** on first run if
  they're missing (via `winget`, same packages `install.ps1` uses) -- a
  small progress window shows while that happens, then the dashboard opens
  as normal. If `winget` genuinely isn't available, it warns instead and
  starts anyway (Init/Plan/Apply just won't work until those are installed
  by hand). Their own `az login` is still on them -- every Init/Plan/Apply
  then runs under *their* Azure identity, not whoever they might otherwise
  be sharing a dashboard with.
- **GitHub auth for a private repo needs no setup either** -- Git for
  Windows bundles Git Credential Manager, which pops open a browser to
  sign into GitHub the first time git actually needs to clone/push a
  private repo it has no cached credential for, then remembers it. Give
  them an **HTTPS** repo URL (`https://github.com/...`), not an SSH one, so
  this kicks in automatically.
- **Every Cloud org auto-syncs in the background every ~5 minutes**, not
  just when its page happens to be open -- the one piece of the standalone
  Sync Agent (below) worth keeping even though this IS someone's own
  machine now: without it, an org would only ever refresh when you
  actually visit it.

### Syncing to your own computer when you're using someone else's dashboard

If you're just a browser client on someone else's shared instance (their
LAN IP) rather than running your own, there's no local folder on *your*
machine at all by default -- everything lives on their server, since a
website's JS can't reach your disk. **sync_agent/** is a small companion
program that closes that gap: run it, paste its token into the dashboard's
"Local Sync Agent" panel (shown for a Cloud org), pick a folder, and from
then on "Sync to my computer" pulls/pushes a real local copy on your own
machine -- see [sync_agent/README.md](sync_agent/README.md).

## Apply safety

Apply is never one click on either side, whether it's a normal plan or a
destroy plan:

1. Plan (dashboard button, or the `terraform_plan`/`plan_destroy` MCP tools).
2. Request apply against that plan's run id (`request_apply` / "Request
   Apply" button) -- only returns the confirmation code + summary, applies
   nothing. The code expires in 10 minutes and can only be used once.
3. Confirm with that exact code (`confirm_apply` / typing the code into the
   dashboard) to actually run `terraform apply` against the saved plan file.

Only one init/fmt/validate/plan/apply can run at a time per project -- a
second request while one's in flight is rejected outright (avoids the
Terraform state-lock error you get from firing concurrent runs).

`ARM_ACCESS_KEY` is fetched fresh from `az storage account keys list` for each
run that needs it -- using the `storage_account_name` and `resource_group_name`
read out of that project's own `.tfbackend` file, so nothing is tied to one
storage account (init/plan/apply -- fmt and validate don't touch Azure at
all) and only ever lives in that subprocess's environment -- never written
to disk.

## Wiring this up as an MCP server for Claude Code

Add a `.mcp.json` at the root of the repo you want to drive from Claude Code
(i.e. your Terraform project, not this one):

```json
{
  "mcpServers": {
    "IaC-Dashboard": {
      "type": "http",
      "url": "http://127.0.0.1:8765/mcp"
    }
  }
}
```

The dashboard has to actually be running (`start.ps1`) for Claude Code to
connect to it. Restart your Claude Code session (or run `/mcp` to reconnect)
after starting the dashboard for the first time -- project MCP servers load
at session start, and you'll get a one-time approval prompt for a new server.

Tools exposed: `list_organizations`, `add_organization`, `delete_organization`,
`list_projects`, `discover_project`, `initialize_project_folder`,
`add_project`, `update_project`, `delete_project`, `clear_project_runs`,
`check_auth`, `get_tfvars`, `init_project`, `fmt`, `validate`, `terraform_plan`,
`plan_destroy`, `get_plan_diff`, `compare_plans`, `request_apply`, `confirm_apply`,
`cancel_run`, `get_run_status`, `list_runs`. Claude is instructed to check
`list_organizations` first (creating one via `add_organization` if none
exist), then `list_projects(org_id)`, add one via `discover_project` or
`initialize_project_folder` + `add_project` if needed (asking which
deployment/environment/cloud provider if there's more than one option),
`init_project` before planning, and to always show you the plan summary and
get an explicit yes before calling `confirm_apply`. Two dashboard buttons are
deliberately NOT MCP tools -- **Restart Server** and **Open in VS Code** --
both act on the host machine's desktop/process in a way that should only
ever be a human clicking a button, never an agent deciding to do it.

## Other dashboard features

- **Run retention** -- each project can optionally set a "keep runs for N
  days" limit (Add/Edit Work Project). Finished init/plan/apply runs older
  than that are deleted automatically (checked after every run and at
  startup); unset (the default) keeps run history forever, unchanged from
  before this existed.
- **Restart Server** (top-right corner) -- restarts the whole dashboard
  process via `stop.ps1`/`start.ps1`, warning first if it would interrupt a
  run in progress. Windows-only; in Docker, restart the container instead.
- Terraform's own `Error:`/`Warning:` diagnostic output renders as
  color-coded cards (location, offending line, message) instead of a raw
  text dump, and a live per-resource progress checklist (✓/spinner, action,
  elapsed/duration) appears during a running plan/apply instead of a wall
  of interleaved "Still creating... [10s elapsed]" lines -- toggle back to
  the raw log any time.

## Files

| File | Purpose |
|---|---|
| `server.py` | FastAPI/Starlette app -- MCP tools + dashboard REST/SSE routes, single process |
| `auth.py` | Optional GitHub OAuth sign-in for the web dashboard (HMAC-signed session cookies) + the separate MCP shared-secret check -- both no-ops until configured, see **GitHub sign-in** |
| `secrets.example.ps1` | Template for `secrets.local.ps1` (git-ignored) -- GitHub OAuth Client ID/Secret and the MCP shared secret, auto-loaded by `start.ps1` |
| `run_manager.py` | Core logic: organization/project CRUD, folder scaffolding, cloud-auth pre-flight check, init/fmt/validate/plan/apply execution, confirmation tokens, the one-run-at-a-time-per-project lock |
| `run_store.py` | SQLite persistence for run history (`runs.db`) -- write-through on every run, reloaded at startup |
| `organizations.json` | Saved Organizations (name) -- every project belongs to one |
| `projects.json` | Saved Work Projects (org_id, name, folder, deployment, environment, cloud_provider) |
| `project-data/<project_id>/runs/<run_id>/` | Everything one plan run produced (`plan.tfplan`, `diff.json`) -- lives here, NOT inside the actual Terraform repo, so the dashboard never writes anything into your IaC project folder |
| `cloud-orgs/<org_id>/repo/` | A Cloud org's cloned repo -- this machine's working copy only, see **Cloud organizations** above. `.iac-dashboard/projects.json` inside it (committed to the repo itself, not listed here since it's not local-only) is the manifest of that org's projects |
| `sync_agent/` | Standalone companion program (see its own README) -- lets someone using your shared dashboard as a browser client sync a Cloud org's repo to their OWN computer, since a website's JS can't otherwise touch a visitor's disk |
| `desktop_app.py` / `build_desktop_app.ps1` | Packages this same dashboard into a standalone `IaCDashboard.exe` for one person's own full, independent instance -- see **Running your own instance (Desktop app)** above |
| `static/` | Dashboard HTML/CSS/JS |
| `install.ps1` | One-shot setup: checks/installs Terraform, Azure CLI, Git, Graphviz via `winget`, `pip install`s the Python side, then runs `start.ps1` |
| `start.ps1` / `stop.ps1` | Background process management (PID tracked in `.server.pid`) |
| `Dockerfile` / `docker-compose.yml` / `.dockerignore` | Container image (Python + Terraform + Azure CLI) -- see **Running with Docker** above |

## Known limitations

- Single-user, localhost-only, no auth -- by design, not something to expose
  beyond this machine.
- Run data is garbage-collected automatically (at startup and after each
  plan): a run directory whose run is no longer in history is deleted
  outright, and the large binary `plan.tfplan` is dropped once the run is
  past the 30-minute apply window, since an expired plan can't be applied
  anyway. The small `diff.json` is kept indefinitely, so the structured diff
  of any historic plan stays viewable forever. Clear Runs / Delete Project
  remove everything for that project immediately.
- **Azure only.** A `cloud_provider` field is stored on each project (so
  another provider can be added without migrating records), but only
  `azure` is accepted. An AWS option briefly existed and was pulled: every
  init/plan/apply fetches `ARM_ACCESS_KEY` unconditionally, so an AWS
  project would have passed its auth check and then died fetching an Azure
  storage key.
- A running init/plan/apply can be **cancelled** from the run header (or the
  `cancel_run` MCP tool). On Windows this kills the whole terraform process
  tree via `taskkill`; running in Docker/Linux it only kills the immediate
  `terraform` process, not the provider plugin children it spawned (a
  Linux process-group-kill equivalent isn't implemented yet). Safe for
  init/fmt/validate/plan either way. Cancelling an **apply** is risky and
  warns accordingly regardless of platform -- resources may already be
  half-created and the state file can be left locked (needing
  `terraform force-unlock`).
