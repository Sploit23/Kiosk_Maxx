import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sidecar = path.join(root, 'sidecar', 'natal-core.cjs');

function ipLocal() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list || []) {
      if (item.family === 'IPv4' && !item.internal) return item.address;
    }
  }
  return '';
}

function portaFree() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function esperarHealth(base, output, child) {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error('sidecar encerrou:\n' + output());
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sidecar nao subiu:\n' + output());
}

async function post(base, route, body, cookie = '') {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(base + route, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  const json = await res.json();
  if (!res.ok || !json.success) throw new Error(route + ': ' + JSON.stringify(json));
  return json;
}

async function criarPedido(base, sessaoId, cookie = '') {
  return post(base, '/api/pedidos', {
    sessaoId,
    sessoes: [{ id: sessaoId }],
    itens: [],
    produtos: [],
    total: 1,
    pagamentos: [{ meio: 'dinheiro', valor: 1 }],
    operador: 'Teste',
  }, cookie);
}

async function encerrar(child) {
  if (child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
}

test('pedido identifica caixa no loopback e tablet pela LAN', async (t) => {
  const ip = ipLocal();
  if (!ip) return t.skip('sem IP LAN para simular o tablet');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-origem-'));
  const fotos = path.join(temp, 'fotos');
  fs.mkdirSync(fotos, { recursive: true });
  const port = await portaFree();
  const base = `http://127.0.0.1:${port}`;
  const lanBase = `http://${ip}:${port}`;

  let output = '';
  const child = spawn(process.execPath, [sidecar], {
    env: {
      ...process.env,
      NATAL_PORT: String(port),
      NATAL_HOST: '0.0.0.0',
      NATAL_DATA_DIR: temp,
      NATAL_PHOTOS_FOLDER: fotos,
      NATAL_WEB_DIR: path.join(root, 'dist'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  try {
    await esperarHealth(base, () => output, child);
    await post(base, '/api/pdv/caixa/abrir', { operador: 'Teste', valorInicial: 0 });

    const sessaoCaixa = await post(base, '/api/sessoes', {});
    const pedidoCaixa = await criarPedido(base, sessaoCaixa.sessao.id);
    assert.equal(pedidoCaixa.pedido.origemTerminal, 'caixa');
    assert.ok(pedidoCaixa.pedido.caixaId);

    await esperarHealth(lanBase, () => output, child);
    const linkRes = await fetch(base + '/api/pdv/link', { signal: AbortSignal.timeout(5000) });
    const link = await linkRes.json();
    assert.ok(link.success, JSON.stringify(link));
    const token = new URL(link.url).searchParams.get('pair');
    assert.ok(token);

    const sessaoTablet = await post(base, '/api/sessoes', {});
    const pedidoTablet = await criarPedido(lanBase, sessaoTablet.sessao.id, 'natal_pdv=' + token);
    assert.equal(pedidoTablet.pedido.origemTerminal, 'tablet');
    assert.equal(pedidoTablet.pedido.caixaId, pedidoCaixa.pedido.caixaId);
  } finally {
    await encerrar(child);
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
