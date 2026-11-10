# ---------------------------------------------------------------------------
# package-plugin.ps1 — build the OBS plugin package for Windows x64.
#
# Output: release/stream-live-translate-obs-win-x64-<version>.zip
#
# Prerequisites (all free):
#   * Rust toolchain (rustup, stable, MSVC ABI)
#   * Visual Studio Build Tools with the C++ workload (cl, lib, dumpbin)
#   * CMake 3.16+
#   * Git
#   * OBS Studio installed somewhere (for obs.dll), or the official release
#     zip will be downloaded automatically.
#
# The script does NOT build OBS itself: it only needs libobs *headers*
# (shallow obs-studio clone) plus an import library generated from the
# installed obs.dll. Real symbols resolve at runtime against OBS.
#
# One DLL for every OBS 30+ release:
#   The plugin registers its source with obs_register_source_s(info, size).
#   libobs copies only `size` bytes into its own (possibly larger) struct
#   and zero-fills the rest, so headers from any 30+ tag produce a DLL that
#   loads on OBS 30, 31, 32, 33 and later. -ObsVersion only selects which
#   header tag to compile against; leaving it blank auto-detects the local
#   OBS installation and falls back to 30.2.3 when no tag is available.
# ---------------------------------------------------------------------------
param(
    [string]$ObsVersion = "",
    [string]$ObsInstallDir = "",
    [string]$WorkDir = "build\plugin-sdk",
    [switch]$SkipEngine
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$baselineTag = "30.2.3"

# A relative WorkDir must be anchored at the repo root: CMake resolves a
# relative LIBOBS_INCLUDE_DIR against the plugin source directory, not our
# working directory, which would make obs-module.h unfindable.
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) {
    $WorkDir = Join-Path $root $WorkDir
}

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# --- 0. Locate the installed OBS and read its version ----------------------
function Resolve-ObsInstallDir {
    param([string]$Explicit)
    if ($Explicit) {
        if (Test-Path (Join-Path $Explicit 'bin\64bit\obs.dll')) { return $Explicit }
    }
    $candidates = @(
        (Join-Path $env:ProgramFiles 'obs-studio'),
        (Join-Path ${env:ProgramFiles(x86)} 'obs-studio'),
        'C:\Program Files\obs-studio',
        'D:\Program Files\obs-studio',
        'D:\obs-studio',
        'E:\Program Files\obs-studio'
    )
    foreach ($c in $candidates) {
        if ($c -and (Test-Path (Join-Path $c 'bin\64bit\obs.dll'))) { return $c }
    }
    foreach ($key in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*',
                       'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
                       'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')) {
        foreach ($item in (Get-ItemProperty $key -ErrorAction SilentlyContinue)) {
            if ($item.DisplayName -match 'OBS Studio' -and $item.InstallLocation) {
                $c = $item.InstallLocation
                if (Test-Path (Join-Path $c 'bin\64bit\obs.dll')) { return $c }
            }
        }
    }
    return $null
}

function Clone-ObsHeaders([string]$tag, [string]$dest) {
    # git writes progress to stderr; with $ErrorActionPreference = "Stop"
    # PowerShell 5.1 would otherwise turn that into a terminating error.
    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    & git clone --depth 1 --branch $tag https://github.com/obsproject/obs-studio $dest 2>&1 | Out-Null
    $ErrorActionPreference = $prev
}

$detectedObsDir = Resolve-ObsInstallDir -Explicit $ObsInstallDir
$probe = if ($detectedObsDir) { Join-Path $detectedObsDir 'bin\64bit\obs.dll' } else { $null }
if ($probe) {
    $productVersion = (Get-Item $probe).VersionInfo.ProductVersion
    if ($productVersion -match '^(\d+\.\d+\.\d+)') {
        Write-Host "Detected OBS $($Matches[1]) at $detectedObsDir (used only for the import library)"
    }
}
if (-not $ObsVersion) {
    # Build against the OLDEST supported headers. libobs zero-extends the
    # source-info struct at registration time, so this single DLL loads on
    # every OBS 30+ release. Newer headers would also work, but older hosts
    # would then have to truncate the struct.
    $ObsVersion = $baselineTag
    Write-Host "Using baseline headers $ObsVersion -> one DLL for all OBS 30+ releases"
}

# --- 1. MSVC toolchain + engine --------------------------------------------
foreach ($exe in "lib", "dumpbin", "cl") {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        throw "$exe not on PATH. Run this from a 'Developer PowerShell for VS' or call Import-Module ...Microsoft.VisualStudio.DevShell.dll; Enter-VsDevShell first."
    }
}

