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

test('valida fechamento cego, sangria e transicoes de pedido no sidecar', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-caixa-'));
  const db = path.join(tmp, 'natal-app', 'database');
  const port = 19000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  fs.mkdirSync(db, { recursive: true });

  const agora = Date.now();
  fs.writeFileSync(path.join(db, 'caixa.json'), JSON.stringify({
    id: 'CX-ABERTO1',
    operador: 'QA',
    valorInicial: 50,
    abertoEm: agora - 3600000,
    fechadoEm: null,
    pedidos: ['PED-PAGO', 'PED-CASH2', 'PED-MIX', 'PED-AGUARDANDO'],
    meios: {},
    sangrias: [],
  }, null, 2));
  fs.writeFileSync(path.join(db, 'pedidos.json'), JSON.stringify([
    {
      id: 'PED-PAGO',
      numero: 1,
      caixaId: 'CX-ABERTO1',
      total: 100,
      status: 'PAGO',
      pagamentos: [{ meio: 'dinheiro', valor: 100 }],
      criadoEm: agora - 1800000,
    },
    {
      id: 'PED-CASH2',
      numero: 2,
      caixaId: 'CX-ABERTO1',
      total: 30,
      status: 'PAGO',
      pagamentos: [{ meio: 'dinheiro', valor: 30 }],
      criadoEm: agora - 1200000,
    },
    {
      id: 'PED-MIX',
      numero: 3,
      caixaId: 'CX-ABERTO1',
      total: 100,
      status: 'PAGO',
      pagamentos: [{ meio: 'dinheiro', valor: 60 }, { meio: 'debito', valor: 40 }],
      criadoEm: agora - 1100000,
    },
    {
      id: 'PED-AGUARDANDO',
      numero: 4,
      caixaId: 'CX-ABERTO1',
      total: 10,
      status: 'AGUARDANDO',
      pagamentos: null,
      criadoEm: agora - 900000,
    },
  ], null, 2));

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
  const json = (r) => r.json();
  const post = (rota, body) => fetch(base + rota, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const put = (rota, body) => fetch(base + rota, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  assert.equal((await put('/api/pedidos/PED-PAGO', { pagamentos: [{ meio: 'debito', valor: 50 }] })).status, 400);
  assert.equal((await put('/api/pedidos/PED-PAGO', { total: -1 })).status, 400);
  assert.equal((await post('/api/pedidos/PED-AGUARDANDO/pagamento', {
    pagamentos: [{ meio: 'cheque', valor: 10 }],
  })).status, 400);

  assert.equal((await put('/api/pedidos/PED-CASH2', {
    status: 'cancelado',
    devolucao: { forma: 'dinheiro', valor: 30 },
  })).status, 200);
  const sangria = await post('/api/pdv/caixa/sangria', {
    valor: 20,
    motivo: 'Sangria manual de teste',
    por: 'QA',
  });
  assert.equal(sangria.status, 200);
  const sangriaJson = await json(sangria);
  assert.equal(sangriaJson.caixa.sangrias.length, 1);
  assert.equal(sangriaJson.caixa.sangrias[0].abatimento, 20);
  const devolucao = await post('/api/pdv/caixa/sangria', {
    valor: 30,
    motivo: 'Devolucao de venda do proprio caixa',
    pedidoId: 'PED-CASH2',
    por: 'QA',
  });
  assert.equal(devolucao.status, 200);
  const devolucaoJson = await json(devolucao);
  assert.equal(devolucaoJson.caixa.sangrias.length, 2);
  assert.equal(devolucaoJson.caixa.sangrias[1].abatimento, 0);

  assert.equal((await put('/api/pedidos/PED-MIX', {
    status: 'cancelado',
    devolucao: { forma: 'dinheiro', valor: 100 },
  })).status, 200);
  const devolucaoMista = await post('/api/pdv/caixa/sangria', {
    valor: 100,
    motivo: 'Devolucao de venda mista',
    pedidoId: 'PED-MIX',
    por: 'QA',
  });
  assert.equal(devolucaoMista.status, 200);
  const devolucaoMistaJson = await json(devolucaoMista);
  assert.equal(devolucaoMistaJson.caixa.sangrias.length, 3);
  assert.equal(devolucaoMistaJson.caixa.sangrias[2].abatimento, 40);

  assert.equal((await post('/api/pdv/caixa/fechar', {
    meios: { dinheiro: 90.02, debito: 0, credito: 0 },
    valorEnvelope: 0,
  })).status, 400);
  assert.equal((await post('/api/pdv/caixa/fechar', {
    meios: { dinheiro: 90.02, debito: -1, credito: 0, pix: 0 },
    valorEnvelope: 0,
  })).status, 400);

  const fechado = await post('/api/pdv/caixa/fechar', {
    meios: { dinheiro: 90.02, debito: 0, credito: 0, pix: 0 },
    valorEnvelope: 0,
    fechadoPor: 'QA',
  });
  assert.equal(fechado.status, 200);
  const fechadoJson = await json(fechado);
  assert.equal(fechadoJson.caixa.diferenca, 0.02);
  assert.equal(fechadoJson.caixa.diferencaAceita, false);
  assert.equal(fechadoJson.caixa.sangrias.length, 3);
  assert.equal(fechadoJson.caixa.totalPorMeio.dinheiro, 100);

  assert.equal((await post('/api/pdv/caixa/abrir', { operador: 'QA', valorInicial: 0 })).status, 200);
  assert.equal((await post('/api/pdv/caixa/fechar', {
    meios: { dinheiro: 10, debito: 0, credito: 0, pix: 0 },
    valorEnvelope: 0,
  })).status, 400);
  const autorizado = await post('/api/pdv/caixa/fechar', {
    meios: { dinheiro: 10, debito: 0, credito: 0, pix: 0 },
    valorEnvelope: 0,
    justificativa: 'Troco errado no turno',
    autorizadoPor: 'QA',
  });
  assert.equal(autorizado.status, 200);
  const autorizadoJson = await json(autorizado);
  assert.equal(autorizadoJson.caixa.diferenca, 10);
  assert.equal(autorizadoJson.caixa.diferencaAceita, true);
  assert.equal(autorizadoJson.caixa.justificativa, 'Troco errado no turno');

  const cancelado = await put('/api/pedidos/PED-PAGO', {
    status: 'cancelado',
    devolucao: { forma: 'dinheiro', valor: 100 },
  });
  assert.equal(cancelado.status, 200);
  assert.equal((await json(cancelado)).pedido.devolucao.forma, 'dinheiro');
  assert.equal((await put('/api/pedidos/PED-PAGO', { status: 'PAGO' })).status, 400);
  assert.equal((await put('/api/pedidos/PED-PAGO', { status: 'PAGO', motivo: 'Cancelamento indevido' })).status, 200);
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

test('correcao de caixa fechado tambem abre pelo login', () => {
  const html = ler('vendas.html');
  assert.match(html, /id="login-corrigir"/);
  assert.match(html, /function abrirCorrecaoPeloLogin/);
  assert.match(html, /mostrarListaConciliacoes\(true\)/);
  assert.match(html, /preAutorizado \? abrirPedidosCorrecaoCaixa/);
  assert.match(html, /Arrumar caixa fechado/);
  assert.doesNotMatch(html, /id="login-corrigir"[^>]*display:none/);
  assert.doesNotMatch(html, /btnCorrigir\.style\.display/);
});
