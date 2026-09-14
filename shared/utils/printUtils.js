// ─────────────────────────────────────────────────────────────
// Composição de impressão em 300 DPI — portado do kiosk-app
// (PrintingScreen.jsx processImageWithCanvas). Gera o JPEG final
// de cada foto (com molde se houver) pronto para a ASK-400.
// ─────────────────────────────────────────────────────────────
import config from '../config';
import { computeAutoFit, loadImage } from './imageUtils';

// Dimensões do box de enquadramento do PDV (vendas.html renderFrame) —
// espelha EXATAMENTE o que a impressão mostra: formatos com molde usam
// o ratio do editorFrame (self-consistente com S), escalados pela altura
// real do box de exibição. Círculo (bolinha) é quadrado; polaroide tem card fixo.
function pdvBoxDims(editorW, editorH, orientation, circle, polaroid) {
  const H = polaroid ? 480 : (circle ? 620 : 460);
  const W = circle ? H : Math.round(H * editorW / editorH);
  return { W, H };
}

// Rotaciona um canvas 90° e retorna novo canvas (ccw=true → anti-horário).
function rotateCanvas(src, ccw) {
  const rot = document.createElement('canvas');
  rot.width = src.height;
  rot.height = src.width;
  const rCtx = rot.getContext('2d');
  rCtx.translate(rot.width / 2, rot.height / 2);
  rCtx.rotate((ccw ? -1 : 1) * (90 * Math.PI) / 180);
  rCtx.drawImage(src, -src.width / 2, -src.height / 2);
  return rot;
}

// Escreve a logo do shopping (texto) centralizada no rodapé da foto de impressão,
// replicando o .shop-logo do editor (pill escuro, borda dourada, texto dourado) em
// escala para a resolução real (o box do editor tem H=460 CSS px em 10x15/15x20).
function drawLogoBadge(ctx, W, H, texto) {
  ctx.save();
  let fontPx = Math.max(10, Math.round(10 * (H / 460)));
  ctx.font = '700 ' + fontPx + 'px Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  let tw = ctx.measureText(texto).width;
  if (tw > W * 0.72) {
    fontPx = Math.floor((fontPx * W * 0.72) / tw);
    ctx.font = '700 ' + fontPx + 'px Arial, sans-serif';
    tw = ctx.measureText(texto).width;
  }
  const padY = Math.max(4, Math.round(4 * (H / 460)));
  const padX = Math.max(10, Math.round(10 * (H / 460)));
  const barW = Math.round(tw + padX * 2);
  const barH = Math.round(fontPx * 1.2 + padY * 2 + 2);
  const barX = Math.round((W - barW) / 2);
  const barY = Math.round(H * 0.92) - barH;
  const rr = (x, y, w, h, r) => {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  };
  ctx.fillStyle = 'rgba(10,22,38,.72)';
  rr(barX, barY, barW, barH, barH / 2);
  ctx.fill();
  ctx.strokeStyle = '#d4a24c';
  ctx.lineWidth = Math.max(1, Math.round(H / 460));
  rr(barX, barY, barW, barH, barH / 2);
  ctx.stroke();
  ctx.fillStyle = '#e8c787';
  ctx.fillText(texto, W / 2, barY + barH / 2 + 1);
  ctx.restore();
}

