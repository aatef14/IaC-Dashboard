# Builds IaCDashboard.exe -- a standalone, one-person desktop app wrapping
# the SAME dashboard server.py already runs. See desktop_app.py's module
# docstring for what this is and why it's separate from the shared-instance
# dashboard / the Sync Agent.
#
# Safe to re-run any time: PyInstaller rebuilds from source, nothing here
# touches your own saved projects/orgs/run history (those live in the
# project root, not dist/build).

pip install pyinstaller pystray pillow

python -m PyInstaller --onefile --noconsole --name IaCDashboard --add-data "static;static" desktop_app.py

Write-Host ""
Write-Host "Built: dist\IaCDashboard.exe"
Write-Host "Hand this single file to anyone who wants their own full instance --"
Write-Host "no Python install needed on their machine. First run still needs"
Write-Host "Git, Terraform, and the Azure CLI on PATH (same as install.ps1 checks)."
