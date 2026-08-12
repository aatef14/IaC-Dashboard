"""
IaC-Dashboard Sync Agent -- a small local companion program with NO UI of
its own. Every control (repo URL, local folder, when to sync) happens from
the dashboard website, in your browser; this just exposes a local HTTP API
on 127.0.0.1 that the website's JS calls directly. Runs until you close
this window.

Why this exists: a website's JavaScript is sandboxed from your actual file
system -- there's no way for a "Sync" button on any website to run `git
clone`/`git pull` against a folder on YOUR disk. The only thing that can
touch your disk is a real program running on your machine, which is what
this is. It's deliberately as thin as possible: no config UI, no tray
icon, just an API the dashboard drives.

Security model: binds to 127.0.0.1 only (never reachable from the network,
same as this being on your own machine already implies), and every
mutating request must include the token printed below in an
`Authorization: Bearer <token>` header -- generated once, persisted, and
never sent anywhere except typed into the dashboard by you. Without the
token, an unrelated malicious site your browser happens to have open could
otherwise probe 127.0.0.1 and trigger syncs.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 9876
CONFIG_DIR = os.path.join(os.environ.get("APPDATA", os.path.expanduser("~")), "IaCDashboardSyncAgent")
CONFIG_PATH = os.path.join(CONFIG_DIR, "config.json")


def _load_config() -> dict:
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def _save_config(config: dict):
    os.makedirs(CONFIG_DIR, exist_ok=True)
    with open(CONFIG_PATH, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


_config = _load_config()
if "token" not in _config:
    _config["token"] = secrets.token_urlsafe(24)
    _save_config(_config)

TOKEN = _config["token"]


def _resolve_git() -> str:
    git_exe = shutil.which("git")
    if not git_exe:
        raise RuntimeError("'git' not found on PATH -- install Git for Windows, then restart this agent")
    return git_exe


def _run_git(args, cwd, timeout=120) -> str:
    result = subprocess.run([_resolve_git(), *args], cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr.strip() or result.stdout.strip()}")
    return result.stdout


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(f"[agent] {self.address_string()} - {fmt % args}")

    def _send_json(self, status: int, body: dict):
        payload = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self) -> bool:
        return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    def _read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_OPTIONS(self):
        self.send_response(204)
        origin = self.headers.get("Origin")
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/status":
            cfg = _load_config()
            self._send_json(
                200,
                {
                    "configured": bool(cfg.get("repo_url") and cfg.get("local_dir")),
                    "repo_url": cfg.get("repo_url"),
                    "local_dir": cfg.get("local_dir"),
                    "last_synced_at": cfg.get("last_synced_at"),
                },
            )
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if not self._authorized():
            self._send_json(401, {"error": "missing or wrong token -- paste the token this agent printed on startup"})
            return

        try:
            if self.path == "/browse-folder":
                import tkinter
                from tkinter import filedialog

                root = tkinter.Tk()
                root.withdraw()
                root.attributes("-topmost", True)
                path = filedialog.askdirectory(title="Choose a folder for IaC-Dashboard to sync into")
                root.destroy()
                self._send_json(200, {"path": path or None})
                return

            if self.path == "/configure":
                body = self._read_json_body()
                repo_url = (body.get("repo_url") or "").strip()
                local_dir = (body.get("local_dir") or "").strip()
                if not repo_url or not local_dir:
                    self._send_json(400, {"error": "repo_url and local_dir are both required"})
                    return
                if not os.path.isdir(local_dir) or not os.listdir(local_dir):
                    os.makedirs(local_dir, exist_ok=True)
                    _run_git(["clone", repo_url, local_dir], cwd=CONFIG_DIR)
                cfg = _load_config()
                cfg["repo_url"], cfg["local_dir"] = repo_url, local_dir
                _save_config(cfg)
                self._send_json(200, {"ok": True, "repo_url": repo_url, "local_dir": local_dir})
                return

            if self.path == "/sync":
                cfg = _load_config()
                local_dir = cfg.get("local_dir")
                if not local_dir:
                    self._send_json(400, {"error": "not configured yet -- call /configure first"})
                    return
                warning = None
                try:
                    _run_git(["pull", "--ff-only"], cwd=local_dir)
                except RuntimeError as e:
                    warning = str(e)
                _run_git(["add", "-A"], cwd=local_dir)
                status = _run_git(["status", "--porcelain"], cwd=local_dir)
                pushed = False
                if status.strip():
                    _run_git(["commit", "-m", "Synced from IaC-Dashboard Sync Agent"], cwd=local_dir)
                    _run_git(["push"], cwd=local_dir)
                    pushed = True
                import time

                cfg["last_synced_at"] = time.time()
                _save_config(cfg)
                self._send_json(200, {"ok": True, "pushed": pushed, "warning": warning})
                return

            self._send_json(404, {"error": "not found"})
        except Exception as e:
            self._send_json(500, {"error": str(e)})


def main():
    print("=== IaC-Dashboard Sync Agent ===")
    print()
    print(f"Token (paste this into the dashboard's 'Sync to my computer' box):")
    print()
    print(f"    {TOKEN}")
    print()
    print(f"Listening on http://127.0.0.1:{PORT} -- leave this window open while you want syncing to work.")
    print("Close this window (or Ctrl+C) to stop.")
    print()
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    except OSError as e:
        print(f"Could not start: {e}")
        print(f"(Is another copy of this agent already running? It listens on port {PORT}.)")
        input("Press Enter to exit...")
        sys.exit(1)


if __name__ == "__main__":
    main()
