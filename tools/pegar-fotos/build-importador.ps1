$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $root

$proc = Get-Process -Name 'Natal_Foto_Import' -ErrorAction SilentlyContinue
if ($proc) {
  throw "Feche o importador (Natal_Foto_Import.exe) antes de gerar o build. Processo(s): $($proc.Id -join ', ')"
}

pyinstaller --noconfirm Natal_Foto_Import.spec
if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller falhou com código $LASTEXITCODE."
}

$config = Join-Path $root 'dist\Natal_Foto_Import\config.json'
if (Test-Path -LiteralPath $config) {
  Remove-Item -LiteralPath $config -Force
}

$base = Join-Path $root 'dist\Natal_Foto_Import\_internal\base_library.zip'
if (-not (Test-Path -LiteralPath $base)) {
  throw "Build incompleto: base_library.zip não encontrado."
}

Write-Output "Importador gerado em $root\dist\Natal_Foto_Import"
