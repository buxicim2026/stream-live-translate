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
# ---------------------------------------------------------------------------
param(
    [string]$ObsVersion = "30.2.3",
    [string]$ObsInstallDir = "",
    [string]$WorkDir = "build\plugin-sdk",
    [switch]$SkipEngine
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

# A relative WorkDir must be anchored at the repo root: CMake resolves a
# relative LIBOBS_INCLUDE_DIR against the plugin source directory, not our
# working directory, which would make obs-module.h unfindable.
if (-not [System.IO.Path]::IsPathRooted($WorkDir)) {
    $WorkDir = Join-Path $root $WorkDir
}

function Step([string]$msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# Version straight from Cargo.toml.
$version = (Select-String -Path "$root\Cargo.toml" -Pattern '^version = "([^"]+)"' |
    Select-Object -First 1).Matches[0].Groups[1].Value
Step "Packaging Stream Live Translate OBS plugin v$version (Windows x64)"

# --- 0. Sanity: MSVC toolchain on PATH ------------------------------------
foreach ($exe in "lib", "dumpbin", "cl") {
    if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
        throw "$exe not on PATH. Run this from a 'Developer PowerShell for VS' or call Import-Module ...Microsoft.VisualStudio.DevShell.dll; Enter-VsDevShell first."
    }
}

# --- 1. Engine -------------------------------------------------------------
if (-not $SkipEngine) {
    Step "Building Rust engine (release)"
    Push-Location $root
    cargo build --release
    Pop-Location
}
$engineExe = "$root\target\release\stream-live-translate.exe"
if (-not (Test-Path $engineExe)) { throw "engine binary missing: $engineExe" }

# --- 2. OBS SDK: headers ---------------------------------------------------
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
$obsSrc = Join-Path $WorkDir "obs-studio"
if (-not (Test-Path "$obsSrc\libobs\obs-module.h")) {
    Step "Fetching libobs headers (obs-studio $ObsVersion, shallow clone)"
    git clone --depth 1 --branch $ObsVersion https://github.com/obsproject/obs-studio $obsSrc
}

# --- 3. OBS SDK: obs.dll + import library ----------------------------------
$obsDll = ""
if ($ObsInstallDir -and (Test-Path "$ObsInstallDir\bin\64bit\obs.dll")) {
    $obsDll = "$ObsInstallDir\bin\64bit\obs.dll"
} else {
    foreach ($d in "$env:ProgramFiles\obs-studio", "${env:ProgramFiles(x86)}\obs-studio") {
        if (Test-Path "$d\bin\64bit\obs.dll") { $obsDll = "$d\bin\64bit\obs.dll"; break }
    }
}
if (-not $obsDll) {
    Step "OBS install not found; downloading official OBS-Studio-$ObsVersion zip"
    $zip = Join-Path $WorkDir "obs-full.zip"
    if (-not (Test-Path $zip)) {
        Invoke-WebRequest -Uri "https://github.com/obsproject/obs-studio/releases/download/$ObsVersion/OBS-Studio-$ObsVersion-Windows.zip" -OutFile $zip
    }
    Expand-Archive -Path $zip -DestinationPath "$WorkDir\obs-full" -Force
    $obsDll = (Get-ChildItem "$WorkDir\obs-full" -Recurse -Filter obs.dll |
        Select-Object -First 1).FullName
}
Step "Using obs.dll: $obsDll"

$sdkBin = Join-Path $WorkDir "sdk-bin"
New-Item -ItemType Directory -Force -Path $sdkBin | Out-Null
$defFile = Join-Path $sdkBin "obs.def"
$obsLib = Join-Path $sdkBin "obs.lib"
if (-not (Test-Path $obsLib)) {
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
}

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
