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

function extrairFuncao(html, nome) {
  let inicio = html.indexOf('function ' + nome + '(');
  if (inicio < 0) throw new Error('funcao nao encontrada: ' + nome);
  let i = html.indexOf('(', inicio);
  let parenteses = 0;
  for (; i < html.length; i++) {
    if (html[i] === '(') parenteses++;
    else if (html[i] === ')') {
      parenteses--;
      if (parenteses === 0) { i++; break; }
    }
  }
  while (i < html.length && html[i] !== '{') i++;
  let profundidade = 0;
  for (; i < html.length; i++) {
    if (html[i] === '{') profundidade++;
    else if (html[i] === '}') {
      profundidade--;
      if (profundidade === 0) return html.slice(inicio, i + 1);
    }
  }
  throw new Error('fim da funcao nao encontrado: ' + nome);
}

function montarPedidoPortalComCaixaAberto() {
  const fonte = extrairFuncao(ler('vendas.html'), 'montarPedidoPortal');
  return new Function(
    'identidadeSync', 'meioInfoDeForma', 'TIPOS_DESCONTO_CARRINHO', 'unidadesRibbonItem',
    'modeloImpressaoItem', 'descontoTotalPedido', 'resumoUnidadesPedido', 'isoDataLocal',
    'caixaReal', 'caixaAberto',
    fonte + '\nreturn montarPedidoPortal;'
  )(
    () => ({ pdvNome: 'PDV Teste' }),
    (forma) => ({ meio: String(forma || 'dinheiro').toLowerCase() }),
    new Set(),
    () => 1,
    () => '10x15',
    () => 0,
    () => ({ fotos10x15: 0, fotos15x20: 0, unidadesRibbon: 0 }),
    (d) => new Date(d).toISOString().slice(0, 10),
    { id: 'CX-HOJE' },
    true
  );
}

function pedidoBase(extra = {}) {
  return {
    id: 'PED-1',
    numero: 1,
    total: 10,
    status: 'pago',
    horario: new Date('2026-11-14T12:00:00'),
    pagoEm: null,
    itens: [],
    pagamentosEfetivos: [],
    sessoes: [],
    desconto: null,
    guiaImpressa: false,
    codigoDigital: null,
    ...extra,
  };
}

test('pedido reenviado mantem o caixa de origem, nunca o caixa aberto agora', () => {
  const montar = montarPedidoPortalComCaixaAberto();

  const deOntem = montar(pedidoBase({ caixaId: 'CX-ONTEM' }));
  assert.equal(deOntem.caixaId, 'CX-ONTEM');

  const legadoSemCaixa = montar(pedidoBase({ caixaId: null }));
  assert.equal(legadoSemCaixa.caixaId, '');
  assert.notEqual(legadoSemCaixa.caixaId, 'CX-HOJE');
});

test('escopo do caixa usa caixaId e so cai na janela de tempo para pedido legado', () => {
  const fonte = extrairFuncao(ler('vendas.html'), 'pedidoPertenceCaixaAtual');
  const pertence = new Function(fonte + '\nreturn pedidoPertenceCaixaAtual;')();
  const caixaHoje = { id: 'CX-HOJE' };
  const desde = +new Date('2026-11-15T00:00:00');

  const ontemNoCaixaDeOntem = pedidoBase({
    caixaId: 'CX-ONTEM', horario: new Date('2026-11-15T10:00:00'),
  });
  assert.equal(pertence(ontemNoCaixaDeOntem, caixaHoje, desde), false);

  const hojeNoCaixaDeHoje = pedidoBase({
    caixaId: 'CX-HOJE', horario: new Date('2026-11-15T10:00:00'),
  });
  assert.equal(pertence(hojeNoCaixaDeHoje, caixaHoje, desde), true);

  const legadoDentroDaJanela = pedidoBase({
    caixaId: null, horario: new Date('2026-11-15T10:00:00'),
  });
  assert.equal(pertence(legadoDentroDaJanela, caixaHoje, desde), true);

  const legadoForaDaJanela = pedidoBase({
    caixaId: null, horario: new Date('2026-11-14T10:00:00'),
  });
  assert.equal(pertence(legadoForaDaJanela, caixaHoje, desde), false);

  const cancelado = pedidoBase({
    caixaId: 'CX-HOJE', status: 'cancelado', horario: new Date('2026-11-15T10:00:00'),
  });
  assert.equal(pertence(cancelado, caixaHoje, desde), false);
});

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

