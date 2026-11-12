import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = process.env.NATAL_API_BASE || 'http://127.0.0.1:9877';

async function pedir(caminho) {
  const res = await fetch(BASE + caminho, { signal: AbortSignal.timeout(3000) });
  return res;
}

test('sidecar responde /api/health', async (t) => {
  let res;
  try {
    res = await pedir('/api/health');
  } catch (e) {
    return t.skip('sidecar offline: ' + e.message);
  }
  assert.ok(res.ok, 'HTTP ' + res.status);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.ok(json.build);
});

test('sidecar entrega config e fila de impressao', async (t) => {
  let config;
  let fila;
  try {
    config = await pedir('/api/config');
    fila = await pedir('/api/printer/fila');
  } catch (e) {
    return t.skip('sidecar offline: ' + e.message);
  }
  assert.ok(config.ok, 'config HTTP ' + config.status);
  assert.equal(typeof await config.json(), 'object');
  assert.ok(fila.ok, 'fila HTTP ' + fila.status);
  const jsonFila = await fila.json();
  assert.equal(jsonFila.success, true);
  assert.ok(Array.isArray(jsonFila.fila));
});
