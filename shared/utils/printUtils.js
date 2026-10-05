// ─────────────────────────────────────────────────────────────
// Composição de impressão em 300 DPI — portado do kiosk-app
// (PrintingScreen.jsx processImageWithCanvas). Gera o JPEG final
// de cada foto (com molde se houver) pronto para a ASK-400.
// ─────────────────────────────────────────────────────────────
import config from '../config';
import { computeAutoFit, loadImage } from './imageUtils';
import { overlayRect } from './overlayCalibration';

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

  // ── Tipo de molde ──────────────────────────────────────
  //  · grid multi-célula — o PNG é UMA CÉLULA, repetida rows x cols na folha.
  //    É o caso da Bolinha e da Polaroide: 2 cartões por folha 10x15.
  //  · wholeSheet — o PNG é a FOLHA INTEIRA (as janelas já desenhadas na folha
  //    toda). Suportado, mas hoje nenhum formato usa: 10x15/15x20 têm PNG quase
  //    100% transparente (só moldura decorativa) e a logo sai como escrita
  //    configurável (drawLogoBadge), então não são compostos aqui.
  const temMolde = !!overlayInfo?.grid
    && (overlayInfo.wholeSheet || overlayInfo.grid.rows * overlayInfo.grid.cols > 1);
  const multiCelula = temMolde && !overlayInfo.wholeSheet;

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
    // A tela (setupCover) faz cover da JANELA do molde quando o formato tem
    // uma — então o cover aqui tem de ser o da MESMA janela, senão o papel sai
    // com zoom diferente do que a vendedora ajustou. `getOverlayWindow` cai na
    // célula inteira quando não há janela medida (10x15/15x20), o que preserva
    // o comportamento antigo sem nenhum desvio.
    const win = config.getOverlayWindow(photo.key);
    const cover = Math.max(win.w / origW, win.h / origH) * 100;
    const sd = cover * ((photo.scale ?? 100) / 100);
    const dw = (origW * sd) / 100;
    const dh = (origH * sd) / 100;
    const bd = config.getEditorBox(photo.key);
    const kx = bd.W > 0 ? editorW / bd.W : 1;
    const ky = bd.H > 0 ? editorH / bd.H : 1;
    pdvScale = sd;
    // `imgX`/`imgX2` desenham a foto pelo CANTO SUPERIOR, então diff = topo.
    // O editor posiciona a foto pelo CENTRO do box (translate(-50%,-50%)) e
    // soma offX/offY — então o canto superior na escala do compose é:
    //   centro do box + offset − metade da foto.
    // A posição da JANELA entra sozinha em offX/offY (calculado pelo
    // setupCover na tela); aqui só se converte px de box -> px de célula.
    // Sem janela (10x15/15x20) isto vira (editorW - dw)/2 + offX*kx,
    // idêntico ao comportamento antigo.
    pdvDiffX = editorW / 2 + (photo.diffx || 0) * kx - dw / 2;
    pdvDiffY = editorH / 2 + (photo.diffy || 0) * ky - dh / 2;
    console.log('[compose:pdv]', photo.key, photo.orientation,
      'zoom=', photo.scale, 'off=', photo.diffx, photo.diffy,
      'orig=', origW, 'x', origH, 'ed=', editorW, 'x', editorH, 'S=', +S.toFixed(2),
      'win=', win.w, 'x', win.h, 'scale=', +pdvScale.toFixed(2),
      'diff=', +pdvDiffX.toFixed(2), +pdvDiffY.toFixed(2),
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

  // No caso multi-célula a foto é desenhada depois, já no tamanho da célula —
  // aqui seria desenhada na folha inteira e jogada fora. Pula.
  if (!multiCelula) {
    ctx.save();
    const cx = imgX + dispW / 2;
    const cy = imgY + dispH / 2;
    ctx.translate(cx, cy);
    ctx.rotate((angle * Math.PI) / 180);
    ctx.translate(-cx, -cy);
    ctx.drawImage(img, imgX, imgY, dispW, dispH);
    ctx.restore();
  }

  // ── Molde (overlay) ──────────────────────────────────────
  if (temMolde) {
    const overlayImg = await loadImage(overlayInfo.image);
    const { rows, cols } = overlayInfo.grid;
    const cellW = printW / cols;
    const cellH = printH / rows;

    if (overlayInfo.wholeSheet) {
      ctx.drawImage(overlayImg, 0, 0, printW, printH);
    } else {
      // 1) a foto é desenhada UMA vez, no tamanho da célula. Como o
      //    `editorFrame` do formato É o tamanho da célula, S2 dá 1 e o
      //    enquadramento escolhido na tela vale aqui, px a px.
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

      // 2) ladrilha a MESMA foto na folha inteira
      ctx.fillStyle = config.image.canvasBackground;
      ctx.fillRect(0, 0, printW, printH);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          ctx.drawImage(cellCanvas, c * cellW, r * cellH, cellW, cellH);
        }
      }

      // 3) e só ENTÃO cada molde, em coordenadas absolutas da folha e SEM clip
      // por célula — assim ele pode vazar sobre a foto vizinha, igual à
      // impressão real, em vez de ser cortado na borda da célula. A
      // calibração (overlayRect) compensa a margem que a impressora corta.
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const rect = overlayRect(
            cellW, cellH, config.getCellCalibration(photo.key, r, c),
            c * cellW, r * cellH,
          );
          ctx.drawImage(overlayImg, rect.x, rect.y, rect.w, rect.h);
        }
      }
    }
  }

  // Logo do shopping (checkbox "Incluir logo do shopping nesta foto"): escrita
  // configurável na frente da foto, mesma posição do .shop-logo do editor.
  // Desenhada no canvas horizontal ANTES da rotação 15x20 — o driver da ASK-400
  // gira de volta na impressão, então a escrita sai em pé no rodapé da foto.
  // Só nos formatos que aceitam (10x15/15x20) — ver config.allowsLogo.
  if (photo.logo && config.allowsLogo(photo.key)) {
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
