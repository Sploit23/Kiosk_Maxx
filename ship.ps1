<#
.SYNOPSIS
  Bumpa versão, lint, build NSIS, commit, tag e push pra release no GitHub.
.EXAMPLE
  .\ship.ps1
  .\ship.ps1 1.0.5
  .\ship.ps1 1.0.5 "pdv: ajuste no modal de config"
#>
param(
  [string]$Version,
  [string]$Message
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

# ── 1. Versão ─────────────────────────────────────────────────
if (-not $Version) {
  $pkg = Get-Content package.json -Raw | ConvertFrom-Json
  $parts = $pkg.version -split '\.'
  $parts[2] = [int]$parts[2] + 1
  $Version = $parts -join '.'
}
Write-Host "Versao: $Version" -ForegroundColor Cyan

# ── 2. Bumpa package.json ────────────────────────────────────
(Get-Content package.json) -replace '"version":\s*"[^"]*"', "`"version`": `"$Version`"" | Set-Content package.json
Write-Host "package.json atualizado" -ForegroundColor Gray

# ── 3. Lint ───────────────────────────────────────────────────
Write-Host "`n--- lint ---" -ForegroundColor Yellow
npm run lint
if ($LASTEXITCODE -ne 0) { throw "lint falhou" }

# ── 4. Build NSIS ────────────────────────────────────────────
Write-Host "`n--- build:win ---" -ForegroundColor Yellow
npm run build:win
if ($LASTEXITCODE -ne 0) { throw "build falhou" }

# ── 5. Resumo do build ───────────────────────────────────────
$exe = Get-ChildItem "release\*.exe" -File | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$yml = Get-Content "release\latest.yml" -ErrorAction SilentlyContinue | Select-Object -First 1
Write-Host "`nInstalador: $($exe.Name) ($([math]::Round($exe.Length/1MB,1)) MB)" -ForegroundColor Green
Write-Host $yml -ForegroundColor Gray

# ── 6. Commit + tag + push ───────────────────────────────────
if (-not $Message) { $Message = "release v$Version" }
$tag = "v$Version"

git add -A
git commit -m "$Message" 2>&1 | Write-Host
git tag -a $tag -m "$tag" HEAD
git push origin main 2>&1 | Write-Host
git push origin $tag 2>&1 | Write-Host

Write-Host "`ntag $tag enviada. Workflow Build e Release vai rodar no GitHub." -ForegroundColor Green
Write-Host "Acompanhar: gh run list --repo Sploit23/Kiosk_Maxx --limit 1" -ForegroundColor Gray
