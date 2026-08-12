"""
IaC-Dashboard Sync Agent -- a small local companion program with NO
CONFIGURATION UI of its own. Every control (repo URL, local folder, when
to sync) happens from the dashboard website, in your browser; this just
exposes a local HTTP API on 127.0.0.1 that the website's JS calls
directly. Runs headless in the background -- a small tray icon is the only
visible trace, with just a "Quit" option, since a genuinely background
process still needs SOME way to stop it besides Task Manager.

Why this exists: a website's JavaScript is sandboxed from your actual file
system -- there's no way for a "Sync" button on any website to run `git
clone`/`git pull` against a folder on YOUR disk. The only thing that can
touch your disk is a real program running on your machine, which is what
this is.

Security model: binds to 127.0.0.1 only (never reachable from the network,
same as this being on your own machine already implies), and every
mutating request must include the token (shown in the first-run dialog,
auto-copied to your clipboard, and saved in token.txt next to config.json
-- see below) in an `Authorization: Bearer <token>` header -- generated
once, persisted, and never sent anywhere except typed into the dashboard
by you. Without the token, an unrelated malicious site your browser
happens to have open could otherwise probe 127.0.0.1 and trigger syncs.
"""

import json
import os
import queue
import secrets
import shutil
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class _Server(ThreadingHTTPServer):
    # socketserver.TCPServer sets allow_reuse_address = True by default --
    # on Windows specifically, SO_REUSEADDR lets a COMPLETELY SEPARATE
    # process bind the same port an existing listener is already actively
    # using, with no error at all (unlike POSIX, where it mainly just
    # allows rebinding a socket still in TIME_WAIT). Two orphaned
    # instances ended up genuinely running at once this way, each with
    # its own token, with incoming requests randomly routed to whichever
    # one the OS happened to pick -- which looked exactly like "the token
    # is wrong" for whichever one lost that particular request. Disabling
    # this restores the intended behavior: a second instance's bind
    # attempt actually fails, so main() can show its "already running?"
    # error instead of silently starting a second, conflicting server.
    allow_reuse_address = False


PORT = 9876
AUTO_SYNC_INTERVAL_SECONDS = 5 * 60
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


