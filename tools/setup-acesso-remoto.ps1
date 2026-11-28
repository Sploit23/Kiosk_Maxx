# Prepara o PC do PDV para suporte remoto: Tailscale (transporte) + OpenSSH
# Server (acesso). NAO mexe no PDV, nas fotos nem nos dados do app.
#
# Rodar ELEVADO (Executar como administrador) NO PC DA LOJA:
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\setup-acesso-remoto.ps1 `
#     -PublicKey "ssh-ed25519 AAAA... suporte-natal" `
#     -AuthKey "tskey-auth-xxxxxxxx" `
#     -Hostname "natal-varzea"
#
# -AuthKey : gere em https://login.tailscale.com/admin/settings/keys
#            (tipo "Auth key", reusable, NAO efemera, validade 90 dias)
# -PublicKey: conteudo de C:\Users\<voce>\.ssh\natal_suporte.pub no PC de suporte
# -Usuario : conta Windows que o SSH vai usar (default: usuario que roda o script)
#
# Depois: no PC de suporte, `ssh -i ~\.ssh\natal_suporte <Usuario>@<IP do tailnet>`.

param(
  [Parameter(Mandatory = $true)][string]$PublicKey,
  [Parameter(Mandatory = $true)][string]$AuthKey,
  [string]$Hostname = 'natal-varzea',
  [string]$Usuario = "$env:USERNAME"
)

$ErrorActionPreference = 'Stop'

function Passo($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Ok($msg) { Write-Host "    $msg" -ForegroundColor Green }
function Aviso($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

# ---------- 0. Precisa ser admin ----------
$ident = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not (New-Object Security.Principal.WindowsPrincipal($ident)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Rode como Administrador (botao direito no PowerShell > Executar como administrador).'
}
if ($PublicKey -notmatch '^(ssh-ed25519|ssh-rsa|ecdsa-)') {
  throw 'PublicKey invalida: cole o conteudo do arquivo .pub (comeca com ssh-ed25519/ssh-rsa).'
}
$PublicKey = $PublicKey.Trim()

# ---------- 1. Tailscale ----------
Passo 'Tailscale'
$tsExe = 'C:\Program Files\Tailscale\tailscale.exe'
if (-not (Test-Path -LiteralPath $tsExe)) {
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id Tailscale.Tailscale --silent --accept-source-agreements --accept-package-agreements
  } else {
    $msi = Join-Path $env:TEMP 'tailscale-setup.msi'
    Invoke-WebRequest -Uri 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi' -OutFile $msi -UseBasicParsing
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
  }
  Start-Sleep -Seconds 5
}
if (-not (Test-Path -LiteralPath $tsExe)) { throw 'Tailscale nao foi instalado (veja a saida do winget/msi).' }

$ipTailnet = $null
for ($i = 0; $i -lt 20 -and -not $ipTailnet; $i++) {
  $ipTailnet = (& $tsExe ip -4 2>$null | Select-Object -First 1)
  if (-not $ipTailnet) {
    & $tsExe up "--authkey=$AuthKey" "--hostname=$Hostname" --accept-dns=false --unattended 2>&1 | Out-Host
    Start-Sleep -Seconds 3
  }
}
if (-not $ipTailnet) {
  throw 'Tailscale nao conectou. Confira a AuthKey (expirada/ja usada?) e rode: tailscale up'
}
Ok "Tailscale online: $ipTailnet ($Hostname)"

# ---------- 2. OpenSSH Server ----------
Passo 'OpenSSH Server'
$cap = Get-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
if ($cap.State -ne 'Installed') {
  Add-WindowsCapability -Online -Name 'OpenSSH.Server~~~~0.0.1.0'
  Ok 'Componente OpenSSH.Server instalado.'
}
Set-Service -Name sshd -StartupType Automatic
Start-Service -Name sshd
Ok ("sshd: " + (Get-Service sshd).Status)

# ---------- 3. Chave publica (sem senha) ----------
Passo 'Autorizando a chave de suporte'
$conta = New-Object System.Security.Principal.NTAccount($Usuario)
try { $sidUsuario = $conta.Translate([System.Security.Principal.SecurityIdentifier]).Value }
catch { throw "Usuario Windows '$Usuario' nao encontrado nesta maquina. Passe -Usuario <conta>." }

$ehAdmin = $false
foreach ($m in (Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction SilentlyContinue)) {
  if ($m.SID.Value -eq $sidUsuario) { $ehAdmin = $true }
}

if ($ehAdmin) {
  # Contas admin usam __PROGRAMDATA__/ssh/administrators_authorized_keys.
  $dirChaves = Join-Path $env:ProgramData 'ssh'
  $arqChaves = Join-Path $dirChaves 'administrators_authorized_keys'
  New-Item -ItemType Directory -Path $dirChaves -Force | Out-Null
  if (-not (Test-Path -LiteralPath $arqChaves)) { New-Item -ItemType File -Path $arqChaves | Out-Null }
  $linhas = @(Get-Content -LiteralPath $arqChaves -ErrorAction SilentlyContinue)
  if ($linhas -notcontains $PublicKey) {
    Add-Content -LiteralPath $arqChaves -Value $PublicKey -Encoding ascii
  }
  # Dono/ACL: somente Administrators e SYSTEM (exigencia do sshd).
  & icacls.exe $arqChaves /inheritance:r /grant '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
  Ok "Chave gravada em administrators_authorized_keys (conta admin: $Usuario)"
} else {
  $perfil = (Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $sidUsuario } | Select-Object -First 1)
  if (-not $perfil) { throw "Nao achei o perfil de $Usuario (conta nunca logou nesta maquina?)." }
  $dirChaves = Join-Path $perfil.LocalPath '.ssh'
  $arqChaves = Join-Path $dirChaves 'authorized_keys'
  New-Item -ItemType Directory -Path $dirChaves -Force | Out-Null
  if (-not (Test-Path -LiteralPath $arqChaves)) { New-Item -ItemType File -Path $arqChaves | Out-Null }
  $linhas = @(Get-Content -LiteralPath $arqChaves -ErrorAction SilentlyContinue)
  if ($linhas -notcontains $PublicKey) {
    Add-Content -LiteralPath $arqChaves -Value $PublicKey -Encoding ascii
  }
  & icacls.exe $arqChaves /inheritance:r /grant "${Usuario}:F" '*S-1-5-18:F' | Out-Null
  Ok "Chave gravada em $arqChaves"
}