// Compõe a imagem final de impressão de uma foto.
// `photo`: { key, url, scale, diffx, diffy, angle }
// Retorna um Blob JPEG na resolução de impressão do papel.
export async function composePrintImage(photo) {
  const printRes = config.getPrintRes(photo.key);
  const editorFrame = config.getEditorFrame(photo.key);
  const overlayInfo = config.getOverlay(photo.key);
  let printW = printRes.width;
  let printH = printRes.height;
  let editorW = editorFrame.width;
  let editorH = editorFrame.height;

  const img = await loadImage(photo.url);

  if (!overlayInfo && photo.orientation) {
    const isNatLandscape = editorW > editorH;
    const swapTo = (photo.orientation === 'retrato' && isNatLandscape) || (photo.orientation === 'paisagem' && !isNatLandscape);
    if (swapTo) {
      [editorW, editorH] = [editorH, editorW];
      [printW, printH] = [printH, printW];
    }
  }

  const canvas = document.createElement('canvas');
  canvas.width = printW;
  canvas.height = printH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = config.image.canvasBackground;
  ctx.fillRect(0, 0, printW, printH);

  const S = Math.max(printW / editorW, printH / editorH);
  const origW = img.naturalWidth;
  const origH = img.naturalHeight;
  const auto = computeAutoFit(origW, origH, editorW, editorH);

  // ── Modo PDV (vendas.html): o editor vanilla guarda zoom em % do cover e
  //    offX/offY em px do box. Converte para a escala absoluta do compose
  //    (mesma semântica do editor React), para o print sair igual à tela.
  let pdvScale, pdvDiffX, pdvDiffY;
  if (photo.pdv) {
    const cover = Math.max(editorW / origW, editorH / origH) * 100;
    const sd = cover * ((photo.scale ?? 100) / 100);
    const dw = (origW * sd) / 100;
    const dh = (origH * sd) / 100;
    const bd = pdvBoxDims(editorW, editorH, photo.orientation, photo.key === 'bolinha', photo.key === 'polaroide');
    const kx = bd.W > 0 ? editorW / bd.W : 1;
    const ky = bd.H > 0 ? editorH / bd.H : 1;
    pdvScale = sd;
    pdvDiffX = (editorW - dw) / 2 + (photo.diffx || 0) * kx;
    pdvDiffY = (editorH - dh) / 2 + (photo.diffy || 0) * ky;
    console.log('[compose:pdv]', photo.key, photo.orientation,
      'zoom=', photo.scale, 'off=', photo.diffx, photo.diffy,
      'orig=', origW, 'x', origH, 'ed=', editorW, 'x', editorH, 'S=', +S.toFixed(2),
      'scale=', +pdvScale.toFixed(2), 'diff=', +pdvDiffX.toFixed(2), +pdvDiffY.toFixed(2),
      'box=', bd.W, 'x', bd.H, 'url=', photo.url);
  } else {
    console.log('[compose:auto]', photo.key, 'scale=', (photo.scale ?? 'auto'),
      'orig=', origW, 'x', origH, 'url=', photo.url);
  }

  const scale = pdvScale ?? photo.scale ?? auto.scale;
  const diffx = pdvDiffX ?? photo.diffx ?? auto.diffX;
  const diffy = pdvDiffY ?? photo.diffy ?? auto.diffY;
  const angle = photo.pdv ? 0 : (photo.scale != null ? (photo.angle ?? 0) : auto.angle);

  const dispW = origW * (scale / 100) * S;
  const dispH = origH * (scale / 100) * S;
  const imgX = diffx * S;
  const imgY = diffy * S;

  ctx.save();
  const cx = imgX + dispW / 2;
  const cy = imgY + dispH / 2;
  ctx.translate(cx, cy);
  ctx.rotate((angle * Math.PI) / 180);
  ctx.translate(-cx, -cy);
  ctx.drawImage(img, imgX, imgY, dispW, dispH);
  ctx.restore();

  // Sobre o molde (ex.: Bolinha) no papel inteiro. Os formatos de foto pura
  // (10x15/15x20) têm molde apenas transparente com a logo antiga embutida no
  // canto — a logo sai agora como escrita configurável (drawLogoBadge), não do PNG.
  const temMoldeReal = overlayInfo?.grid && (overlayInfo.grid.rows * overlayInfo.grid.cols > 1 || photo.key === 'bolinha');
  if (temMoldeReal) {
    const overlayImg = await loadImage(overlayInfo.image);
    const { rows, cols } = overlayInfo.grid;
    const cellW = printW / cols;
    const cellH = printH / rows;

    // Para grids multi-célula (polaroid/passaporte) o desenho da foto é por
    // célula. No Natal só existe o grid 1x1 (molde ocupa o papel inteiro),
    // então desenhamos a foto no papel e o molde por cima.
    if (rows === 1 && cols === 1) {
      ctx.drawImage(overlayImg, 0, 0, printW, printH);
    } else {
      const cellCanvas = document.createElement('canvas');
      cellCanvas.width = cellW;
      cellCanvas.height = cellH;
      const cellCtx = cellCanvas.getContext('2d');
      cellCtx.fillStyle = config.image.canvasBackground;
      cellCtx.fillRect(0, 0, cellW, cellH);
      const S2 = Math.max(cellW / editorW, cellH / editorH);
      const dispW2 = origW * (scale / 100) * S2;
      const dispH2 = origH * (scale / 100) * S2;
      const imgX2 = diffx * S2;
      const imgY2 = diffy * S2;
      cellCtx.save();
      const cx2 = imgX2 + dispW2 / 2;
      const cy2 = imgY2 + dispH2 / 2;
      cellCtx.translate(cx2, cy2);
      cellCtx.rotate((angle * Math.PI) / 180);
      cellCtx.translate(-cx2, -cy2);
      cellCtx.drawImage(img, imgX2, imgY2, dispW2, dispH2);
      cellCtx.restore();
      cellCtx.drawImage(overlayImg, 0, 0, cellW, cellH);
      ctx.fillStyle = config.image.canvasBackground;
      ctx.fillRect(0, 0, printW, printH);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ctx.drawImage(cellCanvas, c * cellW, r * cellH, cellW, cellH);
        }
      }
    }
  }

  // Logo do shopping (checkbox "Incluir logo do shopping nesta foto"): escrita
  // configurável na frente da foto, mesma posição do .shop-logo do editor.
  // Desenhada no canvas horizontal ANTES da rotação 15x20 — o driver da ASK-400
  // gira de volta na impressão, então a escrita sai em pé no rodapé da foto.
  if (photo.logo) {
    const logoTexto = String(photo.logoTexto || config.logoTexto || 'SHOPPING PALLADIUM').trim();
    if (logoTexto) drawLogoBadge(ctx, printW, printH, logoTexto);
  }

  // 15x20 (media=6x8): o Java sidecar gera SEMPRE BMP retrato (1844x2436) para
  // media=6x8. Compomos em paisagem (editor paisagem) e rotacionamos 90° CCW
  // para o JPEG nascer retrato, casando ~1:1 com o BMP — sem crop lateral
  // massivo. O driver da ASK-400 gira de volta ao imprimir no papel.
  let printCanvas = canvas;
  if (config.getPaper(photo.key) === '15x20' && printCanvas.width > printCanvas.height) {
    printCanvas = rotateCanvas(canvas, true);
    console.log('[compose:rotate] 15x20 paisagem->retrato', printCanvas.width, 'x', printCanvas.height);
  } else if (printCanvas.height > printCanvas.width) {
    // guarda-corpo (kiosk-app): folha composta em retrato é girada p/ paisagem
    printCanvas = rotateCanvas(canvas, false);
  }

  const blob = await new Promise((resolve) => printCanvas.toBlob(resolve, 'image/jpeg', config.image.jpegQuality));
  return blob;
}
