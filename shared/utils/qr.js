// ─────────────────────────────────────────────────────────────
// Wrapper do gerador de QR code vendoriado (shared/vendor/qrcode.js,
// MIT — Kazuhiko Arase). Funciona 100% offline (o kiosk não tem internet
// garantida), gerando um SVG com a URL de envio digital.
// ─────────────────────────────────────────────────────────────
import qrcode from '../vendor/qrcode.js';

// Devolve a string SVG do QR para `texto`. `cellSize`/`margin` em px.
export function qrSvgTag(texto, { cellSize = 6, margin = 8, errorLevel = 'M' } = {}) {
  const qr = qrcode(0, errorLevel); // 0 = escolhe a versão automaticamente
  qr.addData(String(texto), 'Byte');
  qr.make();
  return qr.createSvgTag({ cellSize, margin });
}
