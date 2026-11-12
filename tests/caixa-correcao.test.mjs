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

async function parar(child) {
  if (!child || child.exitCode !== null) return;
  try { child.stdin.end(); } catch {}
  child.kill();
  await Promise.race([
    once(child, 'exit'),
    new Promise((r) => setTimeout(r, 1500)),
  ]);
  if (child.exitCode === null) {
    try { child.kill('SIGKILL'); } catch {}
    await Promise.race([
      once(child, 'exit'),
      new Promise((r) => setTimeout(r, 1000)),
    ]);
  }
}

async function esperarHealth(base, logs) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('sidecar nao subiu\n' + logs());
}

test('corrige fechamento de caixa e recalcula os totais no sidecar', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-caixa-'));
  const db = path.join(tmp, 'natal-app', 'database');
  const port = 19000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  fs.mkdirSync(db, { recursive: true });

  const agora = Date.now();
  fs.writeFileSync(path.join(db, 'caixas.json'), JSON.stringify([{
    id: 'CX-TESTE1',
    numero: 1,
    operador: 'QA',
    valorInicial: 200,
    abertoEm: agora - 3600000,
    fechadoEm: agora - 1800000,
    fechadoPor: 'QA',
    pedidos: ['PED-TESTE1'],
    totalVendido: 0,
    totalPorMeio: {},
    meiosDeclarados: { dinheiro: 200, debito: 0, credito: 0, pix: 0 },
    totalRecebido: 200,
    diferenca: -81,
    valorEnvelope: 0,
    saldoRestante: 200,
  }], null, 2));
  fs.writeFileSync(path.join(db, 'pedidos.json'), JSON.stringify([{
    id: 'PED-TESTE1',
    numero: 1,
    caixaId: 'CX-TESTE1',
    total: 81,
    status: 'PAGO',
    pagamentos: [
      { meio: 'dinheiro', valor: 30 },
      { meio: 'credito', valor: 51 },
    ],
  }], null, 2));

  let logs = '';
  const child = spawn(process.execPath, ['sidecar/natal-core.cjs'], {
    cwd: root,
    env: {
      ...process.env,
      NATAL_PORT: String(port),
      NATAL_HOST: '127.0.0.1',
      NATAL_PHOTOS_FOLDER: tmp,
      NATAL_DATA_DIR: path.join(tmp, 'legacy'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  t.after(async () => {
    await parar(child);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  await esperarHealth(base, () => logs);
  const pagamento = await fetch(base + '/api/pedidos/PED-TESTE1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pagamentos: [{ meio: 'credito', valor: 81 }] }),
  });
  assert.equal(pagamento.status, 200);
  const pagamentoJson = await pagamento.json();
  assert.equal(pagamentoJson.pedido.meio, 'credito');

  const res = await fetch(base + '/api/pdv/caixas/CX-TESTE1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      meios: { dinheiro: 200, debito: 0, credito: 81, pix: 0 },
      valorEnvelope: 0,
      saldoRestante: 200,
      motivo: 'Teste de correcao do fechamento',
      corrigidoPor: 'QA',
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.success, true);
  assert.equal(json.caixa.totalVendido, 81);
  assert.equal(json.caixa.totalPorMeio.dinheiro, undefined);
  assert.equal(json.caixa.totalPorMeio.credito, 81);
  assert.equal(json.caixa.totalRecebido, 281);
  assert.equal(json.caixa.diferenca, 0);
  assert.equal(json.caixa.saldoRestante, 200);
  assert.equal(json.caixa.corrigidoPor, 'QA');
  assert.equal(json.caixa.correcoes.length, 1);

  const invalido = await fetch(base + '/api/pdv/caixas/CX-TESTE1', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ meios: { dinheiro: 200 }, valorEnvelope: 25, motivo: 'x' }),
  });
  assert.equal(invalido.status, 400);

  const salvo = JSON.parse(fs.readFileSync(path.join(db, 'caixas.json'), 'utf8'));
  assert.equal(salvo[0].diferenca, 0);
  assert.equal(salvo[0].correcoes.length, 1);
});

test('historico de caixa expoe o botao Corrigir e a API de correcao', () => {
  const html = ler('vendas.html');
  assert.match(html, /data-corrigir/);
  assert.match(html, /function abrirPedidosCorrecaoCaixa/);
  assert.match(html, /Ir para Correção de fechamento/);
  assert.match(html, /function salvarCorrecaoPagamentoPedido/);
  assert.match(html, /function abrirFormularioCorrecaoCaixa/);
  assert.match(html, /Salvar correção e refechar caixa/);
  assert.match(ler('shared', 'api', 'natalApi.js'), /caixaCorrigir/);
  assert.match(ler('sidecar', 'natal-core.cjs'), /caixaCorrigirGet/);
});