$version = (Select-String -Path "$root\Cargo.toml" -Pattern '^version = "([^"]+)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
Step "Packaging Stream Live Translate OBS plugin v$version (Windows x64)"

if (-not $SkipEngine) {
    Step "Building Rust engine (release)"
    Push-Location $root
    cargo build --release
    Pop-Location
}
$engineExe = "$root\target\release\stream-live-translate.exe"
if (-not (Test-Path $engineExe)) { throw "engine binary missing: $engineExe" }

# --- 2. OBS SDK: headers ---------------------------------------------------
# Per-version checkout: switching OBS versions must not silently reuse an
# older header tree. If the detected tag is not published (beta / custom
# builds) fall back to the 30.2.3 baseline — still fine thanks to the
# obs_register_source_s size contract.
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$headerTag = $ObsVersion
$obsSrc = Join-Path $WorkDir "obs-studio-$headerTag"
if (-not (Test-Path "$obsSrc\libobs\obs-module.h")) {
    Step "Fetching libobs headers (obs-studio $headerTag, shallow clone)"
    Clone-ObsHeaders $headerTag $obsSrc
    if (-not (Test-Path "$obsSrc\libobs\obs-module.h")) {
        Write-Host "Tag $headerTag unavailable; falling back to $baselineTag headers"
        if (Test-Path $obsSrc) { Remove-Item $obsSrc -Recurse -Force }
        $headerTag = $baselineTag
        $obsSrc = Join-Path $WorkDir "obs-studio-$headerTag"
        if (-not (Test-Path "$obsSrc\libobs\obs-module.h")) {
            Clone-ObsHeaders $headerTag $obsSrc
        }
    }
}
if (-not (Test-Path "$obsSrc\libobs\obs-module.h")) { throw "failed to fetch libobs headers" }
Step "libobs headers: $headerTag"

# --- 3. obs.dll + import library -------------------------------------------
$obsDll = ""
if ($detectedObsDir) { $obsDll = Join-Path $detectedObsDir 'bin\64bit\obs.dll' }
if (-not $obsDll -or -not (Test-Path $obsDll)) {
    # No local OBS: download a known-good release zip just to extract its
    # obs.dll export table. The resulting DLL still loads on any OBS 30+.
    Step "OBS install not found; downloading OBS-Studio-$baselineTag zip for its export table"
    $zip = Join-Path $WorkDir "obs-full.zip"
    if (-not (Test-Path $zip)) {
        Invoke-WebRequest -Uri "https://github.com/obsproject/obs-studio/releases/download/$baselineTag/OBS-Studio-$baselineTag-Windows.zip" -OutFile $zip
    }
    Expand-Archive -Path $zip -DestinationPath "$WorkDir\obs-full" -Force
    $obsDll = (Get-ChildItem "$WorkDir\obs-full" -Recurse -Filter obs.dll |
        Select-Object -First 1).FullName
}
if (-not $obsDll -or -not (Test-Path $obsDll)) { throw "obs.dll not found" }
Step "Using obs.dll: $obsDll"

$sdkBin = Join-Path $WorkDir "sdk-bin"
New-Item -ItemType Directory -Force -Path $sdkBin | Out-Null
$defFile = Join-Path $sdkBin "obs.def"
$obsLib = Join-Path $sdkBin "obs.lib"
# Always regenerate: a stale obs.lib built from another OBS build would bind
# the plugin to the wrong export table.
if (Test-Path $obsLib) { Remove-Item $obsLib -Force }
Step "Generating import library obs.lib from obs.dll exports"
$exports = & dumpbin /exports $obsDll |
    Where-Object { $_ -match '^\s+\d+\s+[0-9A-F]+\s+[0-9A-F]+\s+(\S+)' } |
    ForEach-Object { $Matches[1] } |
    Where-Object { $_ -notmatch '^@' -and $_ -notmatch '\.dll$' } |
    Sort-Object -Unique
if (-not $exports) { throw "dumpbin produced no exports; wrong obs.dll?" }
Set-Content -Path $defFile -Value (@("LIBRARY obs", "EXPORTS") + $exports)
& lib /nologo /machine:x64 "/def:$defFile" "/out:$obsLib" | Out-Null
if (-not (Test-Path $obsLib)) { throw "failed to create obs.lib" }

# --- 4. Build the plugin ---------------------------------------------------
Step "Building plugin (CMake/MSVC)"
$pluginBuild = Join-Path $WorkDir "..\plugin-build-win"
cmake -S "$root\plugin" -B $pluginBuild `
    -DCMAKE_BUILD_TYPE=Release `
    "-DLIBOBS_INCLUDE_DIR=$obsSrc\libobs" `
    "-DOBS_IMPORT_LIB=$obsLib"
cmake --build $pluginBuild --config Release
$dll = Get-ChildItem $pluginBuild -Recurse -Filter "stream-live-translate.dll" |
    Select-Object -First 1
if (-not $dll) { throw "plugin dll not found" }

# --- 5. Assemble + zip ------------------------------------------------------
Step "Assembling plugin folder"
$stage = Join-Path $WorkDir "..\stage-win"
$pkgRoot = Join-Path $stage "stream-live-translate"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path "$pkgRoot\bin\64bit" | Out-Null
New-Item -ItemType Directory -Force -Path "$pkgRoot\data\locale" | Out-Null
New-Item -ItemType Directory -Force -Path "$pkgRoot\data\engine" | Out-Null
Copy-Item $dll.FullName "$pkgRoot\bin\64bit\"
Copy-Item "$root\plugin\locale\*.ini" "$pkgRoot\data\locale\"
Copy-Item $engineExe "$pkgRoot\data\engine\"
Copy-Item "$root\README.md" "$pkgRoot\README.md"

New-Item -ItemType Directory -Force -Path "$root\release" | Out-Null
$outZip = "$root\release\stream-live-translate-obs-win-x64-$version.zip"
if (Test-Path $outZip) { Remove-Item $outZip -Force }
Compress-Archive -Path "$pkgRoot" -DestinationPath $outZip
$hash = (Get-FileHash $outZip -Algorithm SHA256).Hash
Set-Content -Path "$outZip.sha256" -Value "$hash  $(Split-Path -Leaf $outZip)"

Step "Done: $outZip"
Write-Host "    SHA256: $hash"
Write-Host "    Install: extract so that the 'stream-live-translate' folder lands in"
Write-Host "    %APPDATA%\obs-studio\plugins\  (or <OBS install dir>\plugins\)"
Write-Host "    Supports: every OBS Studio 30+ release (30/31/32/33/...) with one DLL"
