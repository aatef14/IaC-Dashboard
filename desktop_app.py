"""
IaC-Dashboard Desktop -- packages the SAME dashboard server.py already
runs, as a standalone app for ONE person: their own local data (orgs,
projects, run history), their own git credentials, their own `az login`,
their own installed Terraform/Azure CLI. No shared instance, no other
machine involved.

Why this exists: the shared-dashboard model (one host, LAN-reachable,
every run executing under the host's Azure identity) fits a small trusted
group working off one machine, but not "I want to plan/apply under MY OWN
Azure account, independently, without someone else's machine needing to
be on." This is that -- a full instance, per person, each with their own
everything. Everything about how the dashboard itself works (orgs,
projects, Cloud-org git sync, Terraform runs) is completely unchanged;
this file only adds the "run it as a real desktop app" wrapper: its own
per-user data folder, a tray icon instead of a terminal window, and
opening a browser automatically instead of you doing it by hand.

Packaged with PyInstaller (see build_desktop_app.ps1) into a single
IaCDashboard.exe -- no Python install required on the machine running it.
"""

import os
import sys

# A --noconsole (windowed) PyInstaller build has no console to attach
# stdout/stderr to, so both are None -- fine for our own print()s (never
# called here) but not for uvicorn/logging, which unconditionally probe
# stream.isatty() while setting up their default formatter and crash with
# "NoneType has no attribute 'isatty'" the instant the server starts.
# Swapping in a stream that just discards writes is the standard fix for
# this exact class of PyInstaller --noconsole crash.
if sys.stdout is None or sys.stderr is None:

    class _NullStream:
        def write(self, *args, **kwargs):
            pass

        def flush(self):
            pass

        def isatty(self):
            return False

    sys.stdout = sys.stdout or _NullStream()
    sys.stderr = sys.stderr or _NullStream()

# Must happen BEFORE importing server -- HOST/PORT/DATA_DIR are all read
# from the environment at server.py's OWN import time, not lazily.
_DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "IaCDashboard")
os.makedirs(_DATA_DIR, exist_ok=True)
os.environ.setdefault("IAC_DASHBOARD_DATA_DIR", _DATA_DIR)
# This person's own machine only -- a per-user desktop app has no business
# being LAN-reachable the way the shared-instance dashboard is.
os.environ.setdefault("IAC_DASHBOARD_HOST", "127.0.0.1")

import shutil  # noqa: E402
import subprocess  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import traceback  # noqa: E402
import urllib.request  # noqa: E402
import webbrowser  # noqa: E402

import uvicorn  # noqa: E402

import run_manager as rm  # noqa: E402
import server  # noqa: E402

# --noconsole means there's no terminal to see a crash in -- without this,
# the server thread dying (a bad import, a port conflict, anything) is
# completely silent: the tray icon still shows "running" while the
# dashboard just never responds. Written next to the rest of this app's
# own data so it's somewhere a person would actually think to look.
_CRASH_LOG_PATH = os.path.join(_DATA_DIR, "crash.log")


def _run_server():
    try:
        rm.bootstrap()
        uvicorn.run(server.app, host=server.HOST, port=server.PORT, log_level="warning")
    except Exception:
        with open(_CRASH_LOG_PATH, "a", encoding="utf-8") as f:
            f.write(f"\n--- {time.strftime('%Y-%m-%d %H:%M:%S')} ---\n{traceback.format_exc()}")
        raise


def _wait_for_server_then_open_browser():
    url = f"http://{server.HOST}:{server.PORT}/"
    for _ in range(150):  # ~30s -- generous since first run also runs bootstrap()'s retention scan
        try:
            urllib.request.urlopen(url, timeout=1)
            break
        except Exception:
            time.sleep(0.2)
    webbrowser.open(url)


# Mirrors install.ps1's own list -- Git for Windows here also bundles Git
# Credential Manager, which is what makes cloning/pushing a private GitHub
# repo "just work" the first time (pops a browser sign-in itself, caches
# it) without this app needing to handle GitHub auth itself at all.
_WINGET_IDS = {"git": "Git.Git", "terraform": "Hashicorp.Terraform", "az": "Microsoft.AzureCLI"}


def _check_required_tools() -> list[str]:
    """Best-effort, non-blocking: without this, a missing tool only ever
    surfaces as a cryptic failure deep inside a run (e.g. "'terraform' not
    found") instead of being told up front, before you've even tried to
    use it."""
    return [name for name in _WINGET_IDS if not shutil.which(name)]


