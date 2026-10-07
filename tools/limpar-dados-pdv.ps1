# Limpa os dados de teste do PDV (sidecar natal-core.cjs) com backup previo.
#
# Os dados ficam em <photosFolder>\natal-app (ou %APPDATA%\natal-app quando nao ha
# pasta de fotos configurada). O script acha essa pasta sozinho: tenta a API do
# sidecar (:9877/api/config), depois o ponteiro fotos-folder.txt, depois config.json.
#
# Uso (PowerShell):
#   powershell -ExecutionPolicy Bypass -File tools\limpar-dados-pdv.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File tools\limpar-dados-pdv.ps1
#   powershell -ExecutionPolicy Bypass -File tools\limpar-dados-pdv.ps1 -Completo
#
#   -DryRun    so mostra o que seria apagado (nao mexe em nada)
#   -Completo  apaga tambem database\config.json -> o proximo boot gera NOVO
#              machineId/kioskCode e o kiosk precisa ser re-emparelhado no portal
#              (Lojas -> EDITAR -> codigo do kiosk exibido na tela do PDV).
#              Sem -Completo o config.json e preservado: some apenas vendas,
#              sessoes, caixa, fila de impressao, auditoria e contador de fotos.
#
# IMPORTANTE: feche o aplicativo (Electron + sidecar) antes de rodar. Com o app
# aberto o sidecar reescreve pedidos/caixa/fila em memoria e o limpao se perde.
param(
  [switch]$Completo,
  [switch]$DryRun,
  [switch]$Forcar,
  [int]$Porta = 9877
)

$ErrorActionPreference = 'Stop'

function Get-ApiConfig([int]$porta) {
  try {
    return Invoke-RestMethod -Uri "http://localhost:$porta/api/config" -TimeoutSec 3 -ErrorAction Stop
  } catch {
    return $null
  }
}

function Get-AppOnline([int]$porta) {
  try {
    $r = Invoke-RestMethod -Uri "http://localhost:$porta/api/health" -TimeoutSec 3 -ErrorAction Stop
    return ($r -and $r.ok)
  } catch {
    return $false
  }
}

function Read-JsonFile([string]$path) {
  try { return Get-Content -Raw -LiteralPath $path | ConvertFrom-Json } catch { return $null }
}

function Read-Pointer([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return '' }
  try { return ([System.IO.File]::ReadAllText($path)).Trim() } catch { return '' }
}

# Mesma ordem de resolucao do natal-core/electron-main: API do sidecar, ponteiro
# fotos-folder.txt (userData do Electron e legado), electron-config.json do PDV
# (ProgramData no instalado, __dirname em dev) e por fim config.json.
function Resolve-DataDir([int]$porta) {
  $cfgApi = Get-ApiConfig $porta
  if ($cfgApi -and $cfgApi.photosFolder) {
    $f = ([string]$cfgApi.photosFolder).Trim()
    if ($f) { return (Join-Path $f 'natal-app') }
  }

  $userData = Join-Path $env:APPDATA 'natal-kiosk'
  $legado = Join-Path $env:APPDATA 'natal-app'
  foreach ($base in @($userData, $legado)) {
    $f = Read-Pointer (Join-Path $base 'database\fotos-folder.txt')
    if ($f) { return (Join-Path $f 'natal-app') }
  }

  $cfgFiles = @(
    (Join-Path 'C:\ProgramData\MaxxNatal' 'electron-config.json'),
    (Join-Path (Split-Path -Parent $PSScriptRoot) 'electron-config.json')
  )
  foreach ($c in $cfgFiles) {
    $j = if (Test-Path -LiteralPath $c) { Read-JsonFile $c } else { $null }
    if ($j -and $j.photosFolder) {
      $f = ([string]$j.photosFolder).Trim()
      if ($f) { return (Join-Path $f 'natal-app') }
    }
  }

  foreach ($base in @($userData, $legado)) {
    $j = Read-JsonFile (Join-Path $base 'database\config.json')
    if ($j -and $j.photosFolder) {
      $f = ([string]$j.photosFolder).Trim()
      if ($f) { return (Join-Path $f 'natal-app') }
    }
  }

  return $legado
}

function Count-Pedidos([string]$dbFile) {
  if (-not (Test-Path -LiteralPath $dbFile)) { return 0 }
  try {
    $arr = Get-Content -Raw -LiteralPath $dbFile | ConvertFrom-Json
    return @($arr).Count
  } catch { return 0 }
}

$root = Split-Path -Parent $PSScriptRoot
$dataDir = Resolve-DataDir $Porta

Write-Host ''
Write-Host '=== Limpeza de dados do PDV ===' -ForegroundColor Cyan
Write-Host "Pasta de dados: $dataDir"

if (-not (Test-Path -LiteralPath $dataDir)) {
  Write-Host 'Nada a limpar: a pasta de dados nao existe (PDV nunca rodou neste PC).' -ForegroundColor Yellow
  exit 0
}