# ---------- 4. sshd: so chave, sem senha ----------
Passo 'Endurecendo o sshd'
$cfg = Join-Path $env:ProgramData 'ssh\sshd_config'
if (-not (Test-Path -LiteralPath $cfg)) { throw "sshd_config nao encontrado em $cfg" }
$txt = Get-Content -LiteralPath $cfg -Raw
$txt = [regex]::Replace($txt, '(?im)^\s*#?\s*PasswordAuthentication\s+.*$', 'PasswordAuthentication no')
if ($txt -notmatch '(?im)^\s*PasswordAuthentication\s+no') {
  $txt = $txt.TrimEnd() + "`r`nPasswordAuthentication no`r`n"
}
if ($txt -notmatch '(?im)^\s*PubkeyAuthentication\s+yes') {
  $txt = $txt.TrimEnd() + "`r`nPubkeyAuthentication yes`r`n"
}
Set-Content -LiteralPath $cfg -Value $txt -Encoding ascii
Restart-Service -Name sshd
Ok 'PasswordAuthentication=no, PubkeyAuthentication=yes, sshd reiniciado.'

# ---------- 5. Firewall: SSH so pela interface do Tailscale ----------
Passo 'Firewall'
Get-NetFirewallRule -Name 'OpenSSH-Server-In-TCP' -ErrorAction SilentlyContinue | Disable-NetFirewallRule | Out-Null
if (-not (Get-NetFirewallRule -Name 'sshd-tailnet' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -Name 'sshd-tailnet' -DisplayName 'SSH (somente Tailscale)' -Direction Inbound `
    -Protocol TCP -LocalPort 22 -RemoteAddress 100.64.0.0/10 -Action Allow -Profile Any | Out-Null
}
Ok 'Porta 22 liberada apenas para 100.64.0.0/10 (tailnet).'

# ---------- 6. Resumo ----------
Passo 'Pronto'
Write-Host "    Usuario SSH : $Usuario"
Write-Host "    IP tailnet  : $ipTailnet"
Write-Host "    Hostname    : $Hostname"
Write-Host ""
Write-Host "    Do PC de suporte:" -ForegroundColor White
Write-Host "      ssh -i `$env:USERPROFILE\.ssh\natal_suporte $Usuario@$ipTailnet `"hostname`"" -ForegroundColor White
Write-Host ""
Aviso 'Se o teste falhar, confira em login.tailscale.com se os dois PCs estao na mesma conta/rede.'
