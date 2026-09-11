// ─────────────────────────────────────────────────────────────
// Composição de impressão em 300 DPI — portado do kiosk-app
// (PrintingScreen.jsx processImageWithCanvas). Gera o JPEG final
// de cada foto (com molde se houver) pronto para a ASK-400.
// ─────────────────────────────────────────────────────────────
import config from '../config';
import { computeAutoFit, loadImage } from './imageUtils';

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
  const scale = photo.scale ?? auto.scale;
  const diffx = photo.diffx ?? auto.diffX;
  const diffy = photo.diffy ?? auto.diffY;
  const angle = photo.scale != null ? (photo.angle ?? 0) : auto.angle;

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

  // Sobre o molde (ex.: Bolinha) no papel inteiro
  if (overlayInfo?.grid) {
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

  // A ASK-400 imprime o papel em paisagem: folha composta em retrato é girada
  // 90° antes do upload (portado do kiosk-app PrintingScreen.jsx). Os formatos
  // atuais já nascem em paisagem — isto é um guarda-corpo para overlays/formatos
  // futuros (polaroid retrato etc.).
  let printCanvas = canvas;
  if (printCanvas.height > printCanvas.width) {
    const rot = document.createElement('canvas');
    rot.width = printCanvas.height;
    rot.height = printCanvas.width;
    const rCtx = rot.getContext('2d');
    rCtx.translate(rot.width / 2, rot.height / 2);
    rCtx.rotate((90 * Math.PI) / 180);
    rCtx.drawImage(printCanvas, -printCanvas.width / 2, -printCanvas.height / 2);
    printCanvas = rot;
  }

  const blob = await new Promise((resolve) => printCanvas.toBlob(resolve, 'image/jpeg', config.image.jpegQuality));
  return blob;
}
