// ─────────────────────────────────────────────────────────────
// Conexão SSE com o sidecar servidor — eventos de sessão, pedido e caixa.
// Portado do kiosk-app (src/kiosk-api.js connectSSE).
// ─────────────────────────────────────────────────────────────
import { SIDECAR_URL } from './natalApi';

/* global EventSource */

let _sseSource = null;
let _sseReconnectTimer = null;
let _sseConsecutiveErrors = 0;
const SSE_MAX_BACKOFF = 10000;
const SSE_DEAD_THRESHOLD = 5;

export function connectSSE(onEvent, onStatus) {
  const statusCb = onStatus || null;
  if (_sseReconnectTimer) {
    clearTimeout(_sseReconnectTimer);
    _sseReconnectTimer = null;
  }
  if (_sseSource) {
    try { _sseSource.close(); } catch { /* silencioso */ }
  }

  _sseSource = new EventSource(`${SIDECAR_URL}/api/events`);
  _sseSource.onmessage = () => {};

  const safeParse = (e) => { try { return JSON.parse(e.data); } catch { return null; } };
  const subscribe = (event, key) => {
    _sseSource.addEventListener(event, (e) => {
      const d = safeParse(e);
      if (d) onEvent(key || event, d);
    });
  };

  subscribe('sessao:criada');
  subscribe('sessao:status');
  subscribe('sessao:concluida');
  subscribe('pedido:criado');
  subscribe('pedido:pago');
  subscribe('pedido:impresso');
  subscribe('caixa:aberto');
  subscribe('caixa:fechado');
  subscribe('printer:progress');
  subscribe('print-complete');

  _sseSource.onopen = () => {
    _sseConsecutiveErrors = 0;
    if (statusCb) statusCb('alive');
  };

  _sseSource.onerror = () => {
    try { _sseSource.close(); } catch { /* silencioso */ }
    _sseConsecutiveErrors++;
    if (_sseConsecutiveErrors >= SSE_DEAD_THRESHOLD && statusCb) statusCb('dead');
    const delay = Math.min(1000 * 2 ** (_sseConsecutiveErrors - 1), SSE_MAX_BACKOFF);
    _sseReconnectTimer = setTimeout(() => connectSSE(onEvent, onStatus), delay);
  };
}