# --- Trava: app aberto sobrescreve o que apagamos -----------------------------
if ((Get-AppOnline $Porta) -and -not $Forcar) {
  Write-Host ''
  Write-Host 'O PDV esta RODANDO (sidecar responde em :9877).' -ForegroundColor Red
  Write-Host 'Feche o aplicativo e rode de novo - com o app aberto o sidecar'
  Write-Host 'reescreve pedidos/caixa/fila em memoria e o limpao se perde.'
  Write-Host '(so ignore com -Forcar se souber o que esta fazendo)' -ForegroundColor DarkGray
  exit 1
}

# --- Backup ------------------------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backup = Join-Path (Split-Path -Parent $dataDir) ((Split-Path -Leaf $dataDir) + "-backup-$stamp")

# --- Alvos -------------------------------------------------------------------
$dirsAlvo = @('sessoes', 'pedidos', 'print-queue')
$dbDir = Join-Path $dataDir 'database'
$dbManter = @('config.json')
$dbAlvo = @()
if (Test-Path -LiteralPath $dbDir) {
  $dbAlvo = @(Get-ChildItem -LiteralPath $dbDir -File | Where-Object { $dbManter -notcontains $_.Name } | Select-Object -ExpandProperty Name)
  if ($Completo) { $dbAlvo = @(Get-ChildItem -LiteralPath $dbDir -File | Select-Object -ExpandProperty Name) }
}

Write-Host ''
Write-Host 'Sera apagado:'
$nPed = Count-Pedidos (Join-Path $dbDir 'pedidos.json')
Write-Host ("  sessoes/        {0} sessao(oes)" -f $(if (Test-Path -LiteralPath (Join-Path $dataDir 'sessoes')) { @(Get-ChildItem -LiteralPath (Join-Path $dataDir 'sessoes') -Directory).Count } else { 0 }))
Write-Host ("  pedidos/        {0} pasta(s) de fotos por pedido" -f $(if (Test-Path -LiteralPath (Join-Path $dataDir 'pedidos')) { @(Get-ChildItem -LiteralPath (Join-Path $dataDir 'pedidos')).Count } else { 0 }))
Write-Host ("  print-queue/    {0} item(ns) na fila de impressao" -f $(if (Test-Path -LiteralPath (Join-Path $dataDir 'print-queue')) { @(Get-ChildItem -LiteralPath (Join-Path $dataDir 'print-queue')).Count } else { 0 }))
Write-Host ("  database/       {0} arquivo(s): {1}" -f $dbAlvo.Count, ($dbAlvo -join ', '))
Write-Host ("  pedidos.json    {0} pedido(s) no historico" -f $nPed)
if (-not $Completo) { Write-Host '  PRESERVADO      database\config.json (machineId, kioskCode, pasta de fotos)' -ForegroundColor DarkGray }
if ($Completo) { Write-Host '  ATENCAO: -Completo apaga config.json -> maquina nova (re-emparelhar no portal)' -ForegroundColor Yellow }
Write-Host ''
Write-Host "Backup sera criado em: $backup"

if ($DryRun) {
  Write-Host ''
  Write-Host '-DryRun: nada foi apagado.' -ForegroundColor Yellow
  exit 0
}

# --- Executa -----------------------------------------------------------------
Copy-Item -LiteralPath $dataDir -Destination $backup -Recurse -Force
Write-Host 'Backup concluido.' -ForegroundColor Green

foreach ($d in $dirsAlvo) {
  $p = Join-Path $dataDir $d
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}
foreach ($f in $dbAlvo) {
  $p = Join-Path $dbDir $f
  if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Force }
}
# recria as pastas que o sidecar espera encontrar
foreach ($d in $dirsAlvo) {
  $p = Join-Path $dataDir $d
  if (-not (Test-Path -LiteralPath $p)) { New-Item -ItemType Directory -Path $p -Force | Out-Null }
}
New-Item -ItemType Directory -Path $dbDir -Force | Out-Null

Write-Host ''
Write-Host 'Limpeza concluida.' -ForegroundColor Green
Write-Host ''
Write-Host 'Proximos passos:'
Write-Host '  1. Abra o aplicativo (npm start / atalho do PDV).'
Write-Host '  2. Abra um novo caixa no PDV - o caixa anterior foi apagado e sem caixa'
Write-Host '     aberto o PDV nao fecha venda.'
if ($Completo) {
  Write-Host '  3. O kiosk agora tem machineId/kioskCode NOVOS: no portal, em Lojas,'
  Write-Host '     edite a loja e troque o codigo do kiosk pelo que aparece na tela do PDV.'
} else {
  Write-Host '  3. O pareamento com a loja foi mantido - o PDV volta a sincronizar sozinho.'
}
Write-Host "  (backup em $backup - apague quando confirmar que esta tudo certo)"
Write-Host ''