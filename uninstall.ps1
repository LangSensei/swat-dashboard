# SWAT Dashboard Uninstaller for Windows
# Usage: irm https://raw.githubusercontent.com/LangSensei/swat-dashboard/main/uninstall.ps1 | iex

$ErrorActionPreference = "Stop"

$BinDir = Join-Path $env:USERPROFILE ".swat\bin"

function Info  { param($Msg) Write-Host "[swat-dashboard] $Msg" -ForegroundColor Cyan }
function Ok    { param($Msg) Write-Host "[swat-dashboard] $Msg" -ForegroundColor Green }
function Warn  { param($Msg) Write-Host "[swat-dashboard] $Msg" -ForegroundColor Yellow }

$Purge = $args -contains "--purge"
$Yes = $args -contains "--yes"

Write-Host ""
Write-Host "  SWAT Dashboard Uninstaller"
Write-Host "  ==========================="
Write-Host ""

if (-not $Yes) {
    Warn "This will remove:"
    Write-Host "  - Binary: $BinDir\swat-dashboard.exe"
    Write-Host ""
    if ($Purge) {
        Warn "--purge: will also remove $BinDir\ if empty"
    }
    Write-Host ""
    $confirm = Read-Host "Continue? [y/N]"
    if ($confirm -notin @("y", "Y")) {
        Info "Aborted."
        exit 0
    }
}

# --- Remove binary ---

$binPath = Join-Path $BinDir "swat-dashboard.exe"
if (Test-Path $binPath) {
    Remove-Item -Force $binPath
    Ok "Removed $binPath"
} else {
    Info "Binary not found at $binPath (skipped)"
}

# --- Purge ---

if ($Purge) {
    if ((Test-Path $BinDir) -and ((Get-ChildItem $BinDir -Force).Count -eq 0)) {
        Remove-Item -Force $BinDir
        Ok "Removed empty $BinDir\"
    }
}

# --- Remove from user PATH ---

$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -like "*$BinDir*") {
    $newPath = ($userPath -split ';' | Where-Object { $_ -ne $BinDir }) -join ';'
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Ok "Removed $BinDir from user PATH"
}

Write-Host ""
Ok "SWAT Dashboard uninstalled."
echo ""
