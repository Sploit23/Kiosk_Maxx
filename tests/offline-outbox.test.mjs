import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (...partes) => fs.readFileSync(path.join(root, ...partes), 'utf8');

async function subirSidecar(pasta) {
  const porta = 22000 + Math.floor(Math.random() * 1000);
  let logs = '';
  const child = spawn(process.execPath, ['sidecar/natal-core.cjs'], {
    cwd: root,
    env: {
      ...process.env,
      NATAL_PORT: String(porta),
      NATAL_HOST: '127.0.0.1',
      NATAL_PHOTOS_FOLDER: pasta,
      NATAL_DATA_DIR: path.join(pasta, 'natal-app'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
      if (res.ok) return { child, base };
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error('sidecar nao subiu\n' + logs);
}

async function parar(child) {
  if (!child || child.exitCode !== null) return;
  try { child.stdin.end(); } catch {}
  child.kill();
  await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 1500))]);
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 1000))]);
  }
}

test('offline nao gasta tentativas da fila e reconexao reativa itens travados', () => {
  const sidecar = ler('sidecar', 'natal-core.cjs');
  assert.match(sidecar, /function erroPortal\(\{ id, erro, offline = false \}/);
  assert.match(sidecar, /if \(offline\) \{\s*item\.tentativas = 0/);
  assert.match(sidecar, /function reativarFilaPortal/);
  assert.match(sidecar, /\/api\/portal\/fila\/reativar/);
  const api = ler('shared', 'api', 'natalApi.js');
  assert.match(api, /filaPortalReativar:/);
  const html = ler('vendas.html');
  assert.match(html, /offline: semRede/);
  assert.match(html, /natalApi\.filaPortalReativar\(\)/);
  assert.match(html, /addEventListener\('online'/);
  assert.match(html, /carregarPrecosPortal\(\)\.catch/);
  assert.match(html, /sincronizarComPortal\(\)\.catch/);
});

test('fila sobrevive a 6 falhas de rede e volta a tentar apos reativar', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-outbox-'));
  const { child, base } = await subirSidecar(tmp);
  const post = async (rota, body) => {
    const res = await fetch(base + rota, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };
  const listar = async () => (await (await fetch(base + '/api/portal/fila')).json()).itens;
  try {
    for (let i = 1; i <= 6; i++) {
      const r = await post('/api/portal/fila', { tipo: 'pedido', chave: 'PED-' + i, payload: { id: 'PED-' + i, total: i } });
      assert.equal(r.status, 200);
      assert.equal(r.json.criado, true);
    }
    assert.equal((await listar()).length, 6);

    const id = (await listar())[0].id;
    for (let i = 0; i < 6; i++) {
      const r = await post('/api/portal/fila/erro', { id, erro: 'fetch falhou', offline: true });
      assert.equal(r.status, 200);
      assert.equal(r.json.tentativas, 0);
    }
    for (let i = 1; i <= 5; i++) {
      const r = await post('/api/portal/fila/erro', { id, erro: 'ACAO_DESCONHECIDA' });
      assert.equal(r.json.tentativas, i);
    }
    let itens = await listar();
    assert.equal(itens.find((i) => i.id === id).tentativas, 5);

    const reativar = await post('/api/portal/fila/reativar', {});
    assert.equal(reativar.status, 200);
    assert.equal(reativar.json.reativados, 1);
    itens = await listar();
    assert.equal(itens.find((i) => i.id === id).tentativas, 0);
    assert.equal(itens.length, 6);
  } finally {
    await parar(child);
  }
});
