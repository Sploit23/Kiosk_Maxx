param(
  [string]$Origem = '',
  [switch]$Force
)

# Copia o digiCamControl instalado no PC para <repo>\digicam, de onde o
# electron-builder o embute no instalador (extraResources -> resources\digicam).
# A pasta e gitignored (sao ~225 MB de binarios GPL; nao vai para o git).
#
# Uso normal:  npm run preparar:digicam
# Forcar nova copia:  powershell -File tools/preparar-digicam.ps1 -Force
# Outra instalacao:   powershell -File tools/preparar-digicam.ps1 -Origem "D:\digiCamControl"

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$destino = Join-Path $repo 'digicam'
$exeDestino = Join-Path $destino 'CameraControl.exe'

if ((Test-Path -LiteralPath $exeDestino) -and -not $Force) {
  $versao = (Get-Item -LiteralPath $exeDestino).VersionInfo.FileVersion
  Write-Output "digiCamControl ja preparado em $destino (versao $versao). Use -Force para recopiar."
  exit 0
}

$candidatos = @()
if ($Origem) { $candidatos += $Origem }
$candidatos += @(
  (Join-Path ${env:ProgramFiles(x86)} 'digiCamControl'),
  (Join-Path $env:ProgramFiles 'digiCamControl')
)
$origemValida = $null
foreach ($c in $candidatos) {
  if (-not $c) { continue }
  if (Test-Path -LiteralPath (Join-Path $c 'CameraControl.exe')) { $origemValida = $c; break }
}
if (-not $origemValida) {
  throw "digiCamControl nao encontrado. Instale a versao 2.1.x do site oficial (https://digicamcontrol.com/download) e rode de novo, ou passe -Origem 'C:\...\digiCamControl'."
}

$versaoOrigem = (Get-Item -LiteralPath (Join-Path $origemValida 'CameraControl.exe')).VersionInfo.FileVersion
Write-Output "Copiando digiCamControl $versaoOrigem de $origemValida para $destino ..."

if (Test-Path -LiteralPath $destino) {
  Remove-Item -LiteralPath $destino -Recurse -Force
}
New-Item -ItemType Directory -Path $destino | Out-Null

# robocopy e mais rapido e tolerante a arquivos em uso (logs/temas). /NFL /NDL
# deixam a saida curta; codigos 0-7 sao sucesso.
$null = New-Item -ItemType Directory -Path $destino -Force
robocopy $origemValida $destino /E /NFL /NDL /NJH /NJS /R:1 /W:1 | Out-Null
$rc = $LASTEXITCODE
if ($rc -ge 8) { throw "robocopy falhou (codigo $rc) ao copiar $origemValida" }

if (-not (Test-Path -LiteralPath $exeDestino)) {
  throw "Copia incompleta: $exeDestino nao existe."
}

# Licenca GPL do projeto acompanha os binarios (obrigatoria na redistribuicao).
$licenca = Join-Path $destino 'Licenses\DigiCamControlLicence.txt'
if (Test-Path -LiteralPath $licenca) {
  Write-Output "Licenca GPL incluida (Licenses\DigiCamControlLicence.txt)."
} else {
  Write-Warning "Licenses\\DigiCamControlLicence.txt nao encontrado na copia - confira a pasta Licenses."
}

$bytes = (Get-ChildItem -LiteralPath $destino -Recurse -File | Measure-Object -Property Length -Sum).Sum
Write-Output ("digiCamControl pronto em {0} ({1:N1} MB, versao {2})" -f $destino, ($bytes / 1MB), $versaoOrigem)
