# One-shot setup for a fresh machine: checks (and where possible,
# installs via winget) every external tool this dashboard shells out to --
# Terraform, Azure CLI, Git (for Git Bash / the in-app terminal), Graphviz
# (for the dependency graph view) -- then installs the Python dependencies.
# Safe to re-run any time: every check is a no-op if the tool's already
# there, and nothing here touches your saved projects/orgs/run history.

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

function Test-CommandExists($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Installs one tool via winget if it's missing, then re-checks. $Optional
# only changes the wording if it's still missing afterward (SKIPPED vs
# MISSING) -- it never skips the install attempt itself.
function Ensure-Tool {
    param(
        [string]$DisplayName,
        [string]$CommandName,
        [string]$WingetId,
        [bool]$Optional = $false
    )
    if (Test-CommandExists $CommandName) {
        Write-Host "[OK] $DisplayName already installed."
        return $true
    }

    if (-not (Test-CommandExists "winget")) {
        $tag = if ($Optional) { "SKIPPED" } else { "MISSING" }
        Write-Host "[$tag] $DisplayName not found, and winget isn't available to install it automatically."
        Write-Host "          Install it yourself, then re-run this script."
        return $false
    }

    Write-Host "[INSTALLING] $DisplayName (winget install --id $WingetId)..."
    winget install --id $WingetId -e --silent --accept-package-agreements --accept-source-agreements | Out-Null

    # winget-installed tools often aren't on THIS process's PATH yet even
    # though the install succeeded -- pull a fresh copy from the registry
    # before giving up on the re-check.
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
                [System.Environment]::GetEnvironmentVariable("Path", "User")

    if (Test-CommandExists $CommandName) {
        Write-Host "[OK] $DisplayName installed."
        return $true
    }

    $tag = if ($Optional) { "SKIPPED" } else { "MISSING" }
    Write-Host "[$tag] $DisplayName still not found after install -- you may need to restart your terminal/PowerShell session for PATH changes to take effect, then re-run this script."
    return $false
}

Write-Host "=== IaC-Dashboard setup ===`n"

$results = [ordered]@{}

$results["Python 3.10+"] = Test-CommandExists "python"
if ($results["Python 3.10+"]) {
    Write-Host "[OK] Python already installed."
} else {
    Write-Host "[MISSING] Python not found. Install Python 3.10+ from https://python.org (check 'Add python.exe to PATH' during install), then re-run this script."
}

$results["Terraform"] = Ensure-Tool -DisplayName "Terraform" -CommandName "terraform" -WingetId "Hashicorp.Terraform"
$results["Azure CLI"] = Ensure-Tool -DisplayName "Azure CLI" -CommandName "az" -WingetId "Microsoft.AzureCLI"
$results["Git (Git Bash, for the in-app terminal)"] = Ensure-Tool -DisplayName "Git" -CommandName "git" -WingetId "Git.Git"
$results["Graphviz (for the dependency graph view)"] = Ensure-Tool -DisplayName "Graphviz" -CommandName "dot" -WingetId "Graphviz.Graphviz" -Optional $true

$results["VS Code CLI (optional -- 'Open in VS Code' button)"] = Test-CommandExists "code"
if ($results["VS Code CLI (optional -- 'Open in VS Code' button)"]) {
    Write-Host "[OK] VS Code CLI already on PATH."
} else {
    Write-Host "[SKIPPED] VS Code's 'code' CLI not found -- only needed for the 'Open in VS Code' button (the in-app editor works fine without it). Install VS Code, then run its Command Palette -> `"Shell Command: Install 'code' command in PATH`" if you want it."
}

if ($results["Python 3.10+"]) {
    Write-Host "`nInstalling Python dependencies (pip install -r requirements.txt)..."
    & python -m pip install -r (Join-Path $root "requirements.txt")
} else {
    Write-Host "`nSkipping pip install -- Python itself is missing (see above)."
}

Write-Host "`n=== Summary ==="
foreach ($key in $results.Keys) {
    $status = if ($results[$key]) { "OK" } else { "MISSING/SKIPPED" }
    Write-Host "  [$status] $key"
}

$coreToolsReady = $results["Python 3.10+"] -and $results["Terraform"] -and $results["Azure CLI"] -and $results["Git (Git Bash, for the in-app terminal)"]

if (-not $coreToolsReady) {
    Write-Host "`nOne or more required tools are still missing (see above)."
    Write-Host "Install them, then re-run this script or just run .\start.ps1 once they're on PATH."
    exit 0
}

$azAccount = az account show 2>$null
if (-not $azAccount) {
    Write-Host "`nNot signed in to Azure yet. Run 'az login' before creating/applying any real infrastructure."
    Write-Host "(You can still start the dashboard and browse/plan without it.)"
}

Write-Host "`nSetup complete -- starting the dashboard now..."
& (Join-Path $root "start.ps1")
