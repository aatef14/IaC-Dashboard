# IaC-Dashboard Sync Agent

A tiny local program with **no configuration UI of its own** -- every
control (which repo, which local folder, when to sync) happens on the main
dashboard website, in your browser. This just exposes a local API on
`127.0.0.1` that the website's JS calls directly, because a website's
JavaScript is sandboxed from your actual disk and can't otherwise run `git`
against a folder on your machine.

Runs fully in the background -- no console window, no terminal to keep
open. A small system tray icon (with just a **Quit** option) is the only
visible trace, since a genuinely background process still needs *some* way
to stop it besides Task Manager.

Needed when: you're using someone else's shared dashboard (their LAN IP,
their server) for a **Cloud** organization, and you want a real, syncing
local copy of that org's repo on *your own* computer -- not their computer.
If you're running your own full dashboard instance instead, you don't need
this at all; the dashboard already does its own git syncing server-side.

## Using it

1. Download `IaCSyncAgent.exe` -- from the dashboard's "Local Sync Agent"
   panel (a **Download Sync Agent** button appears there if it's not
   detected running yet), or build it yourself (see below).
2. Run it. First time only, a dialog confirms it's running and tells you
   where to find its pairing token -- it's also **already copied to your
   clipboard**, and saved in `%APPDATA%\IaCDashboardSyncAgent\token.txt` if
   you need it again later.
3. It registers itself to start automatically at every Windows login, so
   after this first run you shouldn't need to launch it by hand again.
4. On the dashboard website, open the Cloud org you want to sync -- there's
   a "Local sync" pill. Click it, paste the token, then **Start Syncing** --
   no need to pick a folder, the agent creates its own at
   `~\IaC-Dashboard\Cloud-Sync\<repo-name>` and clones the org's repo there.
   ("Use a different folder instead..." lets you override that if you want.)
5. From then on, it **auto-syncs every ~5 minutes** in the background on
   its own -- pulls the latest and pushes anything changed locally, quietly
   (no popup unless you use the manual button). Click **Sync to my
   computer** any time you don't want to wait for the next tick.

Requires `git` on PATH on your machine (same as the main dashboard). To
stop it, right-click its tray icon and choose **Quit** -- both auto-sync
and "Sync to my computer" stop working until you run it again.

## Building the .exe yourself

```powershell
cd sync_agent
pip install -r requirements-build.txt
python -m PyInstaller --onefile --noconsole --name IaCSyncAgent sync_agent.py
```

The result is `dist/IaCSyncAgent.exe` -- a single ~11MB file, Python
bundled in, nothing else to install. `build/`, `dist/`, and the generated
`.spec` file are git-ignored (regenerate them any time from `sync_agent.py`).
`pystray`/`Pillow` are only for the tray icon -- if they're missing at
build time the agent still works, it just has no visible tray icon and no
way to stop it besides Task Manager.

## Security model

- Binds to `127.0.0.1` only -- never reachable from the network, same as
  it being on your own machine already implies.
- Every mutating request (`/configure`, `/sync`, `/browse-folder`) requires
  `Authorization: Bearer <token>` matching the one generated on first run,
  persisted in `%APPDATA%\IaCDashboardSyncAgent\config.json`. Without this,
  any other website your browser happens to have open could otherwise probe
  `127.0.0.1:9876` and trigger a sync -- the token is what stops that. That
  first-ever token generation is race-free (atomic file create) even if two
  copies happen to start around the same moment -- e.g. auto-start-at-login
  racing a manual double-click -- so they can never end up disagreeing about
  what the token actually is.
- `GET /status` has no token requirement (it reveals no secrets -- just
  whether it's configured and for which repo), so the dashboard can show
  "agent detected" without needing the token first.

## A note on running two copies at once

Python's `http.server` sets `allow_reuse_address = True` by default, and
on Windows specifically `SO_REUSEADDR` lets a completely separate process
bind the same port an already-running instance is using, with no error --
unlike POSIX, where it mainly just permits rebinding a socket still in
TIME_WAIT. Without disabling that, two copies (e.g. auto-start-at-login
racing a manual double-click) could both end up genuinely running at once,
each with its own token, with incoming requests randomly routed to
whichever one the OS happened to pick -- which looks exactly like "the
token is wrong," for whichever one loses a given request. This is
disabled here specifically so a second copy's bind attempt actually fails
instead of silently creating a second, conflicting server.

## A note on tkinter and threads

Every dialog (folder picker, clipboard copy, the startup message) is
marshaled onto one dedicated background thread that owns a single
persistent, hidden `Tk()` root for the agent's whole lifetime, via a
thread-safe `queue.Queue` the Tk thread polls itself. Tkinter isn't
thread-safe, and creating a fresh `Tk()` from whichever HTTP thread happens
to handle a request works fine in isolation but breaks (`"main thread is
not in main loop"`) the moment the tray icon's own native message loop is
also occupying the real main thread -- this is the fix for that, not
incidental complexity.
