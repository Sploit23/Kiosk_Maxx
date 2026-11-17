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

test('senha master do PDV e 2512 em todos os pontos', () => {
  const html = ler('vendas.html');
  assert.match(html, /const SENHA_MASTER_PDV = '2512';/);
  assert.match(html, /const SENHA_CFG_SISTEMA = '2512';/);
  assert.doesNotMatch(html, /SENHA_MASTER_PDV\s*=\s*'8694'/);
  assert.match(ler('sidecar', 'natal-core.cjs'), /SENHA_LIMPEZA_ALT = '2512'/);
});

test('PDV tem o fluxo solicitar/desfazer/aprovar cancelamento pelo portal', () => {
  const html = ler('vendas.html');
  assert.match(html, /function solicitarCancelamentoPortal/);
  assert.match(html, /function desfazerCancelamentoPortal/);
  assert.match(html, /function verificarCancelamentosPortal/);
  assert.match(html, /function aplicarCancelamentoRemoto/);
  assert.match(html, /function continuarCancelamento/);
  assert.match(html, /id="cx-solicitar"/);
  assert.match(html, /id="cx-desfazer"/);
  assert.match(html, /setInterval\(verificarCancelamentosPortal, 60000\)/);
  assert.doesNotMatch(html, /askSenhaMotivo\('Cancelar pedido'/);
});

test('portalApi expoe cancelamento.decisoes e o admin tem os endpoints', () => {
  assert.match(ler('shared', 'api', 'portalApi.js'), /cancelamentoDecisoes\(\{ lojaId/);
  const php = ler('backend', 'api.php');
  assert.match(php, /case 'cancelamento\.decisoes'/);
  assert.match(php, /case 'cancelamento\.pendentes'/);
  assert.match(php, /case 'cancelamento\.decidir'/);
  assert.match(php, /'cancelamento' => \$cancel/);
  const admin = ler('backend', 'admin.html');
  assert.match(admin, /function abrirAprovarCancelamento/);
  assert.match(admin, /function decidirCancelamento/);
  assert.match(admin, /id="cancel-badge"/);
});

async function subirSidecar(db, porta) {
  const tmp = path.dirname(path.dirname(db));
  let logs = '';
  const child = spawn(process.execPath, ['sidecar/natal-core.cjs'], {
    cwd: root,
    env: {
      ...process.env,
      NATAL_PORT: String(porta),
      NATAL_HOST: '127.0.0.1',
      NATAL_PHOTOS_FOLDER: tmp,
      NATAL_DATA_DIR: path.join(tmp, 'legacy'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => { logs += d; });
  child.stderr.on('data', (d) => { logs += d; });
  const base = `http://127.0.0.1:${porta}`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
      if (res.ok) return { child, base, logs: () => logs };
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

test('sidecar guarda pedido de cancelamento e a decisao aprovada', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'natal-cancel-'));
  const db = path.join(tmp, 'natal-app', 'database');
  const porta = 20000 + Math.floor(Math.random() * 1000);
  fs.mkdirSync(db, { recursive: true });
  fs.writeFileSync(path.join(db, 'pedidos.json'), JSON.stringify([{
    id: 'PED-CANC1',
    numero: 77,
    caixaId: 'CX-1',
    total: 50,
    status: 'PAGO',
    operador: 'QA',
    itens: [{ produtoId: 'foto-10x15', label: 'Foto 10x15', qtd: 1, preco: 50, tipo: 'tamanho' }],
    pagamentos: [{ meio: 'dinheiro', forma: 'Dinheiro', valor: 50 }],
  }], null, 2));

  const { child, base } = await subirSidecar(db, porta);
  const put = async (body) => {
    const res = await fetch(base + '/api/pedidos/PED-CANC1', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  };

  try {
    const pedido = await put({
      cancelamentoSolicitado: true,
      cancelamentoSolicitadoEm: Date.now(),
      cancelamentoSolicitadoPor: 'QA Natal',
    });
    assert.equal(pedido.status, 200);
    assert.equal(pedido.json.pedido.cancelamentoSolicitado, true);
    assert.equal(pedido.json.pedido.cancelamentoSolicitadoPor, 'QA Natal');

    const desfeito = await put({ cancelamentoSolicitado: false });
    assert.equal(desfeito.json.pedido.cancelamentoSolicitado, false);
    assert.equal(desfeito.json.pedido.cancelamentoSolicitadoPor, '');

    await put({ cancelamentoSolicitado: true, cancelamentoSolicitadoPor: 'QA Natal' });
    const aprovado = await put({
      status: 'cancelado',
      cancelamentoSolicitado: false,
      cancelamentoDecisao: {
        status: 'aprovado',
        estoque: 'perder',
        reembolso: { forma: 'dinheiro', valor: 50 },
        decididoEm: new Date().toISOString(),
      },
      itensDevolvidos: [],
      itensPerdidos: ['Foto 10x15'],
      devolucao: { forma: 'dinheiro', valor: 50 },
    });
    assert.equal(aprovado.status, 200);
    assert.equal(aprovado.json.pedido.status, 'CANCELADO');
    assert.equal(aprovado.json.pedido.cancelamentoSolicitado, false);
    assert.equal(aprovado.json.pedido.cancelamentoDecisao.status, 'aprovado');
    assert.equal(aprovado.json.pedido.cancelamentoDecisao.estoque, 'perder');
    assert.deepEqual(aprovado.json.pedido.itensPerdidos, ['Foto 10x15']);

    const listado = await (await fetch(base + '/api/pedidos')).json();
    const salvo = listado.pedidos.find((p) => p.id === 'PED-CANC1');
    assert.equal(salvo.status, 'CANCELADO');
    assert.equal(salvo.cancelamentoDecisao.reembolso.forma, 'dinheiro');
  } finally {
    await parar(child);
  }
});
