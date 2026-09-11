# Publica o backend "natalcontroler" no HostGator via FTP (curl.exe).
# Lê as credenciais de credencial.txt na raiz do projeto (..\..\credencial.txt).
$ErrorActionPreference = 'Stop'

$self = $PSScriptRoot
$credFile = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) 'credencial.txt'
if (-not (Test-Path -LiteralPath $credFile)) {
    Write-Error "credencial.txt nao encontrado em $credFile"
}

$fields = @{}
$content = [System.IO.File]::ReadAllText($credFile)
($content -split "`r?`n") | ForEach-Object {
    $line = $_.Trim()
    if ($line -eq '') { return }
    if ($line -match '^Servidor') { $fields.host = ($line -split ':', 2)[1].Trim() }
    elseif ($line -match '^Porta') { $fields.port = ($line -split ':', 2)[1].Trim() }
    elseif ($line -match '^Usu') { $fields.user = ($line -split ':', 2)[1].Trim() }
    elseif ($line -match '^Senha') {
        $v = $line -replace '^Senha\s*[-:]\s*', ''
        $fields.pass = $v.Trim()
    }
    elseif ($line -match '^Pasta') { $fields.folder = ($line -split ':', 2)[1].Trim() }
}
if (-not ($fields.host -and $fields.user -and $fields.pass -and $fields.folder)) {
    Write-Error 'Campos insuficientes em credencial.txt'
}

$files = @('index.html', 'api.php', 'config.php', 'admin.html', '.htaccess', 'data/.htaccess')
$folder = $fields.folder.TrimStart('/').TrimEnd('/')
$failed = $false

foreach ($f in $files) {
    $local = Join-Path $self $f
    if (-not (Test-Path -LiteralPath $local)) { Write-Error "Arquivo local nao encontrado: $local" }
    $dest = "ftp://$($fields.host)/$folder/$f"
    Write-Host "-> $dest"
    & curl.exe --silent --show-error --ftp-create-dirs --user "$($fields.user):$($fields.pass)" -T $local $dest
    if ($LASTEXITCODE -ne 0) {
        $failed = $true
        Write-Host "ERRO ao enviar $f (exit $LASTEXITCODE)"
    }
    else {
        Write-Host "OK  $f"
    }
}

if ($failed) {
    Write-Host ''
    Write-Host 'Publicacao com erros. Verifique o FTP.'
    exit 1
}

Write-Host ''
Write-Host 'Publicacao concluida.'
Write-Host 'Portal: https://maxxfoto.com.br/natalcontroler/admin.html'
Write-Host 'API   : https://maxxfoto.com.br/natalcontroler/api.php?action=health'
exit 0