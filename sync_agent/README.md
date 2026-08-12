# IaC-Dashboard Sync Agent

A tiny local program with **no UI of its own** -- every control (which repo,
which local folder, when to sync) happens on the main dashboard website, in
your browser. This just exposes a local API on `127.0.0.1` that the
website's JS calls directly, because a website's JavaScript is sandboxed
from your actual disk and can't otherwise run `git` against a folder on
your machine.

Needed when: you're using someone else's shared dashboard (their LAN IP,
their server) for a **Cloud** organization, and you want a real, syncing
local copy of that org's repo on *your own* computer -- not their computer.
If you're running your own full dashboard instance instead, you don't need
this at all; the dashboard already does its own git syncing server-side.

## Using it

1. Run `IaCSyncAgent.exe` (ask whoever gave you this for the file, or build
   it yourself -- see below). A console window opens and prints a token:

   ```
   Token (paste this into the dashboard's 'Sync to my computer' box):

       <a long random string>
   ```

2. Leave that window open. It's now listening on `http://127.0.0.1:9876`.
3. On the dashboard website, open the Cloud org you want to sync -- there's
   a "Local Sync Agent" panel. Paste the token, Browse to (or type) a local
   folder, click **Start Syncing**. It clones the org's repo there.
4. From then on, click **Sync to my computer** any time to pull the latest
   and push whatever local changes exist.

Requires `git` on PATH on your machine (same as the main dashboard).
Closing the window (or Ctrl+C) stops it -- "Sync to my computer" just won't
do anything until you run it again.

## Building the .exe yourself

```powershell
pip install pyinstaller
cd sync_agent
python -m PyInstaller --onefile --console --name IaCSyncAgent sync_agent.py
```

The result is `dist/IaCSyncAgent.exe` -- a single ~10MB file, Python
bundled in, nothing else to install. `build/`, `dist/`, and the generated
`.spec` file are git-ignored (regenerate them any time from `sync_agent.py`).

## Security model

- Binds to `127.0.0.1` only -- never reachable from the network, same as
  it being on your own machine already implies.
- Every mutating request (`/configure`, `/sync`, `/browse-folder`) requires
  `Authorization: Bearer <token>` matching the one printed on startup,
  persisted in `%APPDATA%\IaCDashboardSyncAgent\config.json`. Without this,
  any other website your browser happens to have open could otherwise probe
  `127.0.0.1:9876` and trigger a sync -- the token is what stops that.
- `GET /status` has no token requirement (it reveals no secrets -- just
  whether it's configured and for which repo), so the dashboard can show
  "agent detected" without needing the token first.
