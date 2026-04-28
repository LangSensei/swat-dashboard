# SWAT Dashboard Installer for Windows
# Usage: irm https://raw.githubusercontent.com/LangSensei/swat-dashboard/main/install.ps1 | iex

$ErrorActionPreference = "Stop"

$Repo = "LangSensei/swat-dashboard"
$BinDir = Join-Path $env:USERPROFILE ".swat\bin"

# --- Helpers ---

function Info  { param($Msg) Write-Host "[swat-dashboard] $Msg" -ForegroundColor Cyan }
function Ok    { param($Msg) Write-Host "[swat-dashboard] $Msg" -ForegroundColor Green }
function Err   { param($Msg) Write-Host "[swat-dashboard] $Msg" -ForegroundColor Red }
function Warn  { param($Msg) Write-Host "[swat-dashboard] $Msg" -ForegroundColor Yellow }

# --- Safety ---
if ($env:USERNAME -eq "SYSTEM") {
    Err "Do not run this installer as SYSTEM."
    exit 1
}

# --- Detect Platform ---

function Detect-Platform {
    if (-not [Environment]::Is64BitOperatingSystem) {
        Err "Only 64-bit Windows (amd64) is supported."
        exit 1
    }
    $script:Platform = "windows-amd64"
    Info "Detected platform: $script:Platform"
}

# --- Download & Extract ---

function Fetch-Release {
    $apiUrl = "https://api.github.com/repos/$Repo/releases/latest"
    $release = Invoke-RestMethod -Uri $apiUrl -UseBasicParsing
    $tag = $release.tag_name

    if (-not $tag) {
        Err "Failed to fetch latest release"
        exit 1
    }

    $script:Tag = $tag
    Info "Latest release: $tag"

    # Check if already installed at this version
    try {
        $current = & (Join-Path $BinDir "swat-dashboard.exe") --version 2>$null
        if ($current -like "*$tag*") {
            Ok "Already up to date ($tag)"
            exit 0
        }
    } catch {}

    $zipName = "swat-dashboard-${tag}-${script:Platform}.zip"
    $dlUrl = "https://github.com/$Repo/releases/download/${tag}/${zipName}"
    $tmpDir = Join-Path ([System.IO.Path]::GetTempPath()) "swat-dashboard-install-$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null

    Info "Downloading $zipName..."
    Invoke-WebRequest -Uri $dlUrl -OutFile (Join-Path $tmpDir $zipName) -UseBasicParsing

    Info "Extracting..."
    Expand-Archive -Path (Join-Path $tmpDir $zipName) -DestinationPath $tmpDir -Force

    $script:ExtractDir = $tmpDir
}

# --- Install ---

function Install-Binary {
    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    Copy-Item (Join-Path $script:ExtractDir "swat-dashboard.exe") (Join-Path $BinDir "swat-dashboard.exe") -Force
    Ok "Binary installed to $BinDir\swat-dashboard.exe"
}

# --- Post-Install ---

function Post-Install {
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$BinDir*") {
        [Environment]::SetEnvironmentVariable("Path", "$BinDir;$userPath", "User")
        $env:Path = "$BinDir;$env:Path"
        Ok "Added $BinDir to user PATH"
    }
}

# --- Cleanup ---

function Cleanup {
    if ($script:ExtractDir -and (Test-Path $script:ExtractDir)) {
        Remove-Item -Recurse -Force $script:ExtractDir -ErrorAction SilentlyContinue
    }
}

# --- Main ---

Write-Host ""
Info "Installing SWAT Dashboard..."
Write-Host ""

Detect-Platform
Fetch-Release
Install-Binary
Post-Install
Cleanup

Write-Host ""
Ok "SWAT Dashboard installed successfully! 🚀"
Write-Host ""
Info "To start the dashboard:"
Write-Host "  swat-dashboard"
Write-Host ""
Write-Host "  This opens your browser at http://localhost:8370"
Write-Host ""
Write-Host "  To customize the port:"
Write-Host '  $env:PORT = "9090"; swat-dashboard'
Write-Host ""
