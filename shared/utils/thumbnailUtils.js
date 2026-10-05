// ─────────────────────────────────────────────────────────────
// Geração de previews. Mesmo mecanismo de composição do kiosk-app
// (thumbnailUtils.js + PrintingScreen.jsx), escalado para o tamanho
// de preview configurado (config.image.previewMaxDimension).
// Usado pelo app do fotógrafo para gerar o preview que vai para a
// tela da vendedora.
// ─────────────────────────────────────────────────────────────
import config from '../config';
import { computeAutoFit, loadImage } from './imageUtils';
import { overlayRect } from './overlayCalibration';

// Desenha a foto UMA vez no tamanho da célula, ladrilha a mesma foto na folha
// inteira e só ENTÃO aplica o molde de cada célula em coordenadas absolutas
// (sem clip por célula), para o molde poder vazar sobre a foto vizinha.
// É a MESMA ordem do composePrintImage, então o preview bate com a impressão.
// `calOf(r, c)` devolve a calibração daquela célula. `overlayImg` nulo = só a
// foto ladrilhada (usado pela miniatura sem molde).
function ladrilharComMolde(ctx, img, overlayImg, {
  printW, printH, rows, cols, editorW, editorH, scale, diffx, diffy, angle, calOf,
}) {
  const cellW = printW / cols;
  const cellH = printH / rows;

  const cellCanvas = document.createElement('canvas');
  cellCanvas.width = cellW;
  cellCanvas.height = cellH;
  const cellCtx = cellCanvas.getContext('2d');
  cellCtx.fillStyle = config.image.canvasBackground;
  cellCtx.fillRect(0, 0, cellW, cellH);

  const S = Math.max(cellW / editorW, cellH / editorH);
  const dispW = img.naturalWidth * (scale / 100) * S;
  const dispH = img.naturalHeight * (scale / 100) * S;
  const imgX = diffx * S;
  const imgY = diffy * S;

  cellCtx.save();
  const cx = imgX + dispW / 2;
  const cy = imgY + dispH / 2;
  cellCtx.translate(cx, cy);
  cellCtx.rotate((angle * Math.PI) / 180);
  cellCtx.translate(-cx, -cy);
  cellCtx.drawImage(img, imgX, imgY, dispW, dispH);
  cellCtx.restore();

  ctx.fillStyle = config.image.canvasBackground;
  ctx.fillRect(0, 0, printW, printH);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      ctx.drawImage(cellCanvas, c * cellW, r * cellH, cellW, cellH);
    }
  }

  if (overlayImg) {
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const rect = overlayRect(cellW, cellH, calOf ? calOf(r, c) : null, c * cellW, r * cellH);
        ctx.drawImage(overlayImg, rect.x, rect.y, rect.w, rect.h);
      }
    }
  }
}

