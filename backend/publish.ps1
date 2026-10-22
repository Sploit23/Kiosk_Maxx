# Publica o backend "natalcontroler" no HostGator via FTP (curl.exe).
# Lê as credenciais de credencial.txt na raiz do projeto (..\..\credencial.txt).
$ErrorActionPreference = 'Stop'

$self = $PSScriptRoot
$raiz = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$credCandidates = @(
    (Join-Path $raiz 'credencial.txt'),
    (Join-Path $raiz 'credencial\credencial.txt'),
    (Join-Path $self 'credencial.txt')
)
$credFile = $null
foreach ($c in $credCandidates) {
    if (Test-Path -LiteralPath $c) { $credFile = $c; break }
}
if (-not $credFile) {
    Write-Error "credencial.txt nao encontrado (procurei em: $($credCandidates -join ' | '))"
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

# ── Pagina publica /natal (envio digital) ────────────────────
# Sobe para a pasta irma da natalcontroler (ex.: /public_html/natal).
$natalLocal = Join-Path $self 'natal'
$natalFolder = ($folder -replace 'natalcontroler/?$', 'natal')
if ((Test-Path -LiteralPath $natalLocal) -and ($natalFolder -ne $folder)) {
    $natalFiles = @('index.php', '.htaccess', 'fotos/.htaccess')
    foreach ($f in $natalFiles) {
        $local = Join-Path $natalLocal $f
        if (-not (Test-Path -LiteralPath $local)) { Write-Host "AVISO: $local nao existe (ignorado)"; continue }
        $dest = "ftp://$($fields.host)/$natalFolder/$f"
        Write-Host "-> $dest"
        & curl.exe --silent --show-error --ftp-create-dirs --user "$($fields.user):$($fields.pass)" -T $local $dest
        if ($LASTEXITCODE -ne 0) {
            $failed = $true
            Write-Host "ERRO ao enviar natal/$f (exit $LASTEXITCODE)"
        }
        else {
            Write-Host "OK  natal/$f"
        }
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
Write-Host 'Envio : https://maxxfoto.com.br/natal'
exit 0