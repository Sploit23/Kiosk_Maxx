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