def _load_or_create_config() -> dict:
    """Only one thing here truly needs to be race-free: the very first
    token generation. A plain check-then-write (does config exist? no ->
    generate and save) has a window where two instances starting close
    together (e.g. auto-start-at-login racing a manual double-click) can
    each decide no config exists yet and generate their OWN token -- the
    one that saves LAST silently wins, and the other instance keeps
    running with a token that no longer matches what's on disk, which
    looks exactly like "the token is wrong" even though it's the same
    string that got printed. os.O_CREAT | O_EXCL makes the create step
    atomic: only one process can ever win it, and the loser reads back
    whatever the winner actually wrote instead of trusting its own guess."""
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    os.makedirs(CONFIG_DIR, exist_ok=True)
    new_config = {"token": secrets.token_urlsafe(24)}
    try:
        fd = os.open(CONFIG_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(new_config, f, indent=2)
        return new_config
    except FileExistsError:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            return json.load(f)


_config = _load_or_create_config()
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


def _do_sync() -> dict | None:
    """The actual pull-then-push-if-anything-changed logic -- shared by
    the /sync endpoint (a manual "sync right now") and the periodic
    background loop below (a quiet "sync every few minutes" so the button
    isn't the only thing that makes this a sync AGENT rather than a
    sync-on-demand tool). Returns None if not configured yet; otherwise
    {"pushed": bool, "warning": str | None}."""
    cfg = _load_config()
    local_dir = cfg.get("local_dir")
    if not local_dir:
        return None
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
    cfg["last_synced_at"] = time.time()
    _save_config(cfg)
    return {"pushed": pushed, "warning": warning}


def _auto_sync_loop():
    """Runs for the agent's whole lifetime -- sleeps, then syncs if
    configured, forever. Silent on success/expected failures (a pull
    conflict, no network) since this is meant to be unattended; if you
    need to SEE the result, that's what the dashboard's manual "Sync to my
    computer" button and its toast are for."""
    while True:
        time.sleep(AUTO_SYNC_INTERVAL_SECONDS)
        try:
            _do_sync()
        except Exception:
            pass  # next tick tries again -- one bad sync shouldn't kill the whole loop


# Tkinter/Tcl is not thread-safe -- creating a fresh Tk() from whatever
# HTTP worker thread happens to handle a /browse-folder request works fine
# in isolation, but once the tray icon's own native message loop is
# occupying the actual main thread (see _run_tray_icon), Tcl gets confused
# about which thread is "the" main one and every dialog call fails with
# "main thread is not in main loop". The fix: one persistent hidden Tk
# root, created once on its own dedicated thread that just runs
# mainloop() forever. Every tkinter operation (folder dialog, clipboard
# copy, message dialogs) gets submitted as a callable via a thread-safe
# queue.Queue -- the ONLY thing that actually crosses threads -- which the
# Tk thread polls and executes itself; calling something like root.after()
# directly FROM a foreign thread isn't reliably guaranteed thread-safe
# either, so this avoids that question entirely.
_tk_root = None
_tk_ready = threading.Event()
_tk_work_queue = queue.Queue()


def _tk_thread_main():
    global _tk_root
    import tkinter

    _tk_root = tkinter.Tk()
    _tk_root.withdraw()
    _tk_ready.set()

    def _poll_queue():
        try:
            while True:
                job = _tk_work_queue.get_nowait()
                job()
        except queue.Empty:
            pass
        _tk_root.after(50, _poll_queue)

    _tk_root.after(50, _poll_queue)
    _tk_root.mainloop()


def _run_on_tk_thread(fn, timeout: int = 300):
    """Submits fn (a zero-arg callable that does the actual tkinter work)
    to run on the dedicated Tk thread and blocks until it completes.
    Re-raises whatever fn raised, in the calling thread, so callers can
    handle failures normally."""
    _tk_ready.wait()
    done = threading.Event()
    outcome = {}

    def _wrapped():
        try:
            outcome["value"] = fn()
        except Exception as e:
            outcome["error"] = e
        done.set()

    _tk_work_queue.put(_wrapped)
    if not done.wait(timeout=timeout):
        raise TimeoutError("timed out waiting for the tkinter thread")
    if "error" in outcome:
        raise outcome["error"]
    return outcome.get("value")


def _ask_directory_on_tk_thread() -> str | None:
    def fn():
        from tkinter import filedialog

        _tk_root.attributes("-topmost", True)
        path = filedialog.askdirectory(title="Choose a folder for IaC-Dashboard to sync into")
        return path or None

    try:
        return _run_on_tk_thread(fn)
    except Exception:
        return None


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
                    "auto_sync_interval_seconds": AUTO_SYNC_INTERVAL_SECONDS,
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
                path = _ask_directory_on_tk_thread()
                self._send_json(200, {"path": path})
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
                result = _do_sync()
                if result is None:
                    self._send_json(400, {"error": "not configured yet -- call /configure first"})
                    return
                self._send_json(200, {"ok": True, **result})
                return

            self._send_json(404, {"error": "not found"})
        except Exception as e:
            self._send_json(500, {"error": str(e)})


def _register_autostart():
    """Registers this exe to launch automatically at Windows login (HKCU
    Run key -- no admin rights needed, unlike the machine-wide equivalent).
    Only meaningful for the packaged .exe (sys.frozen); running the raw
    .py via `python sync_agent.py` skips this, since "auto-start python
    sync_agent.py" wouldn't work without the interpreter/cwd also being
    right. Re-writes the value every startup (idempotent) so it stays
    correct if you move the .exe -- the alternative, checking whether it's
    already set first, would leave a stale path behind after a move
    instead of just fixing it."""
    if not getattr(sys, "frozen", False):
        return None
    try:
        import winreg

        exe_path = sys.executable
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER, r"Software\Microsoft\Windows\CurrentVersion\Run", 0, winreg.KEY_SET_VALUE
        )
        winreg.SetValueEx(key, "IaCDashboardSyncAgent", 0, winreg.REG_SZ, f'"{exe_path}"')
        winreg.CloseKey(key)
        return True
    except Exception as e:
        print(f"(Could not register auto-start at login: {e} -- you'll need to run this manually each time.)")
        return False


