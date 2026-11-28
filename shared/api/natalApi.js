// ─────────────────────────────────────────────────────────────
// Adapter HTTP/SSE para o sidecar servidor (natal-core.cjs).
// O PDV fala com http://localhost:9877; o fotógrafo fala com o IP
// do PC da venda (config.serverUrl, vindo do bridge/preload).
// ─────────────────────────────────────────────────────────────
import config from '../config';

export const SIDECAR_URL = config.serverUrl;

// Sobe quando um preview já cacheado precisa ser buscado de novo (ex.: iPad com
// os previews grandes antigos em cache `immutable`). A partir daí o servidor
// manda ETag e o navegador revalida sozinho quando a migração regrava o JPEG.
const PREVIEW_CACHE_VERSION = '2';

async function api(method, path, body = null, isBinary = false) {
  const opts = { method, headers: {} };
  if (body !== null) {
    if (isBinary) {
      opts.body = body;
    } else {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }
  }
  // Sem timeout, um sidecar travado (impressão/importação/disco lento) pendurava
  // o PDV para sempre (login, caixa, fechar venda). Upload binário (foto grande)
  // ganha mais prazo que as chamadas JSON.
  const AC = (typeof globalThis !== 'undefined' && globalThis.AbortController) || null;
  const ctrl = AC ? new AC() : null;
  const timeoutMs = isBinary ? 60000 : 15000;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
  if (ctrl) opts.signal = ctrl.signal;
  try {
    const res = await fetch(`${SIDECAR_URL}${path}`, opts);
    const text = await res.text();
    if (res.status === 401) {
      try {
        if (typeof window !== 'undefined' && /^\/pdv(\/|$)/.test(String(window.location.pathname || ''))) {
          window.location.replace('/pdv/');
        }
      } catch { /* sem window */ }
      return { success: false, error: 'PAIRING_REQUIRED', pairing: true, status: 401 };
    }
    try {
      return JSON.parse(text);
    } catch {
      return { success: false, error: text || `Erro HTTP ${res.status}` };
    }
  } finally {
    clearTimeout(timer);
  }
}