// Gera um preview (JPEG) de uma foto usando os ajustes do editor
// (scale/diffx/diffy/angle). Com overlay, compõe o molde. Sem overlay,
// aplica auto-fit + rotação EXIF no arquivo cru.
export async function generatePreview(fileOrBlob, maxDim = config.image.previewMaxDimension) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const img = await loadImage(url);
    const { exifr } = await import('exifr');
    const meta = await exifr.parse(url, ['Orientation']);
    const swap = meta?.Orientation === 6 || meta?.Orientation === 8;
    const iw = swap ? img.naturalHeight : img.naturalWidth;
    const ih = swap ? img.naturalWidth : img.naturalHeight;

    const scale = Math.min(1, maxDim / Math.max(iw, ih));
    const w = Math.max(1, Math.round(iw * scale));
    const h = Math.max(1, Math.round(ih * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (swap) {
      ctx.translate(w / 2, h / 2);
      ctx.rotate((90 * Math.PI) / 180);
      ctx.translate(-w / 2, -h / 2);
    }
    ctx.drawImage(img, 0, 0, w, h);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', config.image.jpegQuality));
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Compõe um preview COM molde (overlay). O resultado é o papel inteiro com a
// foto repetida dentro do molde, pronto para a vendedora ver o que será
// impresso. `formatKey` = chave do formato (vem de `photo.key`).
export async function generateOverlayPreview(photo, fileOrBlob, maxDim = config.image.previewMaxDimension) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const key = photo.key;
    const overlayInfo = config.getOverlay(key);
    if (!overlayInfo?.grid) return null;

    const printRes = config.getPrintRes(key);
    const editorFrame = config.getEditorFrame(key);
    const { rows, cols } = overlayInfo.grid;

    const scale = Math.min(1, maxDim / Math.max(printRes.width, printRes.height));
    const printW = Math.round(printRes.width * scale);
    const printH = Math.round(printRes.height * scale);
    const editorW = editorFrame.width;
    const editorH = editorFrame.height;

    const photoImg = await loadImage(url);
    const auto = computeAutoFit(photoImg.naturalWidth, photoImg.naturalHeight, editorW, editorH);

    const canvas = document.createElement('canvas');
    canvas.width = printW;
    canvas.height = printH;
    const ctx = canvas.getContext('2d');

    // Molde de folha inteira (o PNG já é o papel todo) — sem ladrilho.
    if (overlayInfo.wholeSheet) {
      ctx.fillStyle = config.image.canvasBackground;
      ctx.fillRect(0, 0, printW, printH);
      const S = Math.max(printW / editorW, printH / editorH);
      const sPct = photo.scale ?? auto.scale;
      const dispW = photoImg.naturalWidth * (sPct / 100) * S;
      const dispH = photoImg.naturalHeight * (sPct / 100) * S;
      const imgX = (photo.diffx ?? auto.diffX) * S;
      const imgY = (photo.diffy ?? auto.diffY) * S;
      ctx.drawImage(photoImg, imgX, imgY, dispW, dispH);
      const overlayImg = await loadImage(overlayInfo.image);
      ctx.drawImage(overlayImg, 0, 0, printW, printH);
    } else {
      const overlayImg = await loadImage(overlayInfo.image);
      ladrilharComMolde(ctx, photoImg, overlayImg, {
        printW, printH, rows, cols, editorW, editorH,
        scale: photo.scale ?? auto.scale,
        diffx: photo.diffx ?? auto.diffX,
        diffy: photo.diffy ?? auto.diffY,
        angle: photo.scale != null ? (photo.angle ?? 0) : auto.angle,
        calOf: (r, c) => config.getCellCalibration(key, r, c),
      });
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', config.image.jpegQuality));
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Miniaturas compostas para os cards de formato do editor (foto dentro do molde).
// `formatKey` é a chave do formato — o thumbnail mostra a FOLHA INTEIRA daquele
// formato, então a proporção da miniatura é a do papel.
export async function generateOverlayThumbnail(photo, formatKey, dim = 240) {
  try {
    const overlayInfo = config.getOverlay(formatKey);
    if (!overlayInfo?.grid) return null;
    const printRes = config.getPrintRes(formatKey);
    const editorFrame = config.getEditorFrame(formatKey);
    const { rows, cols } = overlayInfo.grid;

    const thumbScale = dim / printRes.width;
    const printW = dim;
    const printH = Math.round(printRes.height * thumbScale);
    const editorW = editorFrame.width;
    const editorH = editorFrame.height;

    const photoImg = await loadImage(photo.url);
    const auto = computeAutoFit(photoImg.naturalWidth, photoImg.naturalHeight, editorW, editorH);

    const canvas = document.createElement('canvas');
    canvas.width = printW;
    canvas.height = printH;
    const ctx = canvas.getContext('2d');

    if (overlayInfo.wholeSheet) {
      ctx.fillStyle = '#FFFFFF';
      ctx.fillRect(0, 0, printW, printH);
      const S = Math.max(printW / editorW, printH / editorH);
      const sPct = photo.scale ?? auto.scale;
      const dispW = photoImg.naturalWidth * (sPct / 100) * S;
      const dispH = photoImg.naturalHeight * (sPct / 100) * S;
      const imgX = (photo.diffx ?? auto.diffX) * S;
      const imgY = (photo.diffy ?? auto.diffY) * S;
      ctx.drawImage(photoImg, imgX, imgY, dispW, dispH);
      const overlayImg = await loadImage(overlayInfo.image);
      ctx.drawImage(overlayImg, 0, 0, printW, printH);
    } else {
      const overlayImg = await loadImage(overlayInfo.image);
      ladrilharComMolde(ctx, photoImg, overlayImg, {
        printW, printH, rows, cols, editorW, editorH,
        scale: photo.scale ?? auto.scale,
        diffx: photo.diffx ?? auto.diffX,
        diffy: photo.diffy ?? auto.diffY,
        angle: photo.scale != null ? (photo.angle ?? 0) : auto.angle,
        calOf: (r, c) => config.getCellCalibration(formatKey, r, c),
      });
    }

    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}
