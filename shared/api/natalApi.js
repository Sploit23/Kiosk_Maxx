// ─────────────────────────────────────────────────────────────
// Adapter HTTP/SSE para o sidecar servidor (natal-core.cjs).
// O PDV fala com http://localhost:9877; o fotógrafo fala com o IP
// do PC da venda (config.serverUrl, vindo do bridge/preload).
// ─────────────────────────────────────────────────────────────
import config from '../config';

export const SIDECAR_URL = config.serverUrl;

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
  const res = await fetch(`${SIDECAR_URL}${path}`, opts);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { success: false, error: text || `Erro HTTP ${res.status}` };
  }
}

const natalApi = {
  // ─── Sessões (fotógrafo cria/transfere; PDV lê) ──────────
  criarSessao: () => api('POST', '/api/sessoes'),
  listarSessoes: () => api('GET', '/api/sessoes'),
  getSessao: (id) => api('GET', `/api/sessoes/${encodeURIComponent(id)}`),
  finalizarSessao: (id) => api('POST', `/api/sessoes/${encodeURIComponent(id)}/finalizar`),
  cancelarSessao: (id) => api('POST', `/api/sessoes/${encodeURIComponent(id)}/cancelar`),

  // Upload de arquivo (binário cru). type = 'originais' | 'preview'
  uploadFoto: (id, type, filename, blob) =>
    api('POST', `/api/sessoes/${encodeURIComponent(id)}/${type}/${encodeURIComponent(filename)}`, blob, true),

  // URLs para exibir fotos (usadas no <img>)
  fotoUrl: (id, type, filename) =>
    `${SIDECAR_URL}/api/fotos/${type}/${encodeURIComponent(id)}/${encodeURIComponent(filename)}`,

  // ─── Pedidos (PDV) ───────────────────────────────────────
  criarPedido: (data) => api('POST', '/api/pedidos', data),
  registrarPagamento: (id, data) => api('POST', `/api/pedidos/${encodeURIComponent(id)}/pagamento`, data),
  listarPedidos: () => api('GET', '/api/pedidos'),
  getPedido: (id) => api('GET', `/api/pedidos/${encodeURIComponent(id)}`),

  // ─── Caixa (PDV) ─────────────────────────────────────────
  caixaEstado: () => api('GET', '/api/pdv/caixa'),
  caixasHistorico: () => api('GET', '/api/pdv/caixas'),
  caixaAbrir: (data) => api('POST', '/api/pdv/caixa/abrir', data),
  caixaFechar: (data) => api('POST', '/api/pdv/caixa/fechar', data),

  // ─── Auditoria (uso de senha master) ─────────────────────
  auditoriaList: () => api('GET', '/api/auditoria'),
  auditoriaSave: (usos) => api('POST', '/api/auditoria', { usos }),

  // ─── Impressão ASK-400 (produção) ────────────────────────
  // Envia o JPEG final de cada foto composta no PDV para a fila do pedido.
  uploadImpressao: (pedidoId, filename, blob) =>
    api('POST', `/api/pedidos/${encodeURIComponent(pedidoId)}/impressao/${encodeURIComponent(filename)}`, blob, true),
  // Inicia a fila de impressão de um pedido PAGO. fotos: [{ key, filename, qty }]
  imprimirPedido: (pedidoId, fotos) => api('POST', `/api/pedidos/${encodeURIComponent(pedidoId)}/imprimir`, { fotos }),

  // ─── Saúde / config ──────────────────────────────────────
  health: () => api('GET', '/api/health'),
  configPdv: () => api('GET', '/api/config'),
  // Status real da impressora ASK-400 (proxy do sidecar Java na 8080)
  printerStatus: () => api('GET', '/api/printer/status'),
  // Config da máquina (salva no sidecar)
  getConfig: () => api('GET', '/api/config'),
  saveConfig: (partial) => api('POST', '/api/config', partial),
};

export default natalApi;
