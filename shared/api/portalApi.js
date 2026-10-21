// ─────────────────────────────────────────────────────────────
// Adapter HTTP para o backend de cadastro (portal de gestão).
// Faz login e lista a equipe da loja. Se FALHAR a comunicação,
// retorna { ok:false, offline:true } para o app cair no fallback local.
// ─────────────────────────────────────────────────────────────
import config from '../config';

export const PORTAL_URL = config.portalApiUrl;
export const LOJA_ID = config.lojaId;

async function post(action, data = {}) {
  let res;
  const ctrl = typeof window !== 'undefined' && window.AbortController ? new window.AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), 8000) : null; // portal fora do ar/slowhead → fallback offline rápido
  try {
    res = await fetch(`${PORTAL_URL}?action=${encodeURIComponent(action)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, action }),
      signal: ctrl ? ctrl.signal : undefined,
    });
  } catch {
    return { ok: false, offline: true };
  } finally {
    if (timer) clearTimeout(timer);
  }
  const text = await res.text();
  try {
    const json = JSON.parse(text);
    return json.ok === false && res.status >= 400 ? { ...json, offline: false } : json;
  } catch {
    return { ok: false, offline: false, error: `HTTP ${res.status}` };
  }
}

const portalApi = {
  // Emparelha este kiosk com a loja no portal. O kiosk envia o código que
  // aparece na tela dele (gerado e persistido localmente — zero config
  // manual); o portal devolve a loja canônica. Depois de pairar, login/equipe
  // passam a usar o lojaId devolvido (window.kioskPair) automaticamente.
  pair({ kioskCode = '', machineId = '' } = {}) {
    return post('kiosk.pair', {
      kioskCode,
      pairingCode: config.pairingCode || '', // legado (código gerado no admin)
      lojaId: config.lojaId,                 // legado
      pdvNome: config.pdvNome || '',
      machineId,
    });
  },

  // Identidade ativa (offline-first): a LOJA é a DEFINIDA NO APP (persistida
  // no sidecar / electron-config) e a MÁQUINA é a pareada. O portal só
  // autoriza a máquina — ele não devolve mais a identidade da loja.
  // Cai no par do portal (memória) e por fim no default da config.
  identidadeAtiva() {
    try {
      const i = window && window.portalIdentidade;
      if (i && i.lojaId) return i;
    } catch { /* browser puro */ }
    try {
      const p = window && window.kioskPair;
      if (p && p.ok && p.loja) {
        return {
          lojaId: p.loja.id,
          lojaNome: p.loja.nome || '',
          machineId: (p.pareamento && p.pareamento.machineId) || '',
          pdvNome: (p.pareamento && p.pareamento.pdvNome) || '',
        };
      }
    } catch { /* browser puro */ }
    return { lojaId: LOJA_ID, lojaNome: '', machineId: '', pdvNome: config.pdvNome || '' };
  },

  // Loja canônica: a definida no app (emparelhada ou configurada).
  lojaIdAtivo() {
    return portalApi.identidadeAtiva().lojaId;
  },

  // Máquina que o portal autorizou (vai em todo push).
  machineIdAtivo() {
    return portalApi.identidadeAtiva().machineId;
  },

  // Valida credenciais do operador na loja (emparelhada ou configurada).
  login(usuario, senha) {
    return post('login', { lojaId: portalApi.lojaIdAtivo(), usuario, senha });
  },

  // Lista a equipe ativa da loja (vendedores/fotógrafos).
  equipe() {
    return post('equipe', { lojaId: portalApi.lojaIdAtivo() });
  },

  // Preços do catálogo da loja (fonte de verdade no portal). Chaves:
  // formatos (10x15, 15x20, bolinha, polaroide), extras (porta-retrato-*,
  // ima, item-encarte, porta-cartao-postal) e combos (combo1..combo6).
  precos() {
    return post('precos', { lojaId: portalApi.lojaIdAtivo() });
  },

  // Sobe o snapshot diário de vendas da loja (vendas.push). O portal só aceita
  // de máquina PAREADA com a loja (machineId do pareamento). Depois de
  // emparelhado, o PDV envia a cada evento de venda/fechamento de caixa e em
  // intervalos regulares — aqui é o resumo-agregado, não pedido a pedido.
  vendasPush(snap = {}) {
    const ident = portalApi.identidadeAtiva();
    return post('vendas.push', {
      lojaId: ident.lojaId,
      lojaNome: ident.lojaNome,
      machineId: ident.machineId,
      ...snap,
    });
  },

  // Sobe um pedido por completo (pedido.push). Idempotente pelo id do pedido:
  // reenvio só sobrescreve. O portal só aceita da máquina pareada com a loja.
  pedidoPush(pedido = {}) {
    const ident = portalApi.identidadeAtiva();
    return post('pedido.push', {
      lojaId: ident.lojaId,
      lojaNome: ident.lojaNome,
      machineId: ident.machineId,
      pedido,
    });
  },

  // Sobe um uso de senha master (auditoria.push). Idempotente pelo id.
  auditoriaPush(uso = {}) {
    const ident = portalApi.identidadeAtiva();
    return post('auditoria.push', {
      lojaId: ident.lojaId,
      lojaNome: ident.lojaNome,
      machineId: ident.machineId,
      uso,
    });
  },
};

export default portalApi;