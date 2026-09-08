// ─────────────────────────────────────────────────────────────
// Geração de previews. Mesmo mecanismo de composição do kiosk-app
// (thumbnailUtils.js + PrintingScreen.jsx), escalado para o tamanho
// de preview configurado (config.image.previewMaxDimension).
// Usado pelo app do fotógrafo para gerar o preview que vai para a
// tela da vendedora.
// ─────────────────────────────────────────────────────────────
import config from '../config';
import { computeAutoFit, loadImage } from './imageUtils';

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

// Compõe um preview COM molde (overlay) — formato Bolinha e afins.
// O resultado é o papel inteiro com a foto dentro do molde, pronto para
// a vendedora ver o que será impresso.
export async function generateOverlayPreview(photo, fileOrBlob, maxDim = config.image.previewMaxDimension) {
  const url = URL.createObjectURL(fileOrBlob);
  try {
    const overlayInfo = config.getOverlay(photo.key);
    if (!overlayInfo?.grid) return null;

    const printRes = config.getPrintRes(photo.key);
    const editorFrame = config.getEditorFrame(photo.key);
    const { rows, cols } = overlayInfo.grid;

    const scale = Math.min(1, maxDim / Math.max(printRes.width, printRes.height));
    const printW = Math.round(printRes.width * scale);
    const printH = Math.round(printRes.height * scale);
    const cellW = printW / cols;
    const cellH = printH / rows;
    const editorW = editorFrame.width;
    const editorH = editorFrame.height;

    const [photoImg, overlayImg] = await Promise.all([
      loadImage(url),
      loadImage(overlayInfo.image),
    ]);

    const cellCanvas = document.createElement('canvas');
    cellCanvas.width = cellW;
    cellCanvas.height = cellH;
    const cellCtx = cellCanvas.getContext('2d');
    cellCtx.fillStyle = config.image.canvasBackground;
    cellCtx.fillRect(0, 0, cellW, cellH);

    const S = Math.max(cellW / editorW, cellH / editorH);
    const origW = photoImg.naturalWidth;
    const origH = photoImg.naturalHeight;
    const auto = computeAutoFit(origW, origH, editorW, editorH);
    const scalePct = photo.scale ?? auto.scale;
    const diffx = photo.diffx ?? auto.diffX;
    const diffy = photo.diffy ?? auto.diffY;
    const angle = photo.scale != null ? (photo.angle ?? 0) : auto.angle;

    const dispW = origW * (scalePct / 100) * S;
    const dispH = origH * (scalePct / 100) * S;
    const imgX = diffx * S;
    const imgY = diffy * S;

    cellCtx.save();
    const cx = imgX + dispW / 2;
    const cy = imgY + dispH / 2;
    cellCtx.translate(cx, cy);
    cellCtx.rotate((angle * Math.PI) / 180);
    cellCtx.translate(-cx, -cy);
    cellCtx.drawImage(photoImg, imgX, imgY, dispW, dispH);
    cellCtx.restore();

    cellCtx.drawImage(overlayImg, 0, 0, cellW, cellH);

    const canvas = document.createElement('canvas');
    canvas.width = printW;
    canvas.height = printH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = config.image.canvasBackground;
    ctx.fillRect(0, 0, printW, printH);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.drawImage(cellCanvas, c * cellW, r * cellH, cellW, cellH);
      }
    }

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', config.image.jpegQuality));
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Miniaturas compostas para os cards de formato do editor (foto dentro do molde).
export async function generateOverlayThumbnail(photo, overlay, dim = 240) {
  try {
    const overlayInfo = config.overlays[overlay];
    if (!overlayInfo?.grid) return null;
    const printRes = config.getPrintRes('bolinha');
    const { rows, cols } = overlayInfo.grid;

    const thumbScale = dim / printRes.width;
    const printW = dim;
    const printH = Math.round(printRes.height * thumbScale);
    const cellW = printW / cols;
    const cellH = printH / rows;
    const editorFrame = config.getEditorFrame('bolinha');

    const [photoImg, overlayImg] = await Promise.all([
      loadImage(photo.url),
      loadImage(overlayInfo.image),
    ]);

    const cellCanvas = document.createElement('canvas');
    cellCanvas.width = cellW;
    cellCanvas.height = cellH;
    const cellCtx = cellCanvas.getContext('2d');
    cellCtx.fillStyle = '#FFFFFF';
    cellCtx.fillRect(0, 0, cellW, cellH);

    const S = Math.max(cellW / editorFrame.width, cellH / editorFrame.height);
    const auto = computeAutoFit(photoImg.naturalWidth, photoImg.naturalHeight, editorFrame.width, editorFrame.height);
    const scale = photo.scale ?? auto.scale;
    const diffx = photo.diffx ?? auto.diffX;
    const diffy = photo.diffy ?? auto.diffY;
    const angle = photo.scale != null ? (photo.angle ?? 0) : auto.angle;

    const dispW = photoImg.naturalWidth * (scale / 100) * S;
    const dispH = photoImg.naturalHeight * (scale / 100) * S;
    const imgX = diffx * S;
    const imgY = diffy * S;

    cellCtx.save();
    const cx = imgX + dispW / 2;
    const cy = imgY + dispH / 2;
    cellCtx.translate(cx, cy);
    cellCtx.rotate((angle * Math.PI) / 180);
    cellCtx.translate(-cx, -cy);
    cellCtx.drawImage(photoImg, imgX, imgY, dispW, dispH);
    cellCtx.restore();
    cellCtx.drawImage(overlayImg, 0, 0, cellW, cellH);

    const canvas = document.createElement('canvas');
    canvas.width = printW;
    canvas.height = printH;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, printW, printH);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        ctx.drawImage(cellCanvas, c * cellW, r * cellH, cellW, cellH);
      }
    }

    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return null;
  }
}
