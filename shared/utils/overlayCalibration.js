// Calcula o retângulo onde o molde (overlay) é desenhado, dado o tamanho da
// célula e a calibração (offset X/Y em px + escala em %). `ox/oy` é a origem
// da célula em coordenadas da folha (0,0 quando desenhando só uma célula).
// Compartilhada entre a composição de impressão (printUtils), as miniaturas
// (thumbnailUtils) e o preview do editor — para que o preview sempre coincida
// com o print. Com calibração neutra (0/0/100%) o desenho preenche a célula
// inteira, que é o comportamento do PNG original.
export function overlayRect(cellW, cellH, calibration, ox = 0, oy = 0) {
  const cal = calibration || {};
  const scale = parseFloat(cal.scale);
  const s = !isNaN(scale) && scale > 0 ? scale : 100;
  const offX = parseFloat(cal.offX) || 0;
  const offY = parseFloat(cal.offY) || 0;
  const sW = cellW * (s / 100);
  const sH = cellH * (s / 100);
  return {
    x: ox + (cellW - sW) / 2 + offX,
    y: oy + (cellH - sH) / 2 + offY,
    w: sW,
    h: sH,
  };
}

// Compat: desenha o molde dentro de uma única célula (origem 0,0).
export function drawOverlayIntoCell(ctx, overlayImg, cellW, cellH, calibration) {
  const r = overlayRect(cellW, cellH, calibration);
  ctx.drawImage(overlayImg, r.x, r.y, r.w, r.h);
}
