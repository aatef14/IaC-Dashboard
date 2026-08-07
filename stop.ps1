$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".server.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file found -- nothing tracked as running."
    exit 0
}

$targetPid = Get-Content $pidFile -ErrorAction SilentlyContinue
Remove-Item $pidFile -ErrorAction SilentlyContinue

if (-not $targetPid) {
    Write-Host "PID file was empty."
    exit 0
}

$existing = Get-Process -Id $targetPid -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Process $targetPid was not running."
    exit 0
}

Stop-Process -Id $targetPid -Force
Write-Host "Stopped IaC-Dashboard (PID $targetPid)."
