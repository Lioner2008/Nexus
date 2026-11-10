# Builds Nexus-Setup.exe:  launcher + server -> payload.zip -> installer (the zip is embedded in the exe)
#   .\installer\build.ps1                 builds everything with cargo
#   .\installer\build.ps1 -SkipBuild      reuses already built exes (see -LauncherExe / -ServerExe)
param(
    [switch]$SkipBuild,
    [string]$LauncherExe = "$PSScriptRoot\..\src-tauri\target\release\nexus.exe",
    [string]$ServerExe = "$PSScriptRoot\..\server\target\release\nexus-server.exe",
    [string]$Out = "$PSScriptRoot\..\release"
)
$ErrorActionPreference = 'Stop'
$root = Resolve-Path "$PSScriptRoot\.."
if (-not $SkipBuild) {
    cargo build --release --manifest-path "$root\src-tauri\Cargo.toml"
    cargo build --release --manifest-path "$root\server\Cargo.toml"
}
$payload = "$PSScriptRoot\payload"
Remove-Item -Recurse -Force $payload -ErrorAction SilentlyContinue
New-Item -ItemType Directory $payload | Out-Null
$stage = Join-Path $env:TEMP "nexus-payload-stage"
Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory $stage | Out-Null
Copy-Item $LauncherExe "$stage\nexus.exe"
Copy-Item $ServerExe "$stage\nexus-server.exe"
Copy-Item "$root\README.md" "$stage\README.md"
Compress-Archive -Path "$stage\*" -DestinationPath "$payload\payload.zip" -Force
cargo build --release --manifest-path "$PSScriptRoot\Cargo.toml"
New-Item -ItemType Directory -Force $Out | Out-Null
$version = (Select-String -Path "$PSScriptRoot\Cargo.toml" -Pattern '^version = "(.+)"').Matches[0].Groups[1].Value
$target = if ($env:CARGO_TARGET_DIR) { $env:CARGO_TARGET_DIR } else { "$PSScriptRoot\target" }
Copy-Item "$target\release\nexus-installer.exe" "$Out\Nexus-Setup-v$version.exe" -Force
Write-Host "Installer: $Out\Nexus-Setup-v$version.exe"
