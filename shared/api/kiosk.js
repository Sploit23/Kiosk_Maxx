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
  _identidade = {
    machineId: cfg.machineId || '',
    kioskCode: cfg.kioskCode || '',
    // Loja DEFINIDA NO APP (offline-first): o pareamento só autoriza a máquina.
    lojaId: cfg.lojaId || '',
    lojaNome: cfg.lojaNome || '',
    pdvNome: cfg.pdvNome || '',
    pareadoEm: cfg.pareadoEm || '',
    pareadoLojaId: cfg.pareadoLojaId || '',
  };
  publicarIdentidade(_identidade);
  return _identidade;
}

// Publica a identidade para o portalApi (que enxerga só o window).
function publicarIdentidade(ident) {
  if (!ident || !ident.lojaId) return;
  try {
    window.portalIdentidade = {
      lojaId: ident.lojaId,
      lojaNome: ident.lojaNome || '',
      machineId: ident.machineId || '',
      pdvNome: ident.pdvNome || '',
    };
  } catch { /* browser puro */ }
}

// Single-flight: chamadas concorrentes compartilham UMA resolução.
export function garantirIdentidade() {
  if (_identidade) return Promise.resolve(_identidade);
  if (!_identidadeProm) {
    _identidadeProm = resolverIdentidade().finally(() => { _identidadeProm = null; });
  }
  return _identidadeProm;
}

// Emparelha com o portal e, no sucesso, grava a AUTORIZAÇÃO da máquina
// (pareadoEm/pareadoLojaId) no sidecar e no electron-config.json. NÃO
// sobrescreve lojaId/lojaNome: a loja é definida no app (⚙ Config).
export async function emparelharKiosk() {
  let ident;
  try { ident = await garantirIdentidade(); } catch { return null; }
  if (!ident || !ident.kioskCode || !ident.machineId) return null; // sidecar ainda subindo
  try {
    const res = await portalApi.pair({ kioskCode: ident.kioskCode, machineId: ident.machineId });
    if (res && res.ok) {
      window.kioskPair = res;
      // Seed APENAS quando a loja ainda não está definida no app (1º boot);
      // depois disso a loja é definida no ⚙ Config e não é sobrescrita.
      const autorizado = {
        pareadoEm: new Date().toISOString(),
        pareadoLojaId: res.loja?.id || '',
        machineId: ident.machineId,
      };
      if (!ident.lojaId && res.loja?.id) autorizado.lojaId = res.loja.id;
      if (!ident.lojaNome && res.loja?.nome) autorizado.lojaNome = res.loja.nome;
      try { await natalApi.saveConfig(autorizado); } catch { /* best-effort */ }
      try { if (window.natal?.saveConfig) await window.natal.saveConfig(autorizado); } catch { /* best-effort */ }
      Object.assign(ident, autorizado);
      publicarIdentidade(ident);
    }
    return res;
  } catch {
    return null;
  }
}