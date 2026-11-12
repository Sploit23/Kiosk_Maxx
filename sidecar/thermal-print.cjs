// Impressao de cupom texto na impressora termica via driver do Windows (GDI).
// Usado pelo sidecar para o tablet/celular imprimir sem depender do Electron.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function log(msg) {
  console.log(`[thermal-print] ${msg}`);
}

function printBematech({ texto, qr, titulo, subtitulo, telefone, qrLabel, printerName } = {}) {
  let qrPath = '';
  const limparQr = () => {
    if (!qrPath) return;
    try { fs.unlinkSync(qrPath); } catch {}
    qrPath = '';
  };

  try {
    const txt = typeof texto === 'string' ? texto : '';
    if (!txt.trim()) {
      return Promise.resolve({ success: false, error: 'texto vazio' });
    }
    if (typeof qr === 'string' && qr.trim()) {
      const m = qr.match(/^data:image\/[a-z0-9.+-]+;base64,(.+)$/i);
      const b64qr = (m ? m[1] : qr).replace(/\s+/g, '');
      const buf = Buffer.from(b64qr, 'base64');
      if (buf.length > 0) {
        qrPath = path.join(os.tmpdir(), 'natal-qr-' + process.pid + '-' + Date.now() + '.gif');
        fs.writeFileSync(qrPath, buf);
      }
    }

    const printer = String(printerName || '').trim();
    if (!printer) {
      return Promise.resolve({ success: false, error: 'IMPRESSORA_TERMICA_NAO_CONFIGURADA' });
    }
    const docName = 'NatalCupom-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    const safe = txt.replace(/\r/g, '').replace(/\n/g, '\r\n');
    const b64 = Buffer.from(safe + '\r\n\r\n\r\n', 'utf8').toString('base64');
    const tituloB64 = Buffer.from(typeof titulo === 'string' ? titulo : '', 'utf8').toString('base64');
    const subtituloB64 = Buffer.from(typeof subtitulo === 'string' ? subtitulo : '', 'utf8').toString('base64');
    const telefoneB64 = Buffer.from(typeof telefone === 'string' ? telefone : '', 'utf8').toString('base64');
    const qrLabelB64 = Buffer.from(typeof qrLabel === 'string' ? qrLabel : '', 'utf8').toString('base64');
    const qrSafe = qrPath.replace(/'/g, "''");
    const printerSafe = printer.replace(/'/g, "''");
    const docSafe = docName.replace(/'/g, "''");

    const ps = [
      "Add-Type -AssemblyName System.Drawing;",
      "Add-Type -AssemblyName System.Windows.Forms;",
      "$pd = New-Object System.Drawing.Printing.PrintDocument;",
      "$pd.PrinterSettings.PrinterName = '" + printerSafe + "';",
      "if (-not $pd.PrinterSettings.IsValid) { [Console]::Error.WriteLine('PRINT_FAIL printer_invalid'); exit 2; }",
      "$pd.DocumentName = '" + docSafe + "';",
      "$pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins -ArgumentList 0,0,0,0;",
      "$txt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + b64 + "'));",
      "$titulo = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + tituloB64 + "'));",
      "$subtitulo = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + subtituloB64 + "'));",
      "$telefone = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + telefoneB64 + "'));",
      "$qrLabel = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + qrLabelB64 + "'));",
      "$qrPath = '" + qrSafe + "';",
      "$pd.Add_PrintPage({ param($s,$ev);",
      "  $ev.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Pixel;",
      "  $base = 12.0;",
      "  $f0 = New-Object System.Drawing.Font('Courier New', $base, [System.Drawing.FontStyle]::Bold);",
      "  $widest = (($txt -split ([Environment]::NewLine)) | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum;",
      "  $sample = ('0' * [int]$widest);",
      "  $sz = [System.Windows.Forms.TextRenderer]::MeasureText($ev.Graphics, $sample, $f0);",
      "  $visW = $ev.Graphics.VisibleClipBounds.Width;",
      "  $target = $visW * 0.98; if ($target -le 0) { $target = 576 };",
      "  $scale = 1.0; if ($sz.Width -gt 0) { $scale = $target / $sz.Width };",
      "  $newSize = [float]([Math]::Max(8.0, [Math]::Min(30.0, $base * $scale)));",
      "  $f = New-Object System.Drawing.Font('Courier New', $newSize, [System.Drawing.FontStyle]::Bold);",
      "  $lineH = [System.Windows.Forms.TextRenderer]::MeasureText($ev.Graphics, 'Ag', $f).Height;",
      "  $y = 4.0;",
      "  if ($titulo) {",
      "    $hSize = [float]($newSize * 1.7);",
      "    $hFont = New-Object System.Drawing.Font('Arial', $hSize, [System.Drawing.FontStyle]::Bold);",
      "    $hSz = [System.Windows.Forms.TextRenderer]::MeasureText($ev.Graphics, $titulo, $hFont);",
      "    if ($hSz.Width -gt $target) {",
      "      $hSize = [float]($hSize * ($target / $hSz.Width));",
      "      $hFont = New-Object System.Drawing.Font('Arial', $hSize, [System.Drawing.FontStyle]::Bold);",
      "      $hSz = [System.Windows.Forms.TextRenderer]::MeasureText($ev.Graphics, $titulo, $hFont);",
      "    }",
      "    $hx = [Math]::Max(0, ($visW - $hSz.Width) / 2);",
      "    [System.Windows.Forms.TextRenderer]::DrawText($ev.Graphics, $titulo, $hFont, ([System.Drawing.Point]::new([int]$hx, [int]$y)), [System.Drawing.Color]::Black);",
      "    $y += $hSz.Height + 2;",
      "    if ($subtitulo) {",
      "      $sSz = [System.Windows.Forms.TextRenderer]::MeasureText($ev.Graphics, $subtitulo, $f);",
      "      $sx = [Math]::Max(0, ($visW - $sSz.Width) / 2);",
      "      [System.Windows.Forms.TextRenderer]::DrawText($ev.Graphics, $subtitulo, $f, ([System.Drawing.Point]::new([int]$sx, [int]$y)), [System.Drawing.Color]::Black);",
      "      $y += $sSz.Height + 6;",
      "    }",
      "    if ($telefone) {",
      "      $tSz = [System.Windows.Forms.TextRenderer]::MeasureText($ev.Graphics, $telefone, $f);",
      "      $tx = [Math]::Max(0, ($visW - $tSz.Width) / 2);",
      "      [System.Windows.Forms.TextRenderer]::DrawText($ev.Graphics, $telefone, $f, ([System.Drawing.Point]::new([int]$tx, [int]$y)), [System.Drawing.Color]::Black);",
      "      $y += $tSz.Height + 6;",
      "    }",
      "    $sepLine = ('-' * 32);",
      "    [System.Windows.Forms.TextRenderer]::DrawText($ev.Graphics, $sepLine, $f, ([System.Drawing.Point]::new(4, [int]$y)), [System.Drawing.Color]::Black);",
      "    $y += $lineH + 2;",
      "  }",
      "  [System.Windows.Forms.TextRenderer]::DrawText($ev.Graphics, $txt, $f, ([System.Drawing.Point]::new(4, [int]$y)), [System.Drawing.Color]::Black);",
      "  if ($qrPath -and (Test-Path -LiteralPath $qrPath)) {",
      "    try {",
      "      $img = [System.Drawing.Image]::FromFile($qrPath);",
      "      $maxW = $visW * 0.8;",
      "      $iw = [double]$img.Width; $ih = [double]$img.Height;",
      "      if ($iw -gt $maxW) { $ih = $ih * ($maxW / $iw); $iw = $maxW };",
      "      $lines = ($txt.TrimEnd() -split ([Environment]::NewLine)).Count;",
      "      $ty = $y + ($lineH * $lines) + 24;",
      "      if ($qrLabel) {",
      "        $qSize = [float]($newSize * 1.35);",
      "        $qFont = New-Object System.Drawing.Font('Arial', $qSize, [System.Drawing.FontStyle]::Bold);",
      "        $qSz = [System.Windows.Forms.TextRenderer]::MeasureText($ev.Graphics, $qrLabel, $qFont);",
      "        if ($qSz.Width -gt $target) {",
      "          $qSize = [float]($qSize * ($target / $qSz.Width));",
      "          $qFont = New-Object System.Drawing.Font('Arial', $qSize, [System.Drawing.FontStyle]::Bold);",
      "          $qSz = [System.Windows.Forms.TextRenderer]::MeasureText($ev.Graphics, $qrLabel, $qFont);",
      "        }",
      "        $qx = [Math]::Max(0, ($visW - $qSz.Width) / 2);",
      "        [System.Windows.Forms.TextRenderer]::DrawText($ev.Graphics, $qrLabel, $qFont, ([System.Drawing.Point]::new([int]$qx, [int]$ty)), [System.Drawing.Color]::Black);",
      "        $ty += $qSz.Height + 6;",
      "      }",
      "      $x = ($visW - $iw) / 2;",
      "      $ev.Graphics.DrawImage($img, [float]$x, [float]$ty, [float]$iw, [float]$ih);",
      "      $img.Dispose();",
      "    } catch { }",
      "  }",
      "  [Console]::WriteLine('PRINT widest=' + $widest + ' measured=' + $sz.Width + ' target=' + [Math]::Round($target,1) + ' scale=' + [Math]::Round($scale,3) + ' size=' + [Math]::Round($newSize,2) + ' titulo=' + $titulo + ' qrPath=' + $qrPath + ' visW=' + [Math]::Round($visW,1) + ' dpiY=' + $ev.Graphics.DpiY)",
      "});",
      "try { $pd.Print() } catch { [Console]::Error.WriteLine('PRINT_FAIL ' + $_.Exception.Message); exit 2 }",
      "$limite = (Get-Date).AddSeconds(5);",
      "$ok = $false;",
      "$falha = '';",
      "while ((Get-Date) -lt $limite) {",
      "  Start-Sleep -Milliseconds 250;",
      "  $jobs = @(Get-PrintJob -PrinterName '" + printerSafe + "' -ErrorAction SilentlyContinue | Where-Object { $_.DocumentName -eq '" + docSafe + "' });",
      "  if ($jobs.Count -eq 0) { $ok = $true; break; }",
      "  $j = $jobs[0];",
      "  if ($j.PagesPrinted -gt 0) { $ok = $true; break; }",
      "  if ($j.JobStatus -match 'Error|Retained|Blocked|Offline|Paused|Deleted|Deleting') { $falha = 'job_' + $j.JobStatus; break; }",
      "}",
      "if (-not $ok -and -not $falha) { $falha = 'job_sem_confirmacao' }",
      "if ($falha) { [Console]::Error.WriteLine('PRINT_FAIL ' + $falha); exit 3 }",
      "[Console]::WriteLine('PRINT_OK ' + '" + docSafe + "');"
    ].join('\n');

    return new Promise((resolve) => {
      try {
        log('enviando para ' + printer + ' (' + txt.length + ' chars' + (qrPath ? ', com QR' : '') + ', job ' + docName + ')');
        const psp = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
        let stderr = '';
        psp.stdout.on('data', (d) => log('out: ' + String(d).trim()));
        psp.stderr.on('data', (d) => {
          stderr += String(d);
          log('err: ' + String(d).trim());
        });
        let done = false;
        const fim = (r) => {
          if (done) return;
          done = true;
          limparQr();
          resolve(r);
        };
        const t = setTimeout(() => {
          try { psp.kill(); } catch {}
          fim({ success: false, error: 'timeout', printer });
        }, 20000);
        psp.on('error', (e) => {
          clearTimeout(t);
          fim({ success: false, error: e.message, printer });
        });
        psp.on('close', (code) => {
          clearTimeout(t);
          if (code === 0) {
            log('ok');
            fim({ success: true, printer, documentName: docName });
          } else {
            const detalhe = stderr.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
            const falha = detalhe.match(/PRINT_FAIL\s+([^\r\n]+)/);
            const erro = falha
              ? falha[1].trim()
              : 'ps_exit_' + code + (detalhe ? ': ' + detalhe : '');
            fim({ success: false, error: erro, printer });
          }
        });
      } catch (e) {
        limparQr();
        resolve({ success: false, error: e.message, printer });
      }
    });
  } catch (e) {
    limparQr();
    return Promise.resolve({ success: false, error: e.message });
  }
}

module.exports = { printBematech };