def _copy_to_clipboard(text: str) -> bool:
    """Best-effort -- reuses tkinter (already a dependency, for the folder
    dialog) rather than pulling in a separate clipboard library. Not a
    security boundary either way: this just saves you selecting/copying
    text out of the console window by hand, it doesn't change who can
    retrieve the token (still only whoever's sitting at this keyboard)."""

    def fn():
        _tk_root.clipboard_clear()
        _tk_root.clipboard_append(text)
        _tk_root.update()  # actually flush the clipboard write
        return True

    try:
        return _run_on_tk_thread(fn, timeout=10)
    except Exception:
        return False


_TOKEN_FILE_PATH = os.path.join(CONFIG_DIR, "token.txt")


def _write_token_file():
    """A console would normally be where you'd re-read a forgotten token
    from -- there isn't one in this headless build, so this file is the
    fallback instead of the token only ever existing in a clipboard buffer
    that gets overwritten by the next thing you copy."""
    try:
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(_TOKEN_FILE_PATH, "w", encoding="utf-8") as f:
            f.write(TOKEN)
    except Exception:
        pass


def _show_message(title: str, message: str, timeout: int = 300):
    """Blocks the caller until dismissed (or timeout), same as
    messagebox.showinfo normally would."""

    def fn():
        from tkinter import messagebox

        messagebox.showinfo(title, message, parent=_tk_root)

    try:
        _run_on_tk_thread(fn, timeout=timeout)
    except Exception:
        pass


def _run_tray_icon(server):
    """Blocks the calling thread until Quit is clicked. If pystray/Pillow
    aren't available in this build for some reason, falls back to just
    sleeping forever instead -- still fully functional (the HTTP server
    itself doesn't need the tray to work), just with no visible way to
    stop it besides Task Manager or logging off."""
    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception:
        try:
            threading.Event().wait()  # blocks forever without busy-waiting
        except KeyboardInterrupt:
            pass
        return

    image = Image.new("RGB", (64, 64), "#0d121f")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([2, 2, 61, 61], radius=12, fill="#2563eb")
    draw.text((24, 20), "S", fill="white")

    def on_quit(icon, item):
        icon.stop()
        server.shutdown()

    icon = pystray.Icon(
        "iac-sync-agent",
        image,
        "IaC-Dashboard Sync Agent (running)",
        menu=pystray.Menu(
            pystray.MenuItem("IaC-Dashboard Sync Agent", None, enabled=False),
            pystray.MenuItem("Quit", on_quit),
        ),
    )
    icon.run()


def main():
    is_first_run = not os.path.exists(_TOKEN_FILE_PATH)
    _register_autostart()
    _write_token_file()

    # Starts before anything else uses tkinter (clipboard copy, the
    # message dialogs below, and later the folder-browse endpoint) -- see
    # the comment above _tk_thread_main for why everything tkinter-related
    # has to funnel through this one persistent thread.
    threading.Thread(target=_tk_thread_main, daemon=True).start()

    copied = _copy_to_clipboard(TOKEN)

    try:
        server = _Server(("127.0.0.1", PORT), Handler)
    except OSError as e:
        _show_message(
            "IaC-Dashboard Sync Agent -- could not start",
            f"{e}\n\nIs another copy of this agent already running? It listens on port {PORT}.",
        )
        sys.exit(1)

    # Server starts FIRST, before the (blocking) first-run dialog -- the
    # API has to be immediately usable regardless of whether/when someone
    # actually dismisses that informational popup.
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    threading.Thread(target=_auto_sync_loop, daemon=True).start()

    if is_first_run:
        _show_message(
            "IaC-Dashboard Sync Agent",
            "Running in the background -- look for its icon in the system tray (click Quit there to stop it).\n\n"
            + ("Your pairing token has been copied to your clipboard; " if copied else "")
            + "paste it into the dashboard's 'Local Sync Agent' panel.\n\n"
            f"If you need the token again later, it's saved in:\n{_TOKEN_FILE_PATH}",
        )

    _run_tray_icon(server)


if __name__ == "__main__":
    main()
