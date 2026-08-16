# ============================================================
# One-click release: bump version -> npm install -> build -> package
# Usage:
#   npm run release                 # bump patch (0.1.0 -> 0.1.1)
#   npm run release -- --minor      # bump minor (0.1.0 -> 0.2.0)
#   npm run release -- --major      # bump major (0.1.0 -> 1.0.0)
# NOTE: keep this file pure ASCII (Windows PowerShell 5.1 reads
#       BOM-less .ps1 as ANSI and CJK chars would corrupt parsing)
# ============================================================
param(
  [ValidateSet("patch", "minor", "major")]
  [string]$Bump = "patch"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$root = Split-Path -Parent $scriptDir
Set-Location $root

Write-Host ""
Write-Host "================ MarkHunter - Release ================"

# 1. bump version
$pkgPath = Join-Path $root "package.json"
$pkg = Get-Content $pkgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$ver = [version]$pkg.version
$newVer = switch ($Bump) {
  "major" { "$($ver.Major + 1).0.0" }
  "minor" { "$($ver.Major).$($ver.Minor + 1).0" }
  default { "$($ver.Major).$($ver.Minor).$($ver.Build + 1)" }
}
$pkg.version = $newVer
$json = $pkg | ConvertTo-Json -Depth 10
# write back as BOM-less UTF-8 (npm compatible)
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Version: $($ver) -> $newVer"

# 2. install deps
Write-Host ""
Write-Host "==> [1/4] npm install..."
npm.cmd install
if ($LASTEXITCODE -ne 0) { throw "npm install failed" }

# 3. build renderer
Write-Host ""
Write-Host "==> [2/4] esbuild build..."
node scripts/build.js
if ($LASTEXITCODE -ne 0) { throw "build failed" }

# 4. clean & package
Write-Host ""
Write-Host "==> [3/4] electron-builder packaging..."
if (Test-Path dist) { Remove-Item dist -Recurse -Force }
$env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
node node_modules/electron-builder/cli.js --win nsis
if ($LASTEXITCODE -ne 0) { throw "packaging failed" }

# 5. result
Write-Host ""
Write-Host "==> [4/4] Done"
$exe = Get-ChildItem dist -Filter "*.exe" -Recurse | Select-Object -First 1
if (-not $exe) { throw "installer not found" }
$sizeMB = [math]::Round($exe.Length / 1MB, 1)
Write-Host ""
Write-Host "============================================================"
Write-Host " Installer: $($exe.FullName)"
Write-Host " Size: $sizeMB MB"
Write-Host " Version: $newVer"
Write-Host " Copy it to any Windows machine and double-click to install."
Write-Host "============================================================"