test('corrigir pagamento de pedido de ontem nao mexe no caixa aberto de hoje', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-caixa-escopo-'));
  const db = path.join(tmp, 'natal-app', 'database');
  const port = 20000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  fs.mkdirSync(db, { recursive: true });

  const agora = Date.now();
  const ontem = agora - 24 * 3600000;
  fs.writeFileSync(path.join(db, 'caixas.json'), JSON.stringify([{
    id: 'CX-ONTEM',
    numero: 1,
    operador: 'QA',
    valorInicial: 100,
    abertoEm: ontem - 3600000,
    fechadoEm: ontem,
    fechadoPor: 'QA',
    pedidos: ['PED-ONTEM'],
    totalVendido: 40,
    totalPorMeio: { dinheiro: 40 },
    meiosDeclarados: { dinheiro: 140, debito: 0, credito: 0, pix: 0 },
    totalRecebido: 140,
    diferenca: 0,
    valorEnvelope: 0,
    saldoRestante: 100,
  }], null, 2));
  fs.writeFileSync(path.join(db, 'caixa.json'), JSON.stringify({
    id: 'CX-HOJE',
    operador: 'QA',
    valorInicial: 200,
    abertoEm: agora - 1800000,
    fechadoEm: null,
    pedidos: ['PED-HOJE'],
    meios: {},
    sangrias: [],
  }, null, 2));
  fs.writeFileSync(path.join(db, 'pedidos.json'), JSON.stringify([
    {
      id: 'PED-ONTEM', numero: 1, caixaId: 'CX-ONTEM', total: 40, status: 'PAGO',
      pagamentos: [{ meio: 'dinheiro', valor: 40 }], criadoEm: ontem,
    },
    {
      id: 'PED-HOJE', numero: 2, caixaId: 'CX-HOJE', total: 60, status: 'PAGO',
      pagamentos: [{ meio: 'pix', valor: 60 }], criadoEm: agora - 1200000,
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

  const pagamento = await fetch(base + '/api/pedidos/PED-ONTEM', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pagamentos: [{ meio: 'credito', valor: 40 }] }),
  });
  assert.equal(pagamento.status, 200);

  const correcao = await fetch(base + '/api/pdv/caixas/CX-ONTEM', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      meios: { dinheiro: 100, debito: 0, credito: 40, pix: 0 },
      valorEnvelope: 0,
      saldoRestante: 100,
      motivo: 'Teste de correcao cross-day',
      corrigidoPor: 'QA',
    }),
  });
  assert.equal(correcao.status, 200);
  const corrigido = await correcao.json();
  assert.equal(corrigido.caixa.totalVendido, 40);
  assert.equal(corrigido.caixa.totalPorMeio.credito, 40);
  assert.equal(corrigido.caixa.totalPorMeio.dinheiro, undefined);

  const caixaAberto = await (await fetch(base + '/api/pdv/caixa')).json();
  assert.equal(caixaAberto.caixa.id, 'CX-HOJE');
  assert.deepEqual(caixaAberto.caixa.pedidos, ['PED-HOJE']);

  const historico = await (await fetch(base + '/api/pdv/caixas')).json();
  const antigo = historico.caixas.find((c) => c.id === 'CX-ONTEM');
  assert.equal(antigo.totalVendido, 40);
  assert.equal(antigo.totalPorMeio.credito, 40);
  assert.equal(historico.caixas.some((c) => c.id === 'CX-HOJE'), false);
});

