'use strict';

// ─────────────────────────────────────────────────────────────
// natal-core.cjs — Sidecar servidor do Sistema Natal (porta 9877)
//
// Roda no PC da VENDA (spawnado pelo electron-main do app PDV).
// O app do FOTÓGRAFO fala com ele pela rede local (LAN Wi-Fi).
//
// Responsabilidades:
//   - Sessões: criar, receber fotos (original + preview), estados
//   - Pedidos: criar, registrar pagamento externo, fila de impressão
//   - Caixa: abrir/fechar turno, meios de pagamento
//   - Impressão ASK-400 (porta 8080, Java sidecar) + consumo de ribbon
//   - SSE para as duas telas
//
// Zero deps (apenas node: built-ins). Executado com o próprio Node do
// Electron (ELECTRON_RUN_AS_NODE=1), igual ao kiosk-core.cjs.
// ─────────────────────────────────────────────────────────────
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.NATAL_PORT, 10) || 9877;
const HOST = process.env.NATAL_HOST || '0.0.0.0';

// ─── Caminhos ────────────────────────────────────────────────
const DATA_DIR = process.env.NATAL_DATA_DIR || path.join(process.env.APPDATA || process.cwd(), 'natal-app');
const DB_DIR = path.join(DATA_DIR, 'database');
const SESSOES_DIR = path.join(DATA_DIR, 'sessoes');
const PEDIDOS_DIR = path.join(DATA_DIR, 'pedidos');
const PRINT_QUEUE_DIR = path.join(DATA_DIR, 'print-queue');
const PEDIDOS_FILE = path.join(DB_DIR, 'pedidos.json');
const CAIXA_FILE = path.join(DB_DIR, 'caixa.json');
const COUNTER_FILE = path.join(DB_DIR, 'counter.txt');
const RIBBON_FILE = path.join(DB_DIR, 'ribbon-counter.txt');
const CONFIG_FILE = path.join(DB_DIR, 'config.json');

// ─── Estados de sessão ───────────────────────────────────────
const ESTADOS = {
  CRIADA: 'CRIADA',
  FOTOGRAFANDO: 'FOTOGRAFANDO',
  RECEBENDO: 'RECEBENDO',
  PRONTA: 'PRONTA',
  EM_ATENDIMENTO: 'EM_ATENDIMENTO',
  VENDIDA: 'VENDIDA',
  FINALIZADA: 'FINALIZADA',
  CANCELADA: 'CANCELADA',
};

// ─── Init de dados (idempotente) ─────────────────────────────
for (const dir of [DB_DIR, SESSOES_DIR, PEDIDOS_DIR, PRINT_QUEUE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
if (!fs.existsSync(PEDIDOS_FILE)) fs.writeFileSync(PEDIDOS_FILE, '[]', 'utf-8');
if (!fs.existsSync(CAIXA_FILE)) fs.writeFileSync(CAIXA_FILE, 'null', 'utf-8');
if (!fs.existsSync(RIBBON_FILE)) fs.writeFileSync(RIBBON_FILE, '400', 'utf-8');

// ─── Helpers de IO ───────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8');
}
function readText(file) {
  try { return fs.readFileSync(file, 'utf-8').trim(); } catch { return ''; }
}
function writeText(file, value) {
  fs.writeFileSync(file, String(value), 'utf-8');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function sanitizeSegment(s) {
  return String(s || '').replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 120);
}

// ─── Config da máquina ───────────────────────────────────────
let machineConfig = readJson(CONFIG_FILE, {});
function getMachineConfig() { return machineConfig; }
function setMachineConfig(partial) {
  machineConfig = { ...machineConfig, ...partial };
  writeJson(CONFIG_FILE, machineConfig);
}

// ─── Contador de sessões (NATAL-XXXXX) ───────────────────────
let counter = parseInt(readText(COUNTER_FILE), 10) || 0;
function nextSessionId() {
  counter += 1;
  writeText(COUNTER_FILE, String(counter));
  return `NATAL-${String(counter).padStart(5, '0')}`;
}

// ─── Pedidos ─────────────────────────────────────────────────
let pedidos = readJson(PEDIDOS_FILE, []);
function savePedidos() { writeJson(PEDIDOS_FILE, pedidos); }
function nextPedidoNumero() {
  const max = pedidos.reduce((m, p) => Math.max(m, p.numero || 0), 0);
  return max + 1;
}

// ─── Caixa ───────────────────────────────────────────────────
let caixa = readJson(CAIXA_FILE, null);
function saveCaixa() { writeJson(CAIXA_FILE, caixa); }
function requireCaixaAberto() {
  return caixa && !caixa.fechadoEm ? caixa : null;
}

// ─── Ribbon (contagem de papel) ──────────────────────────────
function getRibbon() {
  let v = parseInt(readText(RIBBON_FILE), 10);
  if (Number.isNaN(v)) v = 400;
  return v;
}
function consumeRibbon(units) {
  const current = getRibbon();
  const waste = (current + units) % 2;
  const consumed = units + waste;
  const remaining = Math.max(current - consumed, 0);
  writeText(RIBBON_FILE, String(remaining));
  return { consumed, previous: current, remaining, waste };
}

// ─── SSE ─────────────────────────────────────────────────────
const sseClients = new Set();
function emit(event, data) {
  const payload = typeof data === 'string'
    ? `event: ${event}\ndata: ${data}\n\n`
    : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch { sseClients.delete(client); }
  }
}

