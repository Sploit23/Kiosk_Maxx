import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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

function dataLocal(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

test('relatorio de papel cruza impressoes, testes pendentes e leituras do caixa', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-papel-'));
  const db = path.join(tmp, 'natal-app', 'database');
  const port = 19000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  fs.mkdirSync(db, { recursive: true });

  const inicioDia = new Date();
  inicioDia.setHours(0, 0, 0, 0);
  const marco = inicioDia.getTime() + 1000;
  const hoje = dataLocal(marco);
  const abertoEm = marco;
  const pagoEm = marco + 5 * 60000;
  const impressoEm = marco + 10 * 60000;
  const testeEm = marco + 15 * 60000;
  fs.writeFileSync(path.join(db, 'config.json'), JSON.stringify({
    lojaId: 'L1', lojaNome: 'Loja Teste', pdvNome: 'PDV 1',
  }));
  fs.writeFileSync(path.join(db, 'caixa.json'), JSON.stringify({
    id: 'CX-PAPEL1', operador: 'QA', valorInicial: 10,
    abertoEm, fechadoEm: null,
    pedidos: ['PED-PAPEL1'], sangrias: [],
    papelInicio: { '10x15': 100, '15x20': 50 },
  }));
  fs.writeFileSync(path.join(db, 'pedidos.json'), JSON.stringify([{
    id: 'PED-PAPEL1', numero: 1, caixaId: 'CX-PAPEL1', status: 'PAGO',
    total: 90, pagoEm,
    pagamentos: [{ meio: 'dinheiro', valor: 90 }],
    fotos10x15: 3, fotos15x20: 1,
  }]));
  const evento = (tipo, f10, f15, extra = {}) => ({
    id: `IMP-${tipo}-${f10}-${f15}`, tipo, em: impressoEm, data: hoje,
    lojaId: 'L1', fotos10x15: f10, fotos15x20: f15,
    unidadesRibbon: f10 + f15 * 2, ...extra,
  });
  fs.writeFileSync(path.join(db, 'impressoes.json'), JSON.stringify([
    evento('venda', 3, 1),
    evento('reimpressao', 1, 0, { motivo: 'Foto tremidas' }),
    evento('teste', 1, 0),
  ]));
  fs.writeFileSync(path.join(db, 'testes.json'), JSON.stringify([{
    id: 'TST-1', data: hoje, lojaId: 'L1', status: 'IMPRESSO',
    sessaoSenha: '1234', label: '10x15', operador: 'QA',
    impressoEm: testeEm,
  }]));

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
  const post = (rota, body) => fetch(base + rota, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const antes = await (await fetch(base + `/api/pdv/papel/resumo?data=${hoje}`)).json();
  assert.equal(antes.success, true);
  assert.equal(antes.vendas.fotos10x15, 3);
  assert.equal(antes.vendas.fotos15x20, 1);
  assert.equal(antes.reimpressoes.fotos10x15, 1);
  assert.equal(antes.testes.fotos10x15, 1);
  assert.equal(antes.testes.pendentes, 1);
  assert.equal(antes.esperado['10x15'], 5);
  assert.equal(antes.status, 'SEM_LEITURA');
  assert.equal(antes.motivosReimpressao[0].motivo, 'Foto tremidas');

  const bloqueado = await post('/api/pdv/caixa/fechar', {
    meios: { dinheiro: 100, debito: 0, credito: 0, pix: 0 },
    valorEnvelope: 0,
    papelFim: { '10x15': 94, '15x20': 49 },
  });
  assert.equal(bloqueado.status, 409);
  const bloqueadoJson = await bloqueado.json();
  assert.equal(bloqueadoJson.codigo, 'TESTES_PENDENTES');
  assert.equal(bloqueadoJson.pendentes, 1);

  const baixa = await post('/api/testes/baixar', { ids: ['TST-1'], operador: 'QA' });
  assert.equal(baixa.status, 200);
  const baixaJson = await baixa.json();
  assert.equal(baixaJson.atualizados, 1);
  assert.equal(baixaJson.pendentes, 0);

  const fechado = await post('/api/pdv/caixa/fechar', {
    meios: { dinheiro: 100, debito: 0, credito: 0, pix: 0 },
    valorEnvelope: 0,
    papelFim: { '10x15': 94, '15x20': 49 },
  });
  assert.equal(fechado.status, 200);
  const fechadoJson = await fechado.json();
  assert.deepEqual(fechadoJson.caixa.papelFim, { '10x15': 94, '15x20': 49 });
  assert.equal(fechadoJson.papelRelatorio.status, 'OK');
  assert.equal(fechadoJson.papelRelatorio.consumo['10x15'], 6);
  assert.equal(fechadoJson.papelRelatorio.divergencia['10x15'], 1);
  assert.equal(fechadoJson.papelRelatorio.testes.pendentes, 0);

  const depois = await (await fetch(base + `/api/pdv/papel/resumo?data=${hoje}`)).json();
  assert.deepEqual(depois.inicio, { '10x15': 100, '15x20': 50 });
  assert.deepEqual(depois.fim, { '10x15': 94, '15x20': 49 });
  assert.equal(depois.consumo['15x20'], 1);
  assert.equal(depois.status, 'OK');
});

test('abertura sem papel e completada na primeira venda sem sobrescrever a leitura', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-papel-inicio-'));
  const db = path.join(tmp, 'natal-app', 'database');
  const port = 19000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  fs.mkdirSync(db, { recursive: true });
  fs.writeFileSync(path.join(db, 'config.json'), JSON.stringify({
    lojaId: 'L1', lojaNome: 'Loja Teste', pdvNome: 'PDV 1',
  }));

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
  const post = (rota, body) => fetch(base + rota, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  const aberto = await post('/api/pdv/caixa/abrir', { operador: 'QA', valorInicial: 0 });
  assert.equal(aberto.status, 200);
  const abertoJson = await aberto.json();
  assert.equal(abertoJson.caixa.papelInicio, null);

  const primeira = await post('/api/pdv/caixa/papel-inicio', {
    papelInicio: { '10x15': 100, '15x20': 50 },
  });
  assert.equal(primeira.status, 200);
  const primeiraJson = await primeira.json();
  assert.equal(primeiraJson.salvo, true);
  assert.deepEqual(primeiraJson.caixa.papelInicio, { '10x15': 100, '15x20': 50 });

  const segunda = await post('/api/pdv/caixa/papel-inicio', {
    papelInicio: { '10x15': 80, '15x20': 40 },
  });
  assert.equal(segunda.status, 200);
  const segundaJson = await segunda.json();
  assert.equal(segundaJson.salvo, false);
  assert.deepEqual(segundaJson.caixa.papelInicio, { '10x15': 100, '15x20': 50 });
});
