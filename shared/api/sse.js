// ─────────────────────────────────────────────────────────────
// Conexão SSE com o sidecar servidor — múltiplos listeners
// simultâneos com retry/backoff. Portado fielmente do kiosk-app
// (src/kiosk-api.js connectSSE). Antes era single-listener (a cada
// connectSSE fechava a conexão anterior); agora qualquer módulo
// registra seu listener no mesmo EventSource.
// ─────────────────────────────────────────────────────────────
import { SIDECAR_URL } from './natalApi';

/* global EventSource */

let _sseSource = null;
let _sseReconnectTimer = null;
let _sseConsecutiveErrors = 0;
const _sseListeners = new Set();
const _sseStatusCallbacks = new Set();
const SSE_MAX_BACKOFF = 10000;
const SSE_DEAD_THRESHOLD = 5;

const safeParse = (e) => { try { return JSON.parse(e.data); } catch { return null; } };

function _dispatch(event, data) {
  for (const fn of _sseListeners) {
    try { fn(event, data); } catch { /* listener isolado */ }
  }
}

function _openSse() {
  if (_sseSource) return; // já conectado
  if (_sseReconnectTimer) { clearTimeout(_sseReconnectTimer); _sseReconnectTimer = null; }
  _sseSource = new EventSource(`${SIDECAR_URL}/api/events`);
  _sseSource.onmessage = () => {};

  const subscribe = (event) => {
    _sseSource.addEventListener(event, (e) => {
      const d = safeParse(e);
      _dispatch(event, d !== null ? d : e.data);
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
  subscribe('print-start');
  subscribe('printer:progress');
  subscribe('print-complete');

  _sseSource.onopen = () => {
    if (_sseConsecutiveErrors > 0) console.log('[SSE] Reconectado.');
    _sseConsecutiveErrors = 0;
    for (const cb of _sseStatusCallbacks) { try { cb('alive'); } catch { /* noop */ } }
  };

  _sseSource.onerror = () => {
    try { _sseSource.close(); } catch { /* silencioso */ }
    _sseSource = null;
    _sseConsecutiveErrors++;
    if (_sseConsecutiveErrors >= SSE_DEAD_THRESHOLD) {
      console.warn('[SSE] Sidecar morto detectado.');
      for (const cb of _sseStatusCallbacks) { try { cb('dead'); } catch { /* noop */ } }
    }
    const delay = Math.min(1000 * 2 ** (_sseConsecutiveErrors - 1), SSE_MAX_BACKOFF);
    console.log(`[SSE] Reconectando em ${delay}ms (tentativa ${_sseConsecutiveErrors})...`);
    _sseReconnectTimer = setTimeout(_openSse, delay);
  };
}

export function connectSSE(onEvent, onStatus) {
  if (typeof onEvent === 'function') _sseListeners.add(onEvent);
  if (typeof onStatus === 'function') _sseStatusCallbacks.add(onStatus);
  _openSse();
  return () => {
    _sseListeners.delete(onEvent);
    if (onStatus) _sseStatusCallbacks.delete(onStatus);
  };
}