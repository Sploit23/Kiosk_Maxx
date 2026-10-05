// ─────────────────────────────────────────────────────────────
// Utilidades de imagem compartilhadas (editor, previews, impressão).
// Portadas do kiosk-app (src/utils/imageUtils.js).
// ─────────────────────────────────────────────────────────────

export function findBestScale(frameW, frameH, imgW, imgH) {
  return Math.max((frameW / imgW) * 100, (frameH / imgH) * 100);
}

// Auto-fit: calcula escala, centralização e rotação automáticas para encaixar a
// foto no quadro sem deixar áreas vazias (cover). Usada pelo editor, previews e impressão.
export function computeAutoFit(naturalW, naturalH, frameW, frameH) {
  const isPaperLandscape = frameW > frameH;
  const isPhotoLandscape = naturalW > naturalH;
  const angle = isPaperLandscape !== isPhotoLandscape ? 90 : 0;
  const sw = angle !== 0 ? naturalH : naturalW;
  const sh = angle !== 0 ? naturalW : naturalH;
  const scale = findBestScale(frameW, frameH, sw, sh);
  const dw = naturalW * (scale / 100);
  const dh = naturalH * (scale / 100);
  return { scale, diffX: (frameW - dw) / 2, diffY: (frameH - dh) / 2, angle };
}

// Auto-fit mirando um RETÂNGULO dentro do quadro — usado nos formatos com
// molde (bolinha/polaroide), onde a foto aparece só dentro da janela
// transparente do PNG, não na célula inteira. `target` = {x,y,w,h} em px do
// quadro: a foto preenche a janela sem deixar buraco, e o offset sai calculado
// para CENTRAR nessa janela (o `computeAutoFit` acima centraliza no quadro todo,
// o que deixaria a foto torta dentro do recorte).
// `diffX/diffY` continuam sendo medidos a partir do canto do quadro, porque é
// assim que `applyTransform` (tela) e `composePrintImage` (papel) consomem.
export function computeAutoFitInRect(naturalW, naturalH, frameW, frameH, target) {
  const t = target || { x: 0, y: 0, w: frameW, h: frameH };
  const isPaperLandscape = t.w > t.h;
  const isPhotoLandscape = naturalW > naturalH;
  const angle = isPaperLandscape !== isPhotoLandscape ? 90 : 0;
  const sw = angle !== 0 ? naturalH : naturalW;
  const sh = angle !== 0 ? naturalW : naturalH;
  // cover dentro da janela: maior escala que cobre t.w x t.h
  const scale = findBestScale(t.w, t.h, sw, sh);
  const dw = naturalW * (scale / 100);
  const dh = naturalH * (scale / 100);
  // centraliza no centro da janela; o canto do quadro continua sendo a origem
  const cx = t.x + t.w / 2;
  const cy = t.y + t.h / 2;
  return { scale, diffX: cx - dw / 2, diffY: cy - dh / 2, angle };
}

// Lê a orientação EXIF e retorna se a foto precisa girar 90° para ficar em pé
// (Orientation 6 ou 8). Retorna false em caso de erro ou ausência de EXIF.
export async function readExifOrientation(url) {
  try {
    const exifr = await import('exifr');
    const data = await exifr.default.parse(url, ['Orientation']);
    const ori = data?.Orientation || 1;
    return ori === 6 || ori === 8;
  } catch {
    return false;
  }
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Falha ao carregar: ${src}`));
    img.src = src;
  });
}

export function formatBRL(value) {
  return `R$ ${Number(value || 0).toFixed(2).replace('.', ',')}`;
}

export function formatTimestamp(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

export function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
}