const dataLocal = (ts) => {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

function escreverJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function subirSidecar(t, tmp, port) {
  const base = `http://127.0.0.1:${port}`;
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
  return { base, logs: () => logs };
}

test('pedido novo de sessao de ontem entra no caixa aberto hoje', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-caixa-sessao-'));
  const app = path.join(tmp, 'natal-app');
  const db = path.join(app, 'database');
  const agora = Date.now();
  const ontem = agora - 24 * 3600000;
  const sessaoEm = ontem - 3600000;

  escreverJson(path.join(app, 'sessoes', 'S-ONTEM', 'meta.json'), {
    id: 'S-ONTEM', estado: 'CRIADA', criadaEm: sessaoEm, fotosEsperadas: 0,
  });
  escreverJson(path.join(db, 'caixas.json'), [{
    id: 'CX-ONTEM', numero: 1, operador: 'QA', valorInicial: 100,
    abertoEm: ontem - 3 * 3600000, fechadoEm: ontem + 3600000,
    pedidos: [], totalVendido: 0, totalPorMeio: {},
    meiosDeclarados: { dinheiro: 100, debito: 0, credito: 0, pix: 0 },
  }]);
  escreverJson(path.join(db, 'caixa.json'), {
    id: 'CX-HOJE', operador: 'QA', valorInicial: 200,
    abertoEm: agora - 1800000, fechadoEm: null, pedidos: [], meios: {}, sangrias: [],
  });
  escreverJson(path.join(db, 'pedidos.json'), []);

  const s = subirSidecar(t, tmp, 21000 + Math.floor(Math.random() * 1000));
  await esperarHealth(s.base, s.logs);

  const criado = await (await fetch(s.base + '/api/pedidos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessaoId: 'S-ONTEM', sessoes: [{ id: 'S-ONTEM' }], total: 40 }),
  })).json();
  assert.equal(criado.success, true);
  assert.equal(criado.pedido.caixaId, 'CX-HOJE');
  assert.equal(criado.pedido.caixaPeriodoDivergente, true);
  assert.equal(dataLocal(criado.pedido.criadoEm), dataLocal(sessaoEm));
  assert.equal(dataLocal(criado.pedido.periodoEm), dataLocal(sessaoEm));

  const pago = await (await fetch(s.base + '/api/pedidos/' + criado.pedido.id + '/pagamento', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pagamentos: [{ meio: 'dinheiro', valor: 40 }] }),
  })).json();
  assert.equal(pago.success, true);
  assert.equal(pago.pedido.status, 'PAGO');
  assert.equal(dataLocal(pago.pedido.pagoEm), dataLocal(sessaoEm));

  const aberto = await (await fetch(s.base + '/api/pdv/caixa')).json();
  assert.equal(aberto.caixa.id, 'CX-HOJE');
  assert.equal(aberto.caixa.pedidos.includes(criado.pedido.id), true);

  const historico = await (await fetch(s.base + '/api/pdv/caixas')).json();
  const antigo = historico.caixas.find((c) => c.id === 'CX-ONTEM');
  assert.equal(antigo.pedidos.includes(criado.pedido.id), false);

  // Edicao de um pedido antigo: herda o periodo do original, mas o dinheiro
  // recebido agora entra no caixa que esta aberto agora.
  const editado = await (await fetch(s.base + '/api/pedidos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessaoId: 'S-ONTEM', sessoes: [{ id: 'S-ONTEM' }], total: 10,
      origemPedidoId: criado.pedido.id,
    }),
  })).json();
  assert.equal(editado.success, true);
  assert.equal(editado.pedido.caixaId, 'CX-HOJE');
  assert.equal(editado.pedido.caixaPeriodoDivergente, true);
  assert.equal(dataLocal(editado.pedido.criadoEm), dataLocal(sessaoEm));

  // Edicao da edicao: a cadeia inteira continua apontando para a venda original.
  const editado2 = await (await fetch(s.base + '/api/pedidos', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessaoId: 'S-ONTEM', sessoes: [{ id: 'S-ONTEM' }], total: 5,
      origemPedidoId: editado.pedido.id,
    }),
  })).json();
  assert.equal(editado2.success, true);
  assert.equal(editado2.pedido.caixaId, 'CX-HOJE');
  assert.equal(editado2.pedido.caixaPeriodoDivergente, true);
  assert.equal(dataLocal(editado2.pedido.criadoEm), dataLocal(sessaoEm));
});

