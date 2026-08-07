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
or more `tf-deployment*` directories (this repo's `IAC/` is one example, with
`tf-deployments/` and `tf-deployment-rag/` inside it) -- either point at one
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
fails. The
`check_auth` MCP tool exposes the same probe without starting a run.

## Starting / stopping

Runs detached in the background so it survives closing the terminal.

```powershell
.\start.ps1   # starts it, prints the PID and URLs
.\stop.ps1    # stops it
```

Logs land in `server.log` / `server.log.err` in this folder. To run it in the
foreground instead (e.g. while debugging): `python server.py`.

## Using it

1. **New Organization** on the landing page -- give it a name. Open it.
2. **Add Work Project** -- give it a name (permanent -- see below), then
   either **Select existing folder** (Browse to it, Scan Folder) or **Initialize new folder** (Browse to an empty folder,
   Initialize Folder -- generates starter files you still need to fill in
   with real values). Pick deployment + environment, Create Project. This
   saves it and runs `terraform init` automatically.
3. Open the project card. **Format** and **Validate** are local,
   no-cloud-calls actions. Format runs `terraform fmt -recursive`, rewriting
   any badly-formatted `.tf`/`.tfvars` files in place (whitespace and
   alignment only, never meaning) and reporting which ones it touched.
   Because it's recursive, `environmentVariables/*.tfvars` is covered --
   but `backend/*.tfbackend` is not, since Terraform doesn't recognize that
   extension.
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

A project-scoped `.mcp.json` has already been added at the `IAC/` repo root:

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
`check_auth`, `init_project`, `fmt`, `validate`, `terraform_plan`, `plan_destroy`,
`get_plan_diff`, `compare_plans`, `request_apply`, `confirm_apply`,
`cancel_run`, `get_run_status`, `list_runs`. Claude is instructed to check
`list_organizations` first (creating one via `add_organization` if none
exist), then `list_projects(org_id)`, add one via `discover_project` or
`initialize_project_folder` + `add_project` if needed (asking which
deployment/environment/cloud provider if there's more than one option),
`init_project` before planning, and to always show you the plan summary and
get an explicit yes before calling `confirm_apply`.

## Files

| File | Purpose |
|---|---|
| `server.py` | FastAPI/Starlette app -- MCP tools + dashboard REST/SSE routes, single process |
| `run_manager.py` | Core logic: organization/project CRUD, folder scaffolding, cloud-auth pre-flight check, init/fmt/validate/plan/apply execution, confirmation tokens, the one-run-at-a-time-per-project lock |
| `run_store.py` | SQLite persistence for run history (`runs.db`) -- write-through on every run, reloaded at startup |
| `organizations.json` | Saved Organizations (name) -- every project belongs to one |
| `projects.json` | Saved Work Projects (org_id, name, folder, deployment, environment, cloud_provider) |
| `project-data/<project_id>/runs/<run_id>/` | Everything one plan run produced (`plan.tfplan`, `diff.json`) -- lives here, NOT inside the actual Terraform repo, so the dashboard never writes anything into your IaC project folder |
| `static/` | Dashboard HTML/CSS/JS |
| `start.ps1` / `stop.ps1` | Background process management (PID tracked in `.server.pid`) |

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
  `cancel_run` MCP tool), which kills the whole terraform process tree and
  frees the per-project lock. Safe for init/fmt/validate/plan. Cancelling an
  **apply** is risky and warns accordingly -- resources may already be
  half-created and the state file can be left locked (needing
  `terraform force-unlock`).
