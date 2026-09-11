// ─────────────────────────────────────────────────────────────
// Emparelhamento automático do kiosk com o portal (kiosk.pair).
// Fluxo: o PDV gera um código próprio e mostra na tela; o admin digita
// esse código na loja do portal; aqui o kiosk se identifica sozinho e
// passa a usar o lojaId canônico (window.kioskPair). Zero config manual.
// ─────────────────────────────────────────────────────────────
import natalApi from './natalApi.js';
import portalApi from './portalApi.js';

const KIOSK_ALFA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sem 0/O/1/I

export function gerarCodigoKiosk() {
  let s = '';
  for (let i = 0; i < 8; i++) s += KIOSK_ALFA[Math.floor(Math.random() * KIOSK_ALFA.length)];
  return s;
}

export function formatarCodigoKiosk(code) {
  return String(code || '').replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

// Garante que a config do sidecar tem machineId + kioskCode (gerados no
// primeiro boot e persistidos por máquina — não dependem de arquivos do
// instalador, então clones de imagem geram códigos diferentes).
export async function garantirIdentidade() {
  const cfg = (await natalApi.getConfig().catch(() => null)) || {};
  const changes = {};
  if (!cfg.machineId) {
    changes.machineId = (typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : 'mk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  }
  if (!cfg.kioskCode) changes.kioskCode = gerarCodigoKiosk();
  if (Object.keys(changes).length) {
    try { await natalApi.saveConfig(changes); } catch { /* best-effort */ }
    Object.assign(cfg, changes);
  }
  return { machineId: cfg.machineId || '', kioskCode: cfg.kioskCode || '' };
}

// Emparelha com o portal e, no sucesso, carimba o lojaId canônico no
// sidecar e no electron-config.json (para login/equipe usarem a loja certa).
export async function emparelharKiosk() {
  let ident;
  try { ident = await garantirIdentidade(); } catch { return null; }
  try {
    const res = await portalApi.pair({ kioskCode: ident.kioskCode, machineId: ident.machineId });
    if (res && res.ok) {
      window.kioskPair = res;
      try { await natalApi.saveConfig({ lojaId: res.loja.id }); } catch { /* best-effort */ }
      try { if (window.natal?.saveConfig) await window.natal.saveConfig({ lojaId: res.loja.id }); } catch { /* best-effort */ }
    }
    return res;
  } catch {
    return null;
  }
}