test('boot move para o caixa do registro pedidos antigos gravados no caixa do periodo', async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-caixa-boot-'));
  const app = path.join(tmp, 'natal-app');
  const db = path.join(app, 'database');
  const agora = Date.now();
  const ontem = agora - 24 * 3600000;
  const sessaoEm = ontem - 3600000;

  escreverJson(path.join(app, 'sessoes', 'S-ONTEM', 'meta.json'), {
    id: 'S-ONTEM', estado: 'VENDIDA', criadaEm: sessaoEm, fotosEsperadas: 0,
  });
  escreverJson(path.join(db, 'caixas.json'), [{
    id: 'CX-ONTEM', numero: 1, operador: 'QA', valorInicial: 100,
    abertoEm: ontem - 3 * 3600000, fechadoEm: ontem + 3600000,
    pedidos: ['PED-OLD', 'PED-NOVO2', 'PED-NOVO', 'PED-SEM'],
    totalVendido: 120, totalPorMeio: { dinheiro: 40, credito: 50, pix: 30 },
    meiosDeclarados: { dinheiro: 140, debito: 0, credito: 50, pix: 30 },
  }]);
  escreverJson(path.join(db, 'caixa.json'), {
    id: 'CX-HOJE', operador: 'QA', valorInicial: 200,
    abertoEm: agora - 1800000, fechadoEm: null,
    pedidos: [], meios: {}, sangrias: [],
  });
  escreverJson(path.join(db, 'pedidos.json'), [
    {
      id: 'PED-OLD', numero: 1, caixaId: 'CX-ONTEM', total: 40, status: 'CANCELADO',
      pagamentos: [{ meio: 'dinheiro', valor: 40 }], criadoEm: ontem, pagoEm: ontem,
      canceladoEm: agora - 600000,
    },
    {
      // Legado da 1.3.32: a venda de sessao de ontem ficou gravada no caixa do
      // periodo, mas o dinheiro foi recebido agora (registradoEm de hoje).
      id: 'PED-NOVO2', numero: 4, caixaId: 'CX-ONTEM', origemPedidoId: 'PED-NOVO',
      total: 10, status: 'PAGO', pagamentos: [{ meio: 'credito', valor: 10 }],
      criadoEm: agora, pagoEm: agora, registradoEm: agora, periodoEm: sessaoEm,
    },
    {
      id: 'PED-NOVO', numero: 2, caixaId: 'CX-ONTEM', origemPedidoId: 'PED-OLD',
      total: 40, status: 'PAGO', pagamentos: [{ meio: 'credito', valor: 40 }],
      criadoEm: agora, pagoEm: agora, registradoEm: agora, periodoEm: sessaoEm,
    },
    {
      id: 'PED-SEM', numero: 3, caixaId: 'CX-ONTEM', sessaoId: 'S-ONTEM',
      total: 30, status: 'PAGO', pagamentos: [{ meio: 'pix', valor: 30 }],
      criadoEm: agora, pagoEm: agora, registradoEm: agora, periodoEm: sessaoEm,
    },
  ]);

  const s = subirSidecar(t, tmp, 22000 + Math.floor(Math.random() * 1000));
  await esperarHealth(s.base, s.logs);

  for (const id of ['PED-NOVO', 'PED-NOVO2', 'PED-SEM']) {
    const pedido = (await (await fetch(s.base + '/api/pedidos/' + id)).json()).pedido;
    assert.equal(pedido.caixaId, 'CX-HOJE');
    assert.equal(pedido.caixaPeriodoDivergente, true);
    assert.equal(pedido.caixaReajuste.de, 'CX-ONTEM');
    assert.equal(pedido.caixaReajuste.para, 'CX-HOJE');
    assert.equal(pedido.caixaReajuste.motivo, 'dinheiro recebido em dia diferente do da sessão');
    assert.equal(dataLocal(pedido.criadoEm), dataLocal(agora));
  }

  const aberto = await (await fetch(s.base + '/api/pdv/caixa')).json();
  assert.equal(aberto.caixa.id, 'CX-HOJE');
  assert.deepEqual(aberto.caixa.pedidos.sort(), ['PED-NOVO', 'PED-NOVO2', 'PED-SEM']);

  const historico = await (await fetch(s.base + '/api/pdv/caixas')).json();
  const antigo = historico.caixas.find((c) => c.id === 'CX-ONTEM');
  assert.deepEqual(antigo.pedidos, ['PED-OLD']);
  assert.equal(fs.existsSync(path.join(app, 'migracao-caixa-registro.json')), true);
});
