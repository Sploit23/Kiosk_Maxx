param(
  [ValidateSet('list', 'copy')]
  [string]$Mode = 'list',
  [string]$Dest = '',
  [string]$SkipFile = '',
  [switch]$CameraOnly,
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
try { $OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$photoExts = @('.jpg', '.jpeg', '.png')
$phoneRx = '(?i)android|iphone|ipad|galaxy|pixel|xiaomi|redmi|motorola|moto |samsung|smartphone|celular'
$wpdRx = '(?i)usb#vid_|\{6ac27878-a6fa-4155-ba85-f98f491d4f33\}'

function Get-CameraItems {
  $shell = New-Object -ComObject Shell.Application
  $pc = $shell.Namespace(17)
  if (-not $pc) { return @() }
  $items = @()
  foreach ($item in @($pc.Items())) {
    if (-not $item) { continue }
    $path = ''
    try { $path = [string]$item.Path } catch {}
    $name = ''
    try { $name = [string]$item.Name } catch {}
    $isWpd = ($path -match $wpdRx)
    if ($CameraOnly) {
      if (-not $isWpd) { continue }
      if ($name -match $phoneRx) { continue }
    }
    $items += $item
  }
  return $items
}

function Get-DevicePhotos {
  param($Device)
  $files = @()
  $root = $null
  try { $root = $Device.GetFolder } catch {}
  if (-not $root) { return @() }
  $stack = New-Object System.Collections.Stack
  $stack.Push($root)
  while ($stack.Count -gt 0) {
    $folder = $stack.Pop()
    if (-not $folder) { continue }
    foreach ($it in @($folder.Items())) {
      if (-not $it) { continue }
      $isFolder = $false
      try { $isFolder = [bool]$it.IsFolder } catch {}
      if ($isFolder) {
        try { $stack.Push($it.GetFolder) } catch {}
      } else {
        $ext = ''
        try { $ext = [System.IO.Path]::GetExtension((Get-ItemName $it)).ToLowerInvariant() } catch {}
        if ($photoExts -contains $ext) { $files += $it }
      }
    }
  }
  return $files
}

function Get-ItemName {
  param($Item)
  $name = ''
  try { $name = [string]$Item.ExtendedProperty('System.FileName') } catch {}
  if (-not $name) {
    try { $name = [string]$Item.Name } catch {}
  }
  return $name
}

function Get-ItemSize {
  param($Item)
  $size = 0
  try { $size = [int64]$Item.ExtendedProperty('System.Size') } catch {}
  if (-not $size) {
    try { $size = [int64]$Item.Size } catch {}
  }
  return $size
}

function Get-ItemDate {
  param($Item)
  $date = ''
  try { $date = [string]$Item.ExtendedProperty('System.DateModified') } catch {}
  if (-not $date) {
    try { $date = [string]$Item.ModifyDate } catch {}
  }
  return $date
}

function Get-ItemKey {
  param($Device, $Item)
  $dev = ''
  try { $dev = [string]$Device.Name } catch {}
  $name = Get-ItemName $Item
  $size = Get-ItemSize $Item
  $date = Get-ItemDate $Item
  return ('{0}|{1}|{2}|{3}' -f $dev, $name, $size, $date)
}

function Read-SkipKeys {
  $skip = @{}
  if (-not $SkipFile) { return $skip }
  if (-not (Test-Path -LiteralPath $SkipFile)) { return $skip }
  try {
    $data = Get-Content -LiteralPath $SkipFile -Raw -Encoding UTF8 | ConvertFrom-Json
    $raw = $data.keys
    if ($raw -is [System.Management.Automation.PSCustomObject]) {
      foreach ($p in $raw.PSObject.Properties) { $skip[[string]$p.Name] = $true }
    } else {
      foreach ($k in @($raw)) { $skip[[string]$k] = $true }
    }
  } catch {}
  return $skip
}

$skip = Read-SkipKeys
$cameras = @(Get-CameraItems)
$cameraNames = @()
foreach ($c in $cameras) {
  $n = ''
  try { $n = [string]$c.Name } catch {}
  if ($n) { $cameraNames += $n }
}

if ($Mode -eq 'list') {
  $all = @()
  $total = 0
  foreach ($dev in $cameras) {
    foreach ($it in @(Get-DevicePhotos $dev)) {
      $total++
      $key = Get-ItemKey $dev $it
      if ($skip.ContainsKey($key)) { continue }
      $name = Get-ItemName $it
      $size = Get-ItemSize $it
      $date = Get-ItemDate $it
      $devName = ''
      try { $devName = [string]$dev.Name } catch {}
      $all += [pscustomobject]@{
        key = $key
        name = $name
        size = $size
        date = $date
        device = $devName
      }
    }
  }
  $out = [pscustomobject]@{
    ok = $true
    mode = 'list'
    cameras = $cameraNames
    total = $total
    newCount = $all.Count
    files = $all
  }
  $out | ConvertTo-Json -Depth 6 -Compress
  exit 0
}

if (-not $Dest) {
  [pscustomobject]@{ ok = $false; mode = 'copy'; error = 'Destino nao informado'; cameras = $cameraNames; copied = 0; files = @(); errors = @() } | ConvertTo-Json -Depth 6 -Compress
  exit 1
}

New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$shell = New-Object -ComObject Shell.Application
$copied = @()
$errors = @()
$slotIndex = 0

foreach ($dev in $cameras) {
  $devName = ''
  try { $devName = [string]$dev.Name } catch {}
  $photos = @(Get-DevicePhotos $dev)
  foreach ($it in $photos) {
    $key = Get-ItemKey $dev $it
    if ($skip.ContainsKey($key)) { continue }
    $name = Get-ItemName $it
    if (-not $name) { continue }
    $slotIndex++
    $slot = Join-Path $Dest ('f{0:D4}' -f $slotIndex)
    New-Item -ItemType Directory -Force -Path $slot | Out-Null
    $slotFolder = $shell.Namespace($slot)
    if (-not $slotFolder) {
      $errors += $name
      continue
    }
    try {
      $slotFolder.CopyHere($it, 0x614)
    } catch {
      $errors += $name
      continue
    }
    $deadline = (Get-Date).AddSeconds([Math]::Max(10, $TimeoutSec))
    $saved = $null
    while ((Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 300
      $found = @(Get-ChildItem -LiteralPath $slot -File -ErrorAction SilentlyContinue)
      if ($found.Count -ge 1) {
        $f = $found[0]
        $s1 = 0
        try { $s1 = [int64]$f.Length } catch {}
        Start-Sleep -Milliseconds 350
        try { $f.Refresh() } catch {}
        $s2 = 0
        try { $s2 = [int64]$f.Length } catch {}
        if ($s1 -gt 0 -and $s1 -eq $s2) { $saved = $f; break }
      }
    }
    if ($saved) {
      $copied += [pscustomobject]@{
        key = $key
        name = $name
        path = [string]$saved.FullName
        size = [int64]$saved.Length
        device = $devName
      }
    } else {
      $errors += $name
    }
  }
}

$out = [pscustomobject]@{
  ok = ($errors.Count -eq 0)
  mode = 'copy'
  cameras = $cameraNames
  copied = $copied.Count
  files = $copied
  errors = $errors
}
$out | ConvertTo-Json -Depth 6 -Compress
if ($errors.Count -gt 0) { exit 2 }
exit 0