const natalApi = {
  // ─── Sessões (fotógrafo cria/transfere; PDV lê) ──────────
  criarSessao: () => api('POST', '/api/sessoes'),
  listarSessoes: (opts = {}) => {
    const parts = [];
    if (opts.data) parts.push('data=' + encodeURIComponent(opts.data));
    if (opts.limite) parts.push('limite=' + encodeURIComponent(String(opts.limite)));
    if (opts.resumo) parts.push('resumo=1');
    const qs = parts.join('&');
    return api('GET', `/api/sessoes${qs ? '?' + qs : ''}`);
  },
  getSessao: (id) => api('GET', `/api/sessoes/${encodeURIComponent(id)}`),
  finalizarSessao: (id) => api('POST', `/api/sessoes/${encodeURIComponent(id)}/finalizar`),
  cancelarSessao: (id) => api('POST', `/api/sessoes/${encodeURIComponent(id)}/cancelar`),

  // Upload de arquivo (binário cru). type = 'originais' | 'preview'
  uploadFoto: (id, type, filename, blob) =>
    api('POST', `/api/sessoes/${encodeURIComponent(id)}/${type}/${encodeURIComponent(filename)}`, blob, true),

  // URLs para exibir fotos (usadas no <img>). Previews e miniaturas levam
  // `?v=`: invalida o cache antigo e, depois, o servidor revalida por ETag.
  fotoUrl: (id, type, filename) => {
    const url = `${SIDECAR_URL}/api/fotos/${type}/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`;
    return (type === 'previews' || type === 'thumbs') ? `${url}?v=${PREVIEW_CACHE_VERSION}` : url;
  },

  // ─── Pedidos (PDV) ───────────────────────────────────────
  criarPedido: (data) => api('POST', '/api/pedidos', data),
  registrarPagamento: (id, data) => api('POST', `/api/pedidos/${encodeURIComponent(id)}/pagamento`, data),
  listarPedidos: () => api('GET', '/api/pedidos'),
  getPedido: (id) => api('GET', `/api/pedidos/${encodeURIComponent(id)}`),
  // Persiste correções pós-pagamento (diferença, forma de pagamento, cancelamento)
  atualizarPedido: (id, data) => api('PUT', `/api/pedidos/${encodeURIComponent(id)}`, data),

  // ─── Caixa (PDV) ─────────────────────────────────────────
  caixaEstado: () => api('GET', '/api/pdv/caixa'),
  caixasHistorico: () => api('GET', '/api/pdv/caixas'),
  caixaAbrir: (data) => api('POST', '/api/pdv/caixa/abrir', data),
  caixaPapelInicio: (data) => api('POST', '/api/pdv/caixa/papel-inicio', data || {}),
  caixaFechar: (data) => api('POST', '/api/pdv/caixa/fechar', data),
  caixaSangria: (data) => api('POST', '/api/pdv/caixa/sangria', data),
  caixaCorrigir: (id, data) => api('PUT', `/api/pdv/caixas/${encodeURIComponent(id)}`, data),

  // ─── Auditoria (uso de senha master) ─────────────────────
  auditoriaList: () => api('GET', '/api/auditoria'),
  auditoriaSave: (usos) => api('POST', '/api/auditoria', { usos }),

  // ─── Outbox do portal (fila durável de envio) ────────────
  // O PDV enfileira tudo que precisa registrar no portal; o item só
  // sai da fila quando o portal confirma. Sobrevive a reinício/offline.
  filaPortalList: () => api('GET', '/api/portal/fila'),
  filaPortalAdd: (item) => api('POST', '/api/portal/fila', item),
  filaPortalConfirmar: (item) => api('POST', '/api/portal/fila/confirmar', item),
  filaPortalErro: (item) => api('POST', '/api/portal/fila/erro', item),
  filaPortalReativar: () => api('POST', '/api/portal/fila/reativar', {}),
  filaPortalLimpar: (senha) => api('POST', '/api/portal/fila/limpar', { senha }),

  // ─── Cache local do portal (preços, equipe, credenciais) ──
  cachePortalGet: () => api('GET', '/api/cache/portal'),
  cachePortalSave: (partial) => api('POST', '/api/cache/portal', partial),
  cachePortalConferir: (usuario, senha) => api('POST', '/api/cache/portal/conferir', { usuario, senha }),

  // ─── Envio digital (galeria pública /natal) ──────────────
  // Sobe o JPEG final (pose única, já composto) com o CÓDIGO da venda + a
  // sequência da foto. O sidecar sobe por FTP e, sem internet, guarda numa
  // fila durável que reenvia sozinha (a venda nunca falha por causa disso).
  enviarGaleria: (codigo, seq, blob) =>
    api('POST', `/api/galeria/upload/${encodeURIComponent(codigo)}/${encodeURIComponent(seq)}`, blob, true),
  finalizarGaleria: (codigo, dados) =>
    api('POST', `/api/galeria/finalizar/${encodeURIComponent(codigo)}`, dados || {}),
  galeriaFila: () => api('GET', '/api/galeria/fila'),
  sincronizarGaleria: (codigo) => api('POST', '/api/galeria/fila/sincronizar', codigo ? { codigo } : {}),

  // ─── Impressão ASK-400 (produção) ────────────────────────  // Envia o JPEG final de cada foto composta no PDV para a fila do pedido.
  uploadImpressao: (pedidoId, filename, blob) =>
    api('POST', `/api/pedidos/${encodeURIComponent(pedidoId)}/impressao/${encodeURIComponent(filename)}`, blob, true),
  // Inicia a fila de impressão de um pedido PAGO/IMPRESSO. fotos: [{ key, filename, qty }]
  // opts: { reimpressao, motivo, operador } (aceita boolean legado).
  imprimirPedido: (pedidoId, fotos, opts = {}) => {
    const o = typeof opts === 'boolean' ? { reimpressao: opts } : (opts || {});
    const body = { fotos };
    if (o.reimpressao) {
      body.reimpressao = true;
      body.motivo = o.motivo || '';
      body.operador = o.operador || '';
    }
    return api('POST', `/api/pedidos/${encodeURIComponent(pedidoId)}/imprimir`, body);
  },

  // Teste de impressão do fotógrafo (2 por loja/dia): registra no sidecar,
  // sobe o JPEG composto e enfileira na ASK-400 sem criar pedido/venda.
  testesStatus: () => api('GET', '/api/testes/status'),
  criarTeste: (data) => api('POST', '/api/testes', data),
  uploadImpressaoTeste: (testeId, filename, blob) =>
    api('POST', `/api/testes/${encodeURIComponent(testeId)}/impressao/${encodeURIComponent(filename)}`, blob, true),
  imprimirTeste: (testeId, fotos) =>
    api('POST', `/api/testes/${encodeURIComponent(testeId)}/imprimir`, { fotos }),
  baixarTestes: (ids, operador) => api('POST', '/api/testes/baixar', { ids, operador }),

  // Relatório diário de papel: cruza vendas/reimpressões/testes com as leituras
  // de início/fim do caixa e as leituras atuais da impressora.
  papelResumo: (data) => api('GET', `/api/pdv/papel/resumo${data ? `?data=${encodeURIComponent(data)}` : ''}`),

  // ─── Saúde / config ──────────────────────────────────────
  health: () => api('GET', '/api/health'),
  configPdv: () => api('GET', '/api/config'),
  pdvStatus: () => api('GET', '/api/pdv/status'),
  pdvLink: () => api('GET', '/api/pdv/link'),
  pdvRotateLink: () => api('POST', '/api/pdv/link/rotate'),
  // Cupom texto na impressora termica do PC da venda (Bematech/driver Windows).
  // No tablet nao existe Electron; o sidecar imprime pelo PC.
  imprimirThermal: (payload) => api('POST', '/api/printer/thermal', payload),
  // Status real da impressora ASK-400 (proxy do sidecar Java na 8080)
  printerStatus: () => api('GET', '/api/printer/status'),
  // Fila de impressão (lista + limpeza de 1 pedido ou de tudo)
  filaImpressao: () => api('GET', '/api/printer/fila'),
  limparFila: (opts) => api('POST', '/api/printer/fila/limpar', opts),
  // Config da máquina (salva no sidecar)
  getConfig: () => api('GET', '/api/config'),
  saveConfig: (partial) => api('POST', '/api/config', partial),
  // Importador de fotos do cartão (Pegar_Fotos headless): statusProxy (porta
  // 8099 via sidecar) + força busca no cartão agora.
  importStatus: () => api('GET', '/api/import/status'),
  importSincronizar: () => api('POST', '/api/import/sincronizar'),
  // Câmera DSLR em modo "cabo 100% direto" (digiCamControl): as fotos caem numa
  // pasta local e a sessão só nasce no "Fechar sessão".
  dslrStatus: () => api('GET', '/api/dslr/status'),
  dslrFechar: () => api('POST', '/api/dslr/fechar'),
  dslrDescartar: () => api('POST', '/api/dslr/descartar'),
  // Câmera USB (WPD/MTP): o fotógrafo escolhe quando criar a sessão.
  importCameraScan: () => api('POST', '/api/import/camera/scan'),
  importCameraCapture: () => api('POST', '/api/import/camera/capture'),
  importCameraSettings: (settings) => api('POST', '/api/import/camera/settings', settings || {}),
  // Manutenção: apaga sessões, pedidos, caixa, fila de impressão, auditoria e
  // contador de ribbon (preserva config.json → pareamento com a loja).
  // Exige { senha } no body; com caixa aberto precisa de { forcar: true }.
  limparDados: (opts) => api('POST', '/api/manutencao/limpar', opts || {}),
};

export default natalApi;
