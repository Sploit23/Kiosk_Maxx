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

function gerarMachineId() {
  return (typeof crypto?.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'mk-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
}

export function formatarCodigoKiosk(code) {
  return String(code || '').replace(/(.{4})/g, '$1-').replace(/-$/, '');
}

let _identidade = null;
let _identidadeProm = null;

async function lerConfigComRetry() {
  // Se o sidecar ainda não escutou, NÃO trata a falha como config vazia
  // (evita gerar código fantasma novo a cada boot atrasado e desemparelhar).
  let cfg = null;
  for (let i = 0; i < 10 && !cfg; i++) {
    try { const c = await natalApi.getConfig(); if (c && typeof c === 'object') cfg = c; } catch { /* retry */ }
    if (!cfg) await new Promise((r) => setTimeout(r, 250));
  }
  return cfg;
}

async function resolverIdentidade() {
  const cfg = await lerConfigComRetry();
  if (!cfg) return null; // nunca fabrica código com leitura falha
  const changes = {};
  if (!cfg.machineId) changes.machineId = gerarMachineId();
  if (!cfg.kioskCode) changes.kioskCode = gerarCodigoKiosk();
  if (Object.keys(changes).length) {
    try { await natalApi.saveConfig(changes); } catch { /* best-effort */ }
    Object.assign(cfg, changes);
  }
  _identidade = { machineId: cfg.machineId || '', kioskCode: cfg.kioskCode || '' };
  return _identidade;
}

// Single-flight: chamadas concorrentes compartilham UMA resolução.
export function garantirIdentidade() {
  if (_identidade) return Promise.resolve(_identidade);
  if (!_identidadeProm) {
    _identidadeProm = resolverIdentidade().finally(() => { _identidadeProm = null; });
  }
  return _identidadeProm;
}

// Emparelha com o portal e, no sucesso, carimba o lojaId canônico no
// sidecar e no electron-config.json (para login/equipe usarem a loja certa).
export async function emparelharKiosk() {
  let ident;
  try { ident = await garantirIdentidade(); } catch { return null; }
  if (!ident || !ident.kioskCode || !ident.machineId) return null; // sidecar ainda subindo
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