// ─── Sessões ─────────────────────────────────────────────────
function sessaoDir(id) { return path.join(SESSOES_DIR, sanitizeSegment(id)); }
function sessaoMetaPath(id) { return path.join(sessaoDir(id), 'meta.json'); }

function getSessao(id) {
  const meta = readJson(sessaoMetaPath(id), null);
  if (!meta) return null;
  const dir = sessaoDir(id);
  const previews = safeReadDir(path.join(dir, 'previews'));
  const originais = safeReadDir(path.join(dir, 'originais'));
  return {
    ...meta,
    fotos: previews.map((f) => ({ name: f, preview: true, original: originais.includes(f) })),
    fotosQtd: previews.length,
  };
}

function safeReadDir(dir) {
  try { return fs.readdirSync(dir).filter((f) => !f.startsWith('.')); } catch { return []; }
}

function listarSessoes() {
  const ids = safeReadDir(SESSOES_DIR);
  return ids
    .map((id) => getSessao(id))
    .filter(Boolean)
    .sort((a, b) => (b.criadaEm || 0) - (a.criadaEm || 0));
}

function atualizarSessao(id, patch) {
  const meta = readJson(sessaoMetaPath(id), null);
  if (!meta) return;
  writeJson(sessaoMetaPath(id), { ...meta, ...patch });
}

// ─── HTTP helpers ────────────────────────────────────────────
function sendJson(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}
function readBody(req, maxBytes = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Corpo maior que o limite'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Impressão ASK-400 ───────────────────────────────────────
const JAVA_PRINTER_URL = 'http://localhost:8080/kws/v1/printer/print2';

function mediaForPaper(paper) {
  return paper === '15x20' ? '6x8' : '6x4';
}
function ribbonUnitsFor(items) {
  // itens: { key, qty } — papel 10x15 = 1 unidade, 15x20 = 2
  return items.reduce((acc, it) => {
    const paper = it.key === '15x20' ? '15x20' : '10x15';
    return acc + (paper === '10x15' ? 1 : 2) * (it.qty || 1);
  }, 0);
}
async function callPrinter(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 120000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } finally {
    clearTimeout(timer);
  }
}
function buildPrintList(items, pedidoId) {
  const list = [];
  const dir = path.join(PRINT_QUEUE_DIR, sanitizeSegment(pedidoId));
  for (const item of items) {
    const filename = sanitizeSegment(item.filename);
    const src = path.join(dir, filename);
    const dotIdx = filename.lastIndexOf('.');
    const baseName = dotIdx > 0 ? filename.substring(0, dotIdx) : filename;
    const ext = dotIdx > 0 ? filename.substring(dotIdx) : '';
    const media = mediaForPaper(item.key);
    for (let q = 0; q < (item.qty || 1); q++) {
      list.push({
        src,
        destName: q === 0 ? filename : `${baseName}_${q}${ext}`,
        media,
      });
    }
  }
  return list;
}