def _refresh_path_from_registry():
    """A tool winget just installed often isn't on THIS process's PATH yet
    even though the install succeeded -- re-read Machine + User PATH from
    the registry, same fix install.ps1 already needed for the same reason
    (a freshly spawned process only inherited whatever PATH existed before
    the install)."""
    try:
        import winreg

        def _read(hive, key):
            with winreg.OpenKey(hive, key) as k:
                return winreg.QueryValueEx(k, "Path")[0]

        machine = _read(winreg.HKEY_LOCAL_MACHINE, r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment")
        user = _read(winreg.HKEY_CURRENT_USER, "Environment")
        os.environ["PATH"] = f"{machine};{user}"
    except Exception:
        pass


def _install_missing_tools(missing: list[str], on_progress=None) -> list[str]:
    """Installs each missing tool via winget, silently -- same command
    install.ps1 already runs by hand, just triggered automatically instead
    of asking someone to open PowerShell and run a script themselves first.
    Returns whatever's still missing afterward (e.g. winget itself missing,
    a specific package failing, or needing a real logoff for PATH to take
    effect for OTHER already-running processes -- this one refreshes its
    own copy either way)."""
    installed_any = False
    for name in missing:
        if on_progress:
            on_progress(f"Installing {name}…")
        try:
            subprocess.run(
                [
                    "winget", "install", "--id", _WINGET_IDS[name], "-e", "--silent",
                    "--accept-package-agreements", "--accept-source-agreements",
                ],
                creationflags=subprocess.CREATE_NO_WINDOW,
                timeout=600,
                capture_output=True,
            )
            installed_any = True
        except Exception:
            pass
    if installed_any:
        _refresh_path_from_registry()
    return [name for name in missing if not shutil.which(name)]


def _run_first_time_setup():
    """Auto-installs whatever's missing via winget, with a small progress
    window so opening the .exe for the first time on a machine with none
    of these tools doesn't look like nothing is happening for several
    minutes. Blocks (deliberately) before the dashboard itself starts --
    Init/Plan/Apply need these tools to exist, so there's nothing useful
    to do yet without them anyway."""
    missing = _check_required_tools()
    if not missing:
        return
    if not shutil.which("winget"):
        _show_message(
            "IaC-Dashboard -- missing tools",
            "Not found on PATH: " + ", ".join(missing) + "\n\nwinget isn't available on this machine to install "
            "them automatically. Install Git, Terraform, and the Azure CLI yourself, then restart this app.",
        )
        return

    try:
        import tkinter
        from tkinter import ttk
    except Exception:
        # No tkinter in this build -- still install, just without a
        # visible progress window (better than not installing at all).
        still_missing = _install_missing_tools(missing)
        if still_missing:
            _show_message(
                "IaC-Dashboard -- missing tools",
                "Still not found after trying to install automatically: " + ", ".join(still_missing),
            )
        return

    root = tkinter.Tk()
    root.title("IaC-Dashboard -- first-time setup")
    root.resizable(False, False)
    root.eval("tk::PlaceWindow . center")
    label = tkinter.Label(
        root,
        text=f"Installing: {', '.join(missing)}\nThis can take a few minutes the first time.",
        justify="left",
        padx=18,
        pady=14,
    )
    label.pack()
    bar = ttk.Progressbar(root, mode="indeterminate", length=300)
    bar.pack(padx=18, pady=(0, 18))
    bar.start(12)

    result = {}

    def worker():
        result["still_missing"] = _install_missing_tools(
            missing, on_progress=lambda msg: root.after(0, label.config, {"text": msg})
        )
        root.after(0, root.destroy)

    threading.Thread(target=worker, daemon=True).start()
    root.mainloop()

    still_missing = result.get("still_missing", missing)
    if still_missing:
        _show_message(
            "IaC-Dashboard -- missing tools",
            "Still not found after trying to install automatically: "
            + ", ".join(still_missing)
            + "\n\nThe dashboard will still start, but Init/Plan/Apply need these -- install them yourself, "
            "then restart this app.",
        )


def _show_message(title: str, message: str):
    try:
        import tkinter
        from tkinter import messagebox

        root = tkinter.Tk()
        root.withdraw()
        messagebox.showwarning(title, message)
        root.destroy()
    except Exception:
        pass


def _run_tray_icon():
    """Blocks until Quit. Falls back to just staying alive (no visible
    icon, Task Manager is then the only way to stop it) if pystray/Pillow
    aren't available in this build -- the server itself doesn't need the
    tray to function."""
    try:
        import pystray
        from PIL import Image, ImageDraw
    except Exception:
        threading.Event().wait()
        return

    image = Image.new("RGB", (64, 64), "#0d121f")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle([2, 2, 61, 61], radius=12, fill="#2563eb")
    draw.text((14, 24), "IaC", fill="white")

    def on_open(icon=None, item=None):
        webbrowser.open(f"http://{server.HOST}:{server.PORT}/")

    def on_quit(icon, item):
        icon.stop()
        # uvicorn.run() in the server thread doesn't expose a clean
        # shutdown hook from here -- fine for a single-user local app,
        # nothing else on this machine depends on this process.
        os._exit(0)

    icon = pystray.Icon(
        "iac-dashboard-desktop",
        image,
        "IaC-Dashboard (running)",
        menu=pystray.Menu(
            pystray.MenuItem("Open Dashboard", on_open, default=True),
            pystray.MenuItem("Quit", on_quit),
        ),
    )
    icon.run()


def main():
    _run_first_time_setup()

    threading.Thread(target=_run_server, daemon=True).start()
    threading.Thread(target=_wait_for_server_then_open_browser, daemon=True).start()
    _run_tray_icon()


if __name__ == "__main__":
    main()
