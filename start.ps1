# Starts IaC-Dashboard detached in the background so it survives this
# terminal closing. Safe to re-run -- it checks/kills any stale PID first.
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $root ".server.pid"
$logFile = Join-Path $root "server.log"

if (Test-Path $pidFile) {
    $oldPid = Get-Content $pidFile -ErrorAction SilentlyContinue
    if ($oldPid) {
        $existing = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
        if ($existing) {
            Write-Host "Already running (PID $oldPid). Stop it first with stop.ps1 if you want to restart."
            Start-Process "http://127.0.0.1:8765/"
            exit 0
        }
    }
}

if (-not $env:IAC_DASHBOARD_HOST) {
    # Bind to all interfaces so the dashboard stays reachable on whichever
    # Wi-Fi/LAN this machine is currently on -- no per-network reconfiguration.
    $env:IAC_DASHBOARD_HOST = "0.0.0.0"
}

$proc = Start-Process -FilePath "python" `
    -ArgumentList "`"$root\server.py`"" `
    -WorkingDirectory $root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err" `
    -PassThru

$proc.Id | Out-File -FilePath $pidFile -Encoding ascii -NoNewline

Start-Sleep -Seconds 2
Write-Host "Started IaC-Dashboard (PID $($proc.Id))."
Write-Host "Dashboard: http://127.0.0.1:8765/"

$lanIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object {
        $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" -and
        $_.InterfaceAlias -notmatch "vEthernet|WSL|Loopback|VMware|VirtualBox"
    } |
    Select-Object -ExpandProperty IPAddress -Unique

foreach ($ip in $lanIps) {
    Write-Host "LAN:       http://$ip`:8765/"
}

Write-Host "MCP (HTTP): http://127.0.0.1:8765/mcp"
Write-Host "Logs: $logFile"

Start-Process "http://127.0.0.1:8765/"