async function runPrintPipeline(pedido) {
  const pedidoId = String(pedido.id);
  const tmpRoot = path.join(os.tmpdir(), 'natal-print', sanitizeSegment(pedidoId));
  const queueDir = path.join(PRINT_QUEUE_DIR, sanitizeSegment(pedidoId));
  try {
    const allPrints = buildPrintList(pedido.fotos, pedidoId);
    const total = allPrints.length;
    emit('print-start', { pedidoId, total });

    for (let i = 0; i < total; i++) {
      const { src, destName, media } = allPrints[i];
      if (!fs.existsSync(src)) {
        console.warn(`[natal-core] Foto nao encontrada, pulando: ${src}`);
        continue;
      }
      const dir = path.join(tmpRoot, `${media}_${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.copyFileSync(src, path.join(dir, destName));

      console.log(`[natal-core] Imprimindo ${i + 1}/${total}: ${destName} (${media})`);
      await callPrinter(`${JAVA_PRINTER_URL}?code=${encodeURIComponent(dir)}&media=${media}&printerName=`);

      emit('printer:progress', { current: i + 1, total });
      fs.rmSync(dir, { recursive: true, force: true });
      if (i < total - 1) await sleep(i === 0 ? 18000 : 12000);
    }

    const ribbon = consumeRibbon(ribbonUnitsFor(pedido.fotos));

    pedidos = pedidos.map((p) => (p.id === pedido.id ? { ...p, status: 'IMPRESSO', impressoEm: Date.now() } : p));
    savePedidos();
    atualizarSessao(pedido.sessaoId, { estado: ESTADOS.FINALIZADA, finalizadaEm: Date.now() });

    emit('pedido:impresso', { pedidoId, numero: pedido.numero });
    emit('print-complete', { pedidoId, success: true });
    emit('sessao:status', { id: pedido.sessaoId, estado: ESTADOS.FINALIZADA });

    fs.rmSync(queueDir, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log(`[natal-core] Pedido ${pedido.numero} impresso (ribbon: ${ribbon.remaining})`);
  } catch (e) {
    console.error(`[natal-core] Falha na impressao do pedido ${pedidoId}: ${e.message}`);
    emit('print-complete', { pedidoId, success: false, error: `Falha Java sidecar: ${e.message}` });
  }
}

// ─── Roteador ────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const method = req.method;

  if (method === 'OPTIONS') return sendJson(res, 200, { success: true });

  try {
    // ── SSE ──
    if (method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ── Health / config ──
    if (method === 'GET' && p === '/api/health') {
      return sendJson(res, 200, { ok: true, pdv: machineConfig.pdvNome || os.hostname(), time: Date.now(), ribbon: getRibbon() });
    }
    if (method === 'GET' && p === '/api/config') {
      return sendJson(res, 200, { ...machineConfig, ribbon: getRibbon() });
    }
    if (method === 'POST' && p === '/api/config') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      setMachineConfig(body);
      return sendJson(res, 200, { success: true, config: machineConfig });
    }

    // ── Sessões ──
    if (method === 'POST' && p === '/api/sessoes') {
      const id = nextSessionId();
      const meta = {
        id,
        estado: ESTADOS.CRIADA,
        criadaEm: Date.now(),
        fotosEsperadas: 0,
        operadorFotografo: '',
      };
      fs.mkdirSync(path.join(sessaoDir(id), 'previews'), { recursive: true });
      fs.mkdirSync(path.join(sessaoDir(id), 'originais'), { recursive: true });
      writeJson(sessaoMetaPath(id), meta);
      emit('sessao:criada', { id });
      emit('sessao:status', { id, estado: ESTADOS.CRIADA });
      console.log(`[natal-core] Sessao criada: ${id}`);
      return sendJson(res, 200, { success: true, sessao: meta });
    }

    if (method === 'GET' && p === '/api/sessoes') {
      return sendJson(res, 200, { success: true, sessoes: listarSessoes() });
    }

    const sessaoMatch = p.match(/^\/api\/sessoes\/([^/]+)$/);
    if (method === 'GET' && sessaoMatch) {
      const sessao = getSessao(sessaoMatch[1]);
      if (!sessao) return sendJson(res, 404, { success: false, error: 'Sessao nao encontrada' });
      return sendJson(res, 200, { success: true, sessao });
    }

    // Upload de fotos (binário cru): originais | preview
    const uploadMatch = p.match(/^\/api\/sessoes\/([^/]+)\/(originais|previews)\/([^/]+)$/);
    if (method === 'POST' && uploadMatch) {
      const [, id, type, filenameRaw] = uploadMatch;
      const filename = sanitizeSegment(filenameRaw);
      const sessao = getSessao(id);
      if (!sessao) return sendJson(res, 404, { success: false, error: 'Sessao nao encontrada' });
      const buf = await readBody(req);
      const dir = path.join(sessaoDir(id), type);
      fs.writeFileSync(path.join(dir, filename), buf);

      if (sessao.estado === ESTADOS.CRIADA || sessao.estado === ESTADOS.FOTOGRAFANDO) {
        atualizarSessao(id, { estado: ESTADOS.RECEBENDO });
      }
      emit('sessao:status', { id, estado: ESTADOS.RECEBENDO, fotosQtd: getSessao(id).fotosQtd });
      return sendJson(res, 200, { success: true, filename });
    }

    const finalizarMatch = p.match(/^\/api\/sessoes\/([^/]+)\/finalizar$/);
    if (method === 'POST' && finalizarMatch) {
      const sessao = getSessao(finalizarMatch[1]);
      if (!sessao) return sendJson(res, 404, { success: false, error: 'Sessao nao encontrada' });
      if (sessao.fotosQtd === 0) return sendJson(res, 400, { success: false, error: 'Sessao sem fotos' });
      if (![ESTADOS.RECEBENDO, ESTADOS.FOTOGRAFANDO].includes(sessao.estado)) {
        return sendJson(res, 400, { success: false, error: `Sessao em estado invalido: ${sessao.estado}` });
      }
      atualizarSessao(sessao.id, { estado: ESTADOS.PRONTA, prontaEm: Date.now() });
      emit('sessao:concluida', { id: sessao.id });
      emit('sessao:status', { id: sessao.id, estado: ESTADOS.PRONTA });
      return sendJson(res, 200, { success: true, sessao: getSessao(sessao.id) });
    }

    const cancelarMatch = p.match(/^\/api\/sessoes\/([^/]+)\/cancelar$/);
    if (method === 'POST' && cancelarMatch) {
      const sessao = getSessao(cancelarMatch[1]);
      if (!sessao) return sendJson(res, 404, { success: false, error: 'Sessao nao encontrada' });
      if (sessao.estado === ESTADOS.FINALIZADA || sessao.estado === ESTADOS.VENDIDA) {
        return sendJson(res, 400, { success: false, error: 'Sessao ja finalizada' });
      }
      atualizarSessao(sessao.id, { estado: ESTADOS.CANCELADA, canceladaEm: Date.now() });
      emit('sessao:status', { id: sessao.id, estado: ESTADOS.CANCELADA });
      return sendJson(res, 200, { success: true, sessao: getSessao(sessao.id) });
    }

    // ── Fotos (servir previews/originais) ──
    const fotoMatch = p.match(/^\/api\/fotos\/(originais|previews)\/([^/]+)\/([^/]+)$/);
    if (method === 'GET' && fotoMatch) {
      const [, type, id, filenameRaw] = fotoMatch;
      const filename = sanitizeSegment(filenameRaw);
      const file = path.join(sessaoDir(id), type, filename);
      if (!fs.existsSync(file)) return sendJson(res, 404, { success: false, error: 'Foto nao encontrada' });
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Content-Length': fs.statSync(file).size,
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // ── Pedidos ──
    if (method === 'POST' && p === '/api/pedidos') {
      const body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString() || '{}');
      const caixaAtual = requireCaixaAberto();
      if (!caixaAtual) return sendJson(res, 400, { success: false, error: 'Caixa nao esta aberto' });
      const sessao = getSessao(body.sessaoId);
      if (!sessao) return sendJson(res, 404, { success: false, error: 'Sessao nao encontrada' });

      const numero = nextPedidoNumero();
      let pagamentos = null;
      if (Array.isArray(body.pagamentos) && body.pagamentos.length) {
        pagamentos = body.pagamentos
          .filter((pg) => pg && Number(pg.valor) > 0)
          .map((pg) => ({
            meio: String(pg.meio || ''),
            valor: Number(pg.valor),
            parcelas: pg.parcelas ? Number(pg.parcelas) : undefined,
          }));
      }
      const meio = pagamentos && pagamentos.length
        ? (pagamentos.length === 1 ? pagamentos[0].meio : 'MULTI')
        : (body.meio || null);
      const pedido = {
        id: `PED-${Date.now().toString(36).toUpperCase()}`,
        numero,
        sessaoId: sessao.id,
        itens: body.itens || [],       // fotos: [{ key, qty }]
        produtos: body.produtos || [], // produtos físicos
        total: Number(body.total || 0),
        caixaId: caixaAtual.id,
        status: 'AGUARDANDO',
        criadoEm: Date.now(),
        meio,
        pagamentos,
        origemPedidoId: body.origemPedidoId || null,
        operador: body.operador || null,
        desconto: body.desconto || null,
        pagoEm: null,
        guiaImpressa: false,
        impressoEm: null,
      };
      pedidos.push(pedido);
      savePedidos();
      atualizarSessao(sessao.id, { estado: ESTADOS.EM_ATENDIMENTO, pedidoNumero: numero });
      emit('pedido:criado', { pedidoId: pedido.id, numero, sessaoId: sessao.id, total: pedido.total });
      emit('sessao:status', { id: sessao.id, estado: ESTADOS.EM_ATENDIMENTO });
      return sendJson(res, 200, { success: true, pedido });
    }

    const pedidoGet = p.match(/^\/api\/pedidos\/([^/]+)$/);
    if (method === 'GET' && pedidoGet) {
      const pedido = pedidos.find((x) => x.id === pedidoGet[1] || String(x.numero) === pedidoGet[1]);
      if (!pedido) return sendJson(res, 404, { success: false, error: 'Pedido nao encontrado' });
      return sendJson(res, 200, { success: true, pedido });
    }

    const pagamentoMatch = p.match(/^\/api\/pedidos\/([^/]+)\/pagamento$/);
    if (method === 'POST' && pagamentoMatch) {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      const pedido = pedidos.find((x) => x.id === pagamentoMatch[1]);
      if (!pedido) return sendJson(res, 404, { success: false, error: 'Pedido nao encontrado' });
      if (Array.isArray(body.pagamentos) && body.pagamentos.length) {
        const pgs = body.pagamentos
          .filter((pg) => pg && Number(pg.valor) > 0)
          .map((pg) => ({
            meio: String(pg.meio || ''),
            valor: Number(pg.valor),
            parcelas: pg.parcelas ? Number(pg.parcelas) : undefined,
          }));
        pedido.pagamentos = pgs;
        pedido.meio = pgs.length === 1 ? pgs[0].meio : 'MULTI';
      } else {
        pedido.meio = body.meio || pedido.meio;
      }
      pedido.status = 'PAGO';
      pedido.pagoEm = Date.now();
      savePedidos();
      atualizarSessao(pedido.sessaoId, { estado: ESTADOS.VENDIDA });
      emit('pedido:pago', { pedidoId: pedido.id, numero: pedido.numero, meio: pedido.meio });
      emit('sessao:status', { id: pedido.sessaoId, estado: ESTADOS.VENDIDA });
      return sendJson(res, 200, { success: true, pedido });
    }

    if (method === 'GET' && p === '/api/pedidos') {
      return sendJson(res, 200, { success: true, pedidos: [...pedidos].sort((a, b) => b.criadoEm - a.criadoEm) });
    }

    // Upload de imagem pronta para impressão
    const impressaoUpload = p.match(/^\/api\/pedidos\/([^/]+)\/impressao\/([^/]+)$/);
    if (method === 'POST' && impressaoUpload) {
      const [, pedidoId, filenameRaw] = impressaoUpload;
      const filename = sanitizeSegment(filenameRaw);
      const dir = path.join(PRINT_QUEUE_DIR, sanitizeSegment(pedidoId));
      fs.mkdirSync(dir, { recursive: true });
      const buf = await readBody(req);
      fs.writeFileSync(path.join(dir, filename), buf);
      return sendJson(res, 200, { success: true, filename });
    }

    // Iniciar impressão de um pedido PAGO
    const imprimirMatch = p.match(/^\/api\/pedidos\/([^/]+)\/imprimir$/);
    if (method === 'POST' && imprimirMatch) {
      const body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString() || '{}');
      const pedido = pedidos.find((x) => x.id === imprimirMatch[1]);
      if (!pedido) return sendJson(res, 404, { success: false, error: 'Pedido nao encontrado' });
      if (pedido.status !== 'PAGO') return sendJson(res, 400, { success: false, error: 'Pedido nao pago' });
      pedido.fotos = body.fotos || [];
      savePedidos();
      emit('print-start', { pedidoId: pedido.id, total: body.fotos?.length || 0 });
      setImmediate(() => runPrintPipeline(pedido));
      return sendJson(res, 200, { success: true });
    }

    // ── Caixa ──
    if (method === 'GET' && p === '/api/pdv/caixa') {
      return sendJson(res, 200, { success: true, caixa: caixa });
    }
    if (method === 'POST' && p === '/api/pdv/caixa/abrir') {
      if (requireCaixaAberto()) return sendJson(res, 400, { success: false, error: 'Caixa ja esta aberto' });
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      caixa = {
        id: `CX-${Date.now().toString(36).toUpperCase()}`,
        operador: String(body.operador || 'Operador'),
        valorInicial: Number(body.valorInicial || 0),
        abertoEm: Date.now(),
        fechadoEm: null,
        pedidos: [],
        meios: {},
      };
      saveCaixa();
      emit('caixa:aberto', { id: caixa.id, operador: caixa.operador });
      return sendJson(res, 200, { success: true, caixa });
    }
    if (method === 'POST' && p === '/api/pdv/caixa/fechar') {
      if (!requireCaixaAberto()) return sendJson(res, 400, { success: false, error: 'Caixa nao esta aberto' });
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      const meios = body.meios || {};
      const pedidosDoCaixa = pedidos.filter((x) => x.caixaId === caixa.id);
      const totalVendido = pedidosDoCaixa.reduce((acc, x) => acc + x.total, 0);
      const totalPorMeio = {};
      for (const p of pedidosDoCaixa) {
        if (p.status !== 'PAGO') continue;
        if (Array.isArray(p.pagamentos) && p.pagamentos.length) {
          for (const pg of p.pagamentos) {
            if (pg && pg.meio && Number(pg.valor) > 0) {
              totalPorMeio[pg.meio] = (totalPorMeio[pg.meio] || 0) + Number(pg.valor);
            }
          }
        } else if (p.meio) {
          totalPorMeio[p.meio] = (totalPorMeio[p.meio] || 0) + p.total;
        }
      }
      const totalRecebido = Object.values(meios).reduce((a, b) => a + Number(b || 0), 0);
      caixa = {
        ...caixa,
        fechadoEm: Date.now(),
        totalVendido,
        totalPorMeio,
        meiosDeclarados: meios,
        totalRecebido,
        diferenca: Number((totalRecebido - totalVendido).toFixed(2)),
        observacoes: body.observacoes || '',
      };
      saveCaixa();
      emit('caixa:fechado', { id: caixa.id, totalVendido });
      return sendJson(res, 200, { success: true, caixa });
    }

    return sendJson(res, 404, { success: false, error: 'Rota nao encontrada' });
  } catch (e) {
    console.error(`[natal-core] Erro ${method} ${p}:`, e.message);
    sendJson(res, 500, { success: false, error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[natal-core] Sidecar Natal rodando em http://${HOST}:${PORT}`);
  console.log(`[natal-core] Dados em: ${DATA_DIR}`);
});

server.on('error', (e) => {
  console.error('[natal-core] Erro fatal no servidor:', e.message);
  process.exit(1);
});

setInterval(() => {
  for (const client of sseClients) {
    try { client.write(': keepalive\n\n'); } catch { sseClients.delete(client); }
  }
}, 25000);

// Se o pai (electron-main) morrer, o stdin fecha -> sai junto (evita orphan).
process.stdin.on('end', () => {
  console.log('[natal-core] stdin fechado (pai encerrado), saindo...');
  process.exit(0);
});
