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
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const PORT = parseInt(process.env.NATAL_PORT, 10) || 9877;
const HOST = process.env.NATAL_HOST || '0.0.0.0';

// Build id do PRÓPRIO arquivo (12 chars do sha256). O electron-main calcula o
// mesmo hash do natal-core.cjs no disco e compara com o /api/health: se forem
// diferentes, a instância na porta é ANTIGA (código anterior à atualização) e
// ele mata e relança — evita o bug de "Rota nao encontrada" por reuso de
// sidecar desatualizado (electron-main: "Porta 9877 ja em uso").
const BUILD_ID = (() => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
})();

// Senha da manutenção "Limpar dados" (botão no ⚙ Config do PDV). Apaga vendas,
// sessões, fotos, caixa, fila de impressão, auditoria e contador de ribbon —
// preservando machineId/kioskCode (o pareamento com a loja sobrevive). Pode ser
// trocada por variável de ambiente no teste/Manutenção.
const SENHA_LIMPEZA = String(process.env.NATAL_LIMPEZA_SENHA || 'HCss221087');
function senhaConfere(enviada) {
  const a = crypto.createHash('sha256').update(String(enviada || '')).digest();
  const b = crypto.createHash('sha256').update(SENHA_LIMPEZA).digest();
  return crypto.timingSafeEqual(a, b);
}

// ─── Caminhos ────────────────────────────────────────────────
// Tudo (sessões, pedidos, caixa, counters, config) fica centralizado em
// <photosFolder>\natal-app — a pasta escolhida no ⚙ Configurações. Sem pasta
// configurada, usa o diretório legado (NATAL_DATA_DIR / %APPDATA%\natal-app).
const LEGACY_BOOT_DIR = process.env.NATAL_DATA_DIR || path.join(process.env.APPDATA || process.cwd(), 'natal-app');
const FOLDER_POINTER_FILE = path.join(LEGACY_BOOT_DIR, 'database', 'fotos-folder.txt');

function readBootstrapPhotosFolder() {
  const envFolder = String(process.env.NATAL_PHOTOS_FOLDER || '').trim();
  if (envFolder) return envFolder;
  try {
    const ptr = fs.readFileSync(FOLDER_POINTER_FILE, 'utf-8').trim();
    if (ptr) return ptr;
  } catch {}
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(LEGACY_BOOT_DIR, 'database', 'config.json'), 'utf-8'));
    if (cfg.photosFolder && String(cfg.photosFolder).trim()) return String(cfg.photosFolder).trim();
  } catch {}
  return '';
}

function computeDataDir(photosFolder) {
  const p = String(photosFolder || '').trim();
  return p ? path.join(p, 'natal-app') : LEGACY_BOOT_DIR;
}

function bindPaths(dataDir) {
  DB_DIR = path.join(dataDir, 'database');
  SESSOES_DIR = path.join(dataDir, 'sessoes');
  PEDIDOS_DIR = path.join(dataDir, 'pedidos');
  PRINT_QUEUE_DIR = path.join(dataDir, 'print-queue');
  PEDIDOS_FILE = path.join(DB_DIR, 'pedidos.json');
  CAIXA_FILE = path.join(DB_DIR, 'caixa.json');
  CAIXAS_FILE = path.join(DB_DIR, 'caixas.json');
  AUDITORIA_FILE = path.join(DB_DIR, 'auditoria.json');
  COUNTER_FILE = path.join(DB_DIR, 'counter.txt');
  RIBBON_FILE = path.join(DB_DIR, 'ribbon-counter.txt');
  CONFIG_FILE = path.join(DB_DIR, 'config.json');
  PASTA_IMPORTADAS_FILE = path.join(DB_DIR, 'pasta-importadas.json');
  FILA_IMPRESSAO_FILE = path.join(DB_DIR, 'fila-impressao.json');
  GALERIA_DIR = path.join(dataDir, 'galeria');
  FILA_PORTAL_FILE = path.join(DB_DIR, 'fila-portal.json');
  CACHE_PORTAL_FILE = path.join(DB_DIR, 'cache-portal.json');
  ENVIADOS_PORTAL_FILE = path.join(DB_DIR, 'enviados-portal.json');
}

// Move dados do diretório antigo para o novo (1º boot na pasta centralizada
// ou troca de pasta no ⚙). Não sobrescreve se o destino já tem dados. O
// fotos-folder.txt (ponteiro de bootstrap) fica no legado de propósito.
function moverDados(antigo, novo) {
  if (!antigo || !novo || antigo === novo) return;
  if (!fs.existsSync(path.join(antigo, 'database'))) return;
  if (fs.existsSync(path.join(novo, 'database', 'config.json'))) return;
  fs.mkdirSync(path.join(novo, 'database'), { recursive: true });
  for (const sub of ['sessoes', 'pedidos', 'print-queue', 'database']) {
    const src = path.join(antigo, sub);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(novo, sub);
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      if (sub === 'database' && entry === 'fotos-folder.txt') continue;
      const from = path.join(src, entry);
      const to = path.join(dest, entry);
      try { fs.renameSync(from, to); } catch {
        fs.cpSync(from, to, { recursive: true });
        fs.rmSync(from, { recursive: true, force: true });
      }
    }
  }
}

function persistFolderPointer(folder) {
  try {
    fs.mkdirSync(path.dirname(FOLDER_POINTER_FILE), { recursive: true });
    fs.writeFileSync(FOLDER_POINTER_FILE, String(folder || ''), 'utf-8');
  } catch {}
}

let DATA_DIR = computeDataDir(readBootstrapPhotosFolder());
let DB_DIR, SESSOES_DIR, PEDIDOS_DIR, PRINT_QUEUE_DIR;
let PEDIDOS_FILE, CAIXA_FILE, CAIXAS_FILE, AUDITORIA_FILE, COUNTER_FILE, RIBBON_FILE, CONFIG_FILE, PASTA_IMPORTADAS_FILE, FILA_IMPRESSAO_FILE, FILA_PORTAL_FILE, CACHE_PORTAL_FILE, ENVIADOS_PORTAL_FILE, GALERIA_DIR;
bindPaths(DATA_DIR);
moverDados(LEGACY_BOOT_DIR, DATA_DIR);

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
function inicializarDados() {
  for (const dir of [DB_DIR, SESSOES_DIR, PEDIDOS_DIR, PRINT_QUEUE_DIR, GALERIA_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(PEDIDOS_FILE)) fs.writeFileSync(PEDIDOS_FILE, '[]', 'utf-8');
  if (!fs.existsSync(CAIXA_FILE)) fs.writeFileSync(CAIXA_FILE, 'null', 'utf-8');
  if (!fs.existsSync(CAIXAS_FILE)) fs.writeFileSync(CAIXAS_FILE, '[]', 'utf-8');
  if (!fs.existsSync(AUDITORIA_FILE)) fs.writeFileSync(AUDITORIA_FILE, '[]', 'utf-8');
  if (!fs.existsSync(RIBBON_FILE)) fs.writeFileSync(RIBBON_FILE, '400', 'utf-8');
  if (!fs.existsSync(PASTA_IMPORTADAS_FILE)) fs.writeFileSync(PASTA_IMPORTADAS_FILE, '{}', 'utf-8');
}
inicializarDados();

// ─── Helpers de IO ───────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return fallback; }
}
function writeJson(file, data) {
  // Escrita atômica: grava num .tmp e troca o arquivo de uma vez. Sem isso, uma
  // queda de energia no meio do writeFileSync deixava o JSON truncado e o boot
  // seguinte lia {} (perdendo machineId/kioskCode e, com eles, o pareamento).
  const conteudo = JSON.stringify(data, null, 2);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, conteudo, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.writeFileSync(file, conteudo, 'utf-8'); } catch {}
    try { fs.rmSync(tmp, { force: true }); } catch {}
    void e;
  }
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
// machineId: gerado pelo PDV no primeiro boot e persistido aqui — identifica
// a máquina física p/ emparelhamento no portal (kiosk.pair) e carimbos futuros.
const MACHINE_DEFAULTS = { pdvNome: '', photosFolder: '', thermalPrinterName: '', machineId: '', lojaId: '', lojaNome: '', pairingCode: '', logoTexto: 'SHOPPING PALLADIUM', importFolder: '', importSessoes: true };
let machineConfig = { ...MACHINE_DEFAULTS, ...readJson(CONFIG_FILE, {}) };

// ─── Backup da identidade (machineId + kioskCode) ────────────
// O config.json fica em <photosFolder>\natal-app\database — se a pasta de fotos
// for apagada entre eventos, corrompida ou o disco falhar, o PDV perderia a
// identidade e geraria outro código (desemparelhando sozinho). Esta cópia vive
// FORA da pasta de fotos (C:\ProgramData\MaxxNatal) e é regravada a cada save;
// no boot, se o config.json vier sem machineId/kioskCode, a identidade volta
// do backup. Trocar de propósito continua sendo "Gerar novo código" (⚙) ou o
// limpar-dados-pdv.ps1 -Completo (que apaga este backup também).
const IDENTITY_BACKUP_FILE = (() => {
  const programData = String(process.env.ProgramData || process.env.PROGRAMDATA || '').trim();
  const dir = programData ? path.join(programData, 'MaxxNatal') : path.join(LEGACY_BOOT_DIR, 'database');
  return path.join(dir, 'kiosk-identity.json');
})();
function salvarBackupIdentidade(mc) {
  if (!mc || !mc.machineId || !mc.kioskCode) return;
  try {
    fs.mkdirSync(path.dirname(IDENTITY_BACKUP_FILE), { recursive: true });
    writeJson(IDENTITY_BACKUP_FILE, {
      machineId: mc.machineId,
      kioskCode: mc.kioskCode,
      lojaId: mc.lojaId || '',
      lojaNome: mc.lojaNome || '',
      pdvNome: mc.pdvNome || '',
      pareadoEm: mc.pareadoEm || '',
      pareadoLojaId: mc.pareadoLojaId || '',
      atualizadoEm: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[natal-core] nao consegui gravar o backup de identidade:', e.message);
  }
}
function restaurarIdentidadeSeFaltar() {
  if (machineConfig.machineId && machineConfig.kioskCode) {
    salvarBackupIdentidade(machineConfig); // mantém o backup fresco
    return;
  }
  let bk = null;
  try { bk = JSON.parse(fs.readFileSync(IDENTITY_BACKUP_FILE, 'utf-8')); } catch { return; }
  if (!bk || !bk.machineId || !bk.kioskCode) return;
  machineConfig = {
    ...machineConfig,
    machineId: bk.machineId,
    kioskCode: bk.kioskCode,
    lojaId: machineConfig.lojaId || bk.lojaId || '',
    lojaNome: machineConfig.lojaNome || bk.lojaNome || '',
    pdvNome: machineConfig.pdvNome || bk.pdvNome || '',
    pareadoEm: machineConfig.pareadoEm || bk.pareadoEm || '',
    pareadoLojaId: machineConfig.pareadoLojaId || bk.pareadoLojaId || '',
  };
  writeJson(CONFIG_FILE, machineConfig);
  console.warn(`[natal-core] IDENTIDADE RESTAURADA do backup (${bk.kioskCode}) — config.json estava sem machineId/kioskCode`);
}
restaurarIdentidadeSeFaltar();
persistFolderPointer(machineConfig.photosFolder);
function getMachineConfig() { return machineConfig; }
function setMachineConfig(partial) {
  const entrada = { ...partial };
  // Guarda de identidade: machineId/kioskCode já existentes NUNCA são
  // sobrescritos pelo POST /api/config genérico. Isso impede que um código
  // fantasma (gerado por bug de boot) substitua o código real persistido e
  // "desemparelhe" a máquina sozinha. Só a flag explícita _forceIdentity:true
  // (botão "Gerar novo código" do ⚙) permite trocar deliberadamente.
  const forcar = entrada._forceIdentity === true;
  delete entrada._forceIdentity;
  // Troca deliberada de loja (fluxo "vincular a uma loja existente" do wizard):
  // permite sobrescrever lojaId/lojaNome sem liberar machineId/kioskCode.
  const permitirLoja = entrada._allowLojaChange === true;
  delete entrada._allowLojaChange;
  if (!forcar) {
    if (machineConfig.machineId && entrada.machineId) delete entrada.machineId;
    if (machineConfig.kioskCode && entrada.kioskCode) delete entrada.kioskCode;
    // Pareamento/loja definidos no app também sobrevivem a saves parciais
    // (wizard, ⚙ Config, atualização do app). Só mudam com _allowLojaChange
    // ou com _forceIdentity (botão "Gerar novo código").
    if (!permitirLoja) {
      if (machineConfig.lojaId && entrada.lojaId) delete entrada.lojaId;
      if (machineConfig.lojaNome && entrada.lojaNome) delete entrada.lojaNome;
      if (machineConfig.pareadoEm && entrada.pareadoEm) delete entrada.pareadoEm;
      if (machineConfig.pareadoLojaId && entrada.pareadoLojaId) delete entrada.pareadoLojaId;
    }
  }
  const novo = { ...MACHINE_DEFAULTS, ...machineConfig, ...entrada };
  const novoFolder = String(novo.photosFolder || '').trim();
  const atualFolder = String(machineConfig.photosFolder || '').trim();
  machineConfig = novo;
  persistFolderPointer(novoFolder);
  const novoRoot = computeDataDir(novoFolder);
  if (novoRoot !== DATA_DIR) {
    moverDados(DATA_DIR, novoRoot);
    DATA_DIR = novoRoot;
    bindPaths(novoRoot);
    inicializarDados();
    recarregarEstadoLocal();
  }
  writeJson(CONFIG_FILE, machineConfig);
  salvarBackupIdentidade(machineConfig);
  ensurePhotosWatcher();
}

// ─── Config do "Envio digital" (galeria pública /natal) ──────
// O PDV manda o JPEG já composto; o sidecar sobe por FTP para a pasta da
// galeria. A senha fica FORA do machineConfig devolvido à UI (nunca vai pro
// renderer) — sobrescrevível por NATAL_FTP_PASS ou machineConfig.ftpPass.
const FTP_DEFAULTS = {
  host: process.env.NATAL_FTP_HOST || 'ftp.maxxfoto.com.br',
  port: parseInt(process.env.NATAL_FTP_PORT, 10) || 21,
  user: process.env.NATAL_FTP_USER || 'arenacaptour@maxxfoto.com.br',
  pass: process.env.NATAL_FTP_PASS || 'HCss221087!',
  folder: process.env.NATAL_FTP_FOLDER || '/public_html/natal/fotos',
  galeriaUrl: process.env.NATAL_GALERIA_URL || 'https://maxxfoto.com.br/natal',
};
function getFtpConfig() {
  return {
    host: String(machineConfig.ftpHost || FTP_DEFAULTS.host || '').trim(),
    port: parseInt(machineConfig.ftpPort, 10) || FTP_DEFAULTS.port || 21,
    user: String(machineConfig.ftpUser || FTP_DEFAULTS.user || '').trim(),
    pass: String(process.env.NATAL_FTP_PASS || machineConfig.ftpPass || FTP_DEFAULTS.pass || ''),
    folder: String(machineConfig.ftpFolder || FTP_DEFAULTS.folder || '').trim(),
    galeriaUrl: String(machineConfig.galeriaUrl || FTP_DEFAULTS.galeriaUrl || '').trim(),
  };
}
// Versão da config segura para o renderer (sem a senha do FTP).
function configPublica() {
  const { ftpPass, ...resto } = machineConfig;
  void ftpPass;
  return { ...resto, importFolder: getImportFolder(), importFolderCustom: String(machineConfig.importFolder || ''), ribbon: getRibbon() };
}

// ─── Pasta dos lotes do cartao (importador embutido) ─────────
// O importador (Pegar_Fotos headless) grava lotes NATAL-S#### nessa pasta.
// Default: <photosFolder>\_cartao. Pode ser trocada no ⚙ (ex.: outro disco).
function getImportFolder() {
  const custom = String(machineConfig.importFolder || '').trim();
  if (custom) return custom;
  const base = String(machineConfig.photosFolder || '').trim();
  return base ? path.join(base, '_cartao') : '';
}
// Subpastas de photosFolder que NAO sao drop zone de sessao.
function pastasReservadas(folder) {
  const reservadas = new Set(['importadas']);
  const imp = getImportFolder();
  try {
    if (imp) {
      const base = path.resolve(folder);
      const alvo = path.resolve(imp);
      if (alvo === base) return reservadas;
      if (alvo.startsWith(base + path.sep)) {
        // ignora o primeiro nivel que leva ate a pasta dos lotes (evita varrer
        // o cartao inteiro a cada poll e criar sessao da pasta-mae dos lotes)
        const first = path.relative(base, alvo).split(path.sep)[0];
        if (first) reservadas.add(first);
      }
    }
  } catch {}
  return reservadas;
}

// ─── Importador de pasta de fotos (drop zone por sessão) ─────
// Regra: cada subpasta dentro de photosFolder = uma sessão. O outro
// programa salva as fotos do cliente numa subpasta nova; quando a pasta
// fica estável (sem alterações) o sidecar cria a sessão NATAL-XXXXX,
// importa as fotos (original + preview) e marca PRONTA. A subpasta do
// cliente NÃO é movida/removida (é do programa externo — se sumir, ele
// recria e gera sessões novas em loop). Pastas já importadas ficam
// registradas (pasta-importadas.json) e só geram sessão nova se o
// conteúdo mudar.
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png']);
const SKIP_TAILS = ['.part', '.tmp', '.crdownload', '.download'];
// Reação rápida na chegada das fotos: varre a cada 900ms e importa com 3s
// sem mudança (antes 1500/8000 — dava 5-6s de atraso aparente). Segurança
// continua a mesma: qualquer troca de tamanho zera o cronômetro, arquivos
// <1KB ou com cauda .part/.tmp são ignorados, e a JANELA SÓ GARANTE que a
// cópia terminou — não mexe em qualidade: original entra byte a byte,
// preview é normalizado e a impressão usa o original a 300 DPI na venda.
const PHOTOS_POLL_MS = 900;
const PHOTOS_SETTLE_MS = 3000;
let photosWatcherTimer = null;
let dropState = new Map(); // subpasta -> { first, lastChange, names: {nome:size} }
let importingLock = false;

// Pastas de fotos JÁ importadas (abs path -> { id, snap }) — persistido em
// pasta-importadas.json p/ sobreviver a restart. Evita que a MESMA pasta
// gere sessões novas em loop (ex.: programa externo que recria a pasta ao
// perceber que ela sumiu). A pasta não é movida/removida pelo importer.
let pastaImportadas = readJson(PASTA_IMPORTADAS_FILE, {});
function savePastaImportadas() { try { writeJson(PASTA_IMPORTADAS_FILE, pastaImportadas); } catch {} }
const pastaPendentes = Object.keys(pastaImportadas).length;
if (pastaPendentes) console.log(`[natal-core] ${pastaPendentes} pasta(s) ja importadas (serao ignoradas se permanecerem na drop zone).`);

function ensurePhotosWatcher() {
  const folder = (machineConfig.photosFolder || '').trim();
  const importFolder = machineConfig.importSessoes !== false ? getImportFolder() : '';
  if (importFolder) {
    try { fs.mkdirSync(importFolder, { recursive: true }); } catch {}
  }
  if (photosWatcherTimer) { clearInterval(photosWatcherTimer); photosWatcherTimer = null; }
  if (!folder && !importFolder) { dropState.clear(); return; }
  photosWatcherTimer = setInterval(() => {
    const tarefas = [];
    if (folder) tarefas.push(scanPhotosFolder(folder));
    if (importFolder) tarefas.push(scanImportFolder(importFolder));
    Promise.all(tarefas).catch((e) => console.error('[natal-core] scan photos:', e.message));
  }, PHOTOS_POLL_MS);
}

function listImageEntries(dir) {
  return safeReadDir(dir)
    .filter((f) => {
      const low = f.toLowerCase();
      if (low.startsWith('.')) return false;
      if (SKIP_TAILS.some((t) => low.endsWith(t))) return false;
      return IMAGE_EXTS.has(path.extname(low));
    })
    .filter((f) => {
      try { return fs.statSync(path.join(dir, f)).size > 1024; } catch { return false; }
    });
}

function snapshotOf(dir) {
  const snap = {};
  for (const f of safeReadDir(dir)) {
    try { snap[f] = fs.statSync(path.join(dir, f)).size; } catch {}
  }
  return JSON.stringify(snap);
}

function sessionCriadaEm(subPath, photos) {
  try {
    const folderBirth = fs.statSync(subPath).birthtimeMs;
    if (typeof folderBirth === 'number' && folderBirth > 0) return folderBirth;
  } catch {}
  let earliest = null;
  for (const f of photos) {
    try {
      const b = fs.statSync(path.join(subPath, f)).birthtimeMs;
      if (typeof b === 'number' && b > 0 && (earliest === null || b < earliest)) earliest = b;
    } catch {}
  }
  return earliest || Date.now();
}

async function scanPhotosFolder(folder) {
  if (importingLock) return;
  const now = Date.now();
  const reservadas = pastasReservadas(folder);
  for (const sub of safeReadDir(folder)) {
    if (reservadas.has(sub)) continue;
    // pastas ocultas/temporarias (.tmp_importando_*) nunca sao sessoes
    if (sub.startsWith('.')) continue;
    const subPath = path.join(folder, sub);
    let st;
    try { st = fs.statSync(subPath); } catch { continue; }
    if (!st.isDirectory()) continue;

    const chave = path.resolve(subPath);
    const snapAtual = snapshotOf(subPath);
    const jaImportada = pastaImportadas[chave];
    const prev = dropState.get(sub);
    const reimportando = !!(prev && prev.reimportando);

    // Pasta já importada (soma de fotos daquele cliente). NÃO mexemos nela —
    // o programa externo é dono da pasta: se ela sumir, ele recria e o
    // ping-pong (mover → recriar → nova sessão) recomeça. Mesmo conteúdo p/
    // já importado = ignora sempre. Só re-importa se o conteúdo MUDOU de
    // verdade (nova leva de fotos); registros antigos (sem snapshot, string)
    // nunca são re-importados p/ não refazer o loop.
    if (jaImportada) {
      const mesmoConteudo = typeof jaImportada === 'object' && !!jaImportada.snap && jaImportada.snap === snapAtual;
      if (mesmoConteudo || reimportando === false) {
        if (mesmoConteudo) continue;
        // conteúdo mudou: reinicia a estabilização SEM atualizar o mapa (o
        // mapa só muda quando a nova leva for de fato importada).
        dropState.set(sub, { first: now, lastChange: now, snap: snapAtual, reimportando: true });
        continue;
      }
    }

    const photos = listImageEntries(subPath);

    if (!prev) {
      dropState.set(sub, { first: now, lastChange: now, snap: snapAtual });
      continue;
    }
    if (prev.snap !== snapAtual) {
      dropState.set(sub, { ...prev, lastChange: now, snap: snapAtual });
      continue;
    }
    // sem mudanças; precisa de ≥1 foto e idade suficiente p/ não cortar cópia
    if (photos.length === 0) {
      if (now - prev.lastChange >= PHOTOS_SETTLE_MS) dropState.delete(sub);
      continue;
    }
    if (now - prev.lastChange < PHOTOS_SETTLE_MS) continue;

    importingLock = true;
    try {
      await importarSubpastaSessao(subPath, sub, photos, reimportando);
    } finally {
      importingLock = false;
    }
  }
}

// ─── Lotes do cartao (pasta do importador embutido) ─────────
// Cada subpasta com o marcador `.natal_done` (gravado pelo importador DEPOIS
// de copiar tudo) vira uma sessao PRONTA, sem esperar o programa externo.
// Sem o marcador, o lote ainda esta sendo copiado -> espera.
async function scanImportFolder(folder) {
  if (importingLock) return;
  const now = Date.now();
  for (const sub of safeReadDir(folder)) {
    if (sub.startsWith('.') || sub.startsWith('_')) continue;
    const subPath = path.join(folder, sub);
    let st;
    try { st = fs.statSync(subPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    if (!fs.existsSync(path.join(subPath, '.natal_done'))) continue; // cópia em andamento

    const chave = path.resolve(subPath);
    const snapAtual = snapshotOf(subPath);
    const jaImportada = pastaImportadas[chave];
    const mesmoConteudo = !!(jaImportada && typeof jaImportada === 'object' && jaImportada.snap === snapAtual);
    if (mesmoConteudo) continue;

    const stateKey = 'cartao:' + sub;
    const photos = listImageEntries(subPath);
    // Lote só com RAW/HEIC/vídeo: o sidecar não sabe servir — ignora (o
    // fotógrafo precisa exportar JPEG; o importador pode converter no cartao).
    if (photos.length === 0) continue;

    const prev = dropState.get(stateKey);
    if (!prev) {
      dropState.set(stateKey, { first: now, lastChange: now, snap: snapAtual });
      continue;
    }
    if (prev.snap !== snapAtual) {
      dropState.set(stateKey, { ...prev, lastChange: now, snap: snapAtual });
      continue;
    }
    if (now - prev.lastChange < PHOTOS_SETTLE_MS) continue;

    importingLock = true;
    try {
      await importarSubpastaSessao(subPath, sub, photos, !!jaImportada);
      if (pastaImportadas[chave]) dropState.delete(stateKey);
    } finally {
      importingLock = false;
    }
  }
}

async function importarSubpastaSessao(subPath, sub, photos, reimportando) {
  // Re-settle que voltou ao conteúdo JÁ importado (mudança transitória):
  // não cria sessão duplicada.
  if (reimportando) {
    const chave = path.resolve(subPath);
    const ant = pastaImportadas[chave];
    if (ant && typeof ant === 'object' && ant.snap === snapshotOf(subPath)) {
      dropState.delete(sub);
      dropState.delete('cartao:' + sub);
      return;
    }
  }
  const id = nextSessionId();
  const dir = sessaoDir(id);
  fs.mkdirSync(path.join(dir, 'previews'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'originais'), { recursive: true });

  const imported = [];
  for (const file of photos) {
    const ext = path.extname(file).toLowerCase() === '.png' ? '.png' : '.jpg';
    const base = sanitizeSegment(path.basename(file, path.extname(file))) || 'foto';
    const name = base + ext;
    try {
      fs.copyFileSync(path.join(subPath, file), path.join(dir, 'originais', name));
      fs.copyFileSync(path.join(subPath, file), path.join(dir, 'previews', name)); // preview = cópia p/ servir rápido
      imported.push(name);
    } catch (e) {
      console.error(`[natal-core] Falha ao importar ${file}: ${e.message}`);
    }
  }
  if (imported.length === 0) return;

  const meta = {
    id,
    estado: ESTADOS.PRONTA, // automático: já disponível para venda
    criadaEm: sessionCriadaEm(subPath, photos),
    fotosEsperadas: imported.length,
    operadorFotografo: 'PASTA',
    importadaDe: sub,
    prontaEm: Date.now(),
  };
  writeJson(sessaoMetaPath(id), meta);
  emit('sessao:criada', { id });
  emit('sessao:concluida', { id });
  emit('sessao:status', { id, estado: ESTADOS.PRONTA, fotosQtd: imported.length });
  console.log(`[natal-core] Sessao ${id} importada da pasta (${imported.length} fotos): ${sub}`);

  // Registra como importada com o snapshot do conteúdo. A pasta NÃO é movida
  // nem removida: pertence ao programa externo que alimenta a drop zone — se
  // ela sumir, ele a recria e o loop recomeça.
  pastaImportadas[path.resolve(subPath)] = { id, snap: snapshotOf(subPath), importadaEm: Date.now() };
  savePastaImportadas();
  dropState.delete(sub);
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

// ─── Auditoria (uso de senha master) — persiste local pra sobreviver a
// restart e ser reenviada ao portal (idempotente por id). ─────────────
let auditoria = readJson(AUDITORIA_FILE, []);
function saveAuditoria() { writeJson(AUDITORIA_FILE, auditoria); }

// ─── Caixa ───────────────────────────────────────────────────
let caixa = readJson(CAIXA_FILE, null);
function saveCaixa() { writeJson(CAIXA_FILE, caixa); }
function requireCaixaAberto() {
  return caixa && !caixa.fechadoEm ? caixa : null;
}
// Histórico de caixas fechados (append-only) — consultado pelo PDV
let caixas = readJson(CAIXAS_FILE, []);
const pedidosImprimindo = new Set(); // lock anti impressão dupla (pipeline concorrente)
function arquivarCaixa(fechada) {
  caixas.push({ ...fechada, numero: fechada.numero || caixas.length + 1 });
  writeJson(CAIXAS_FILE, caixas);
}

// ─── Outbox para o portal (fila durável de envio) ─────────────
// O PDV funciona OFFLINE: nada é enviado direto do balcão. Tudo que o
// portal precisa registrar (snapshot do dia, pedido a pedido, uso de
// senha master) é gravado AQUI primeiro e fica no arquivo até a
// internet voltar. O portal é idempotente (pedido por pedido.id,
// snapshot por loja+data, auditoria por uso.id), então reenviar é seguro.
//
// item = { id, tipo, chave, payload, criadoEm, atualizadoEm,
//          tentativas, ultimoErro, ultimoEnvioEm }
//   tipo  = 'vendas' | 'pedido' | 'auditoria'
//   chave = identificador do registro no portal (data | pedidoId | usoId)
let filaPortal = readJson(FILA_PORTAL_FILE, []);
if (!Array.isArray(filaPortal)) filaPortal = [];
function saveFilaPortal() { writeJson(FILA_PORTAL_FILE, filaPortal); }

// Registro do que JÁ foi confirmado pelo portal:
// { "tipo:chave": { em: timestamp, hash: hashDoPayloadEnviado } }.
// Serve para o PDV não reenviar o histórico inteiro a cada boot (o portal é
// idempotente, mas reenviar tudo o tempo todo é desperdício e risco). O hash
// permite reenviar quando o registro mudou (ex.: pedido cancelado depois de
// pago) sem reenfileirar o que está igual.
let enviadosPortal = readJson(ENVIADOS_PORTAL_FILE, {});
if (!enviadosPortal || typeof enviadosPortal !== 'object' || Array.isArray(enviadosPortal)) enviadosPortal = {};
function saveEnviadosPortal() { writeJson(ENVIADOS_PORTAL_FILE, enviadosPortal); }

function hashPayload(payload) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(payload === undefined ? null : payload)).digest('hex');
  } catch {
    return null;
  }
}

function filaPortalItem(tipo, chave) {
  return filaPortal.find((i) => i && i.tipo === tipo && i.chave === String(chave)) || null;
}

// Enfileira (ou atualiza) um registro. Reenfileirar o mesmo tipo+chave
// ATUALIZA o payload em vez de duplicar (o snapshot do dia evolui com
// as vendas que entram depois).
function enfileirarPortal({ tipo, chave, payload } = {}) {
  const t = String(tipo || '').trim();
  const c = String(chave || '').trim();
  if (!t || !c) return null;
  const existente = filaPortalItem(t, c);
  if (existente) {
    if (payload !== undefined && payload !== null) existente.payload = payload;
    existente.atualizadoEm = Date.now();
    saveFilaPortal();
    return { item: existente, criado: false };
  }
  // Já foi confirmado com ESTE conteúdo? Então não há nada de novo a enviar.
  // Comparar o hash (e não só a chave) é o que permite propagar alterações
  // posteriores — p.ex. cancelamento de um pedido que já subiu como pago.
  const enviado = enviadosPortal[t + ':' + c];
  const hashEnviado = enviado && typeof enviado === 'object' ? enviado.hash : null;
  const hashNovo = hashPayload(payload);
  if (hashEnviado && hashNovo && hashEnviado === hashNovo) {
    return { item: null, criado: false, inalterado: true };
  }
  const item = {
    id: 'q-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'),
    tipo: t,
    chave: c,
    payload: payload === undefined ? null : payload,
    criadoEm: Date.now(),
    atualizadoEm: Date.now(),
    tentativas: 0,
    ultimoErro: '',
    ultimoEnvioEm: null,
  };
  filaPortal.push(item);
  saveFilaPortal();
  emit('portal:fila', { total: filaPortal.length });
  return { item, criado: true };
}

// Confirmação do portal: o item saiu com sucesso e sai da fila (e fica
// registrado como enviado para não ser reenviado).
function confirmarPortal({ id, tipo, chave } = {}) {
  const removidos = [];
  filaPortal = filaPortal.filter((i) => {
    if (id && i.id === id) { removidos.push(i); return false; }
    if (!id && tipo && chave && i.tipo === tipo && i.chave === String(chave)) { removidos.push(i); return false; }
    return true;
  });
  if (removidos.length) {
    saveFilaPortal();
    for (const i of removidos) {
      enviadosPortal[i.tipo + ':' + i.chave] = { em: Date.now(), hash: hashPayload(i.payload) };
    }
    saveEnviadosPortal();
    emit('portal:fila', { total: filaPortal.length });
  }
  return { success: true, restantes: filaPortal.length, confirmados: removidos.length };
}

// Falha no envio: o item CONTINUA na fila (não se perde nada) e a
// tentativa fica registrada para o operador ver no ⚙.
function erroPortal({ id, erro } = {}) {
  const item = filaPortal.find((i) => i.id === id);
  if (!item) return { success: false, error: 'ITEM_NAO_ENCONTRADO' };
  item.tentativas = (item.tentativas || 0) + 1;
  item.ultimoErro = String(erro || '').slice(0, 300);
  item.ultimoEnvioEm = Date.now();
  saveFilaPortal();
  return { success: true, tentativas: item.tentativas };
}

function filaPortalParaUI() {
  return filaPortal.map((i) => ({
    id: i.id,
    tipo: i.tipo,
    chave: i.chave,
    // payload é obrigatório: o drain do PDV envia o registro COMPLETO ao
    // portal (sem ele o item seria reenviado como objeto vazio).
    payload: i.payload,
    tentativas: i.tentativas || 0,
    ultimoErro: i.ultimoErro || '',
    criadoEm: i.criadoEm || null,
    ultimoEnvioEm: i.ultimoEnvioEm || null,
  }));
}

// ─── Cache local do portal (preços, equipe, credenciais) ──────
// O PDV precisa continuar funcionando sem internet: guarda aqui a última
// versão conhecida do catálogo e da equipe para cobrar o PREÇO CERTO e
// autenticar o operador quando a rede cai. As senhas nunca são
// gravadas em claro — só o hash sha256 (para conferência offline).
let cachePortal = readJson(CACHE_PORTAL_FILE, {});
if (!cachePortal || typeof cachePortal !== 'object' || Array.isArray(cachePortal)) cachePortal = {};
function saveCachePortal() { writeJson(CACHE_PORTAL_FILE, cachePortal); }

function mesclarCachePortal(partial = {}) {
  const p = partial || {};
  // Credenciais: { usuario: senha } → { usuario: { hash, atualizadoEm } }
  if (p.credenciais && typeof p.credenciais === 'object') {
    const cred = { ...(cachePortal.credenciais || {}) };
    for (const [usuario, senha] of Object.entries(p.credenciais)) {
      const u = String(usuario || '').trim();
      if (!u || !senha) continue;
      cred[u] = {
        hash: crypto.createHash('sha256').update(String(senha)).digest('hex'),
        atualizadoEm: Date.now(),
      };
    }
    p.credenciais = cred;
  }
  cachePortal = { ...cachePortal, ...p, atualizadoEm: Date.now() };
  saveCachePortal();
  return cachePortal;
}

function conferirCredencialCache(usuario, senha) {
  const u = String(usuario || '').trim();
  const entry = (cachePortal.credenciais || {})[u];
  if (!entry || !entry.hash) return false;
  const h = crypto.createHash('sha256').update(String(senha || '')).digest('hex');
  return h === entry.hash;
}

// Re-carrega o estado em memória após relocar o diretório de dados (troca de
// pasta no ⚙): o outro diretório pode ter seus próprios pedidos/caixa/etc.
function recarregarEstadoLocal() {
  counter = parseInt(readText(COUNTER_FILE), 10) || 0;
  pedidos = readJson(PEDIDOS_FILE, []);
  auditoria = readJson(AUDITORIA_FILE, []);
  caixa = readJson(CAIXA_FILE, null);
  caixas = readJson(CAIXAS_FILE, []);
  pastaImportadas = readJson(PASTA_IMPORTADAS_FILE, {});
  filaImpressao = (() => {
    const arr = readJson(FILA_IMPRESSAO_FILE, []);
    return Array.isArray(arr) ? arr.filter((j) => j && j.pedidoId) : [];
  })();
  filaPortal = (() => {
    const arr = readJson(FILA_PORTAL_FILE, []);
    return Array.isArray(arr) ? arr.filter((i) => i && i.tipo && i.chave) : [];
  })();
  cachePortal = readJson(CACHE_PORTAL_FILE, {});
  if (!cachePortal || typeof cachePortal !== 'object' || Array.isArray(cachePortal)) cachePortal = {};
  enviadosPortal = readJson(ENVIADOS_PORTAL_FILE, {});
  if (!enviadosPortal || typeof enviadosPortal !== 'object' || Array.isArray(enviadosPortal)) enviadosPortal = {};
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

// ─── Envio digital — galeria pública /natal (FTP, fila durável) ────────────
// O PDV compõe o JPEG da foto digital (pose única) e manda com o CÓDIGO da
// venda + sequência. O sidecar grava em disco (galeria/<CODIGO>/<seq>.jpg),
// sobe por FTP como <CODIGO>_<seq>.jpg e, por ÚLTIMO, o manifesto
// <CODIGO>.json — a página /natal só lista as fotos quando o manifesto
// existe, então nunca aparece meia venda. Sem internet nada se perde: tudo
// fica na pasta local e um worker reenvia sozinho (60s + gatilhos). A venda
// nunca depende do envio ter dado certo.
const GALERIA_SYNC_MS = 60000;
const galeriaLocks = new Set();
let _galeriaWorkerRodando = false;

function galeriaCodigoValido(codigo) {
  return /^[A-Z0-9]{4,12}$/.test(String(codigo || ''));
}
function galeriaCodigoDir(codigo) { return path.join(GALERIA_DIR, sanitizeSegment(String(codigo || '').toUpperCase())); }
function galeriaMetaPath(codigo) { return path.join(galeriaCodigoDir(codigo), 'meta.json'); }
function lerGaleriaMeta(codigo) { return readJson(galeriaMetaPath(codigo), null); }
function salvarGaleriaMeta(meta) { writeJson(galeriaMetaPath(meta.codigo), meta); }
function galeriaArquivoRemoto(codigo, seq) { return `${codigo}_${seq}.jpg`; }
function galeriaPendente(meta) {
  if (!meta) return false;
  if ((meta.fotos || []).some((f) => !f.enviadoEm)) return true;
  // o manifesto só vale DEPOIS que o PDV finaliza a venda (todas as fotos já
  // chegaram) — evita publicar uma venda pela metade se uma foto falhar.
  return !!meta.finalizadoEm && !meta.manifestoEnviadoEm;
}
function listarGalerias() {
  const out = [];
  let entradas = [];
  try { entradas = fs.readdirSync(GALERIA_DIR, { withFileTypes: true }); } catch { return out; }
  for (const ent of entradas) {
    if (!ent.isDirectory()) continue;
    const meta = lerGaleriaMeta(ent.name);
    if (meta && meta.codigo) out.push(meta);
  }
  return out.sort((a, b) => (b.criadoEm || 0) - (a.criadoEm || 0));
}
function galeriaStatusUI(meta) {
  const fotos = Array.isArray(meta.fotos) ? meta.fotos : [];
  return {
    codigo: meta.codigo,
    pedidoId: meta.pedidoId || null,
    criadoEm: meta.criadoEm || null,
    fotos: fotos.length,
    enviadas: fotos.filter((f) => f.enviadoEm).length,
    manifestoEnviado: !!meta.manifestoEnviadoEm,
    pendente: galeriaPendente(meta),
    tentativas: meta.tentativas || 0,
    ultimoErro: meta.ultimoErro || '',
    ultimoEnvioEm: meta.ultimoEnvioEm || null,
  };
}

// Cliente FTP mínimo (USER/PASS/TYPE I/CWD/PASV/STOR) em cima de node:net —
// zero deps, como o resto do sidecar. Usa PASV e conecta o canal de dados no
// MESMO host do controle (não no IP anunciado no 227), que costuma ser
// interno em servidores com NAT.
function ftpUpload({ host, port = 21, user, pass, folder = '', filename, buffer, timeout = 45000 }) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host, port });
    sock.setTimeout(timeout);
    let buf = '';
    let cur = [];
    const queue = [];
    let pending = null;
    let settled = false;

    const settle = (err, val) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch {}
      pending = null;
      if (err) reject(err); else resolve(val);
    };
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl + 1);
        buf = buf.slice(nl + 1);
        const clean = line.replace(/\r?\n$/, '');
        cur.push(clean);
        // uma resposta termina quando a linha começa com "NNN " (espaço, não '-')
        if (/^\d{3} /.test(clean)) {
          const resp = cur.join('\n');
          cur = [];
          if (pending) { const p = pending; pending = null; p(resp); }
          else queue.push(resp);
        }
      }
    };
    const readResp = () => {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((res) => { pending = res; });
    };
    const cmd = async (linha, ...ok) => {
      sock.write(linha + '\r\n');
      const resp = await readResp();
      const code = resp.slice(0, 3);
      if (ok.length && !ok.includes(code)) throw new Error(`${linha.split(' ')[0]}: ${resp.replace(/\s+/g, ' ')}`);
      return resp;
    };

    sock.on('data', onData);
    sock.on('timeout', () => settle(new Error('Timeout no FTP')));
    sock.on('error', (e) => settle(e));
    sock.on('close', () => { if (!settled) settle(new Error('FTP: conexão encerrada')); });

    (async () => {
      try {
        const greeting = await readResp();
        if (!greeting.startsWith('220')) throw new Error('FTP: ' + greeting.replace(/\s+/g, ' '));
        let r = await cmd(`USER ${user}`);
        if (r.startsWith('331')) r = await cmd(`PASS ${pass}`);
        if (!r.startsWith('230')) throw new Error('FTP login: ' + r.replace(/\s+/g, ' '));
        await cmd('TYPE I', '200');
        if (folder) await cmd(`CWD ${folder}`, '250', '200');
        const pasv = await cmd('PASV', '227');
        const m = /\(([0-9,]+)\)/.exec(pasv);
        if (!m) throw new Error('FTP PASV inválido');
        const nums = m[1].split(',').map(Number);
        const dataPort = nums[4] * 256 + nums[5];

        const dataSock = net.connect({ host, port: dataPort });
        dataSock.setTimeout(timeout);
        await new Promise((res, rej) => {
          dataSock.once('connect', res);
          dataSock.once('error', rej);
          dataSock.once('timeout', () => rej(new Error('Timeout no canal de dados FTP')));
        });

        sock.write(`STOR ${filename}\r\n`);
        const st = await readResp();
        if (!(st.startsWith('150') || st.startsWith('125'))) {
          dataSock.destroy();
          throw new Error('FTP STOR: ' + st.replace(/\s+/g, ' '));
        }
        dataSock.end(buffer);
        await new Promise((res) => dataSock.once('close', res));
        const fin = await readResp();
        if (!(fin.startsWith('226') || fin.startsWith('250'))) throw new Error('FTP upload: ' + fin.replace(/\s+/g, ' '));
        try { sock.write('QUIT\r\n'); } catch {}
        settle(null, true);
      } catch (e) {
        settle(e);
      }
    })();
  });
}

// Sobe um código inteiro: fotos que faltam + manifesto por último.
async function sincronizarGaleria(codigo, { forcar = false } = {}) {
  const c = String(codigo || '').toUpperCase();
  if (!galeriaCodigoValido(c)) return { success: false, error: 'Código inválido' };
  if (galeriaLocks.has(c)) return { success: false, sincronizando: true, pendente: true };
  let meta = lerGaleriaMeta(c);
  if (!meta) return { success: false, error: 'Código desconhecido' };
  if (!galeriaPendente(meta) && !forcar) {
    return { success: true, jaEnviado: true, pendente: false, codigo: c, fotos: (meta.fotos || []).length, manifestoEnviado: true };
  }
  galeriaLocks.add(c);
  const ftp = getFtpConfig();
  let falhou = false;
  let ultimoErro = '';
  try {
    if (!ftp.host || !ftp.user) throw new Error('Envio digital não configurado (FTP)');
    meta = lerGaleriaMeta(c); // relê (pode ter recebido foto nova enquanto esperava)
    for (const foto of meta.fotos || []) {
      if (foto.enviadoEm) continue;
      try {
        const file = path.join(galeriaCodigoDir(c), `${foto.seq}.jpg`);
        const buffer = fs.readFileSync(file);
        await ftpUpload({ host: ftp.host, port: ftp.port, user: ftp.user, pass: ftp.pass, folder: ftp.folder, filename: galeriaArquivoRemoto(c, foto.seq), buffer });
        foto.enviadoEm = Date.now();
        foto.erro = '';
        salvarGaleriaMeta(meta);
      } catch (e) {
        falhou = true;
        ultimoErro = (e && e.message) || String(e);
        foto.erro = ultimoErro;
        salvarGaleriaMeta(meta);
        break; // sem internet: para aqui e tenta de novo no próximo ciclo
      }
    }
    const fotos = meta.fotos || [];
    const todasOk = !!meta.finalizadoEm && fotos.length > 0
      && fotos.length >= Number(meta.total || 0) && fotos.every((f) => f.enviadoEm);
    if (!falhou && todasOk && !meta.manifestoEnviadoEm) {
      const manifesto = {
        codigo: c,
        criadoEm: meta.criadoEm || Date.now(),
        pedidoId: meta.pedidoId || null,
        total: fotos.length,
        fotos: fotos.map((f) => ({ seq: f.seq, arquivo: galeriaArquivoRemoto(c, f.seq) })),
      };
      try {
        await ftpUpload({ host: ftp.host, port: ftp.port, user: ftp.user, pass: ftp.pass, folder: ftp.folder, filename: `${c}.json`, buffer: Buffer.from(JSON.stringify(manifesto), 'utf-8') });
        meta.manifestoEnviadoEm = Date.now();
        meta.ultimoErro = '';
        salvarGaleriaMeta(meta);
        console.log(`[natal-core] Envio digital OK: ${c} (${fotos.length} foto${fotos.length === 1 ? '' : 's'})`);
        emit('galeria:enviado', { codigo: c, fotos: fotos.length });
      } catch (e) {
        falhou = true;
        ultimoErro = (e && e.message) || String(e);
      }
    }
  } catch (e) {
    falhou = true;
    ultimoErro = (e && e.message) || String(e);
  } finally {
    galeriaLocks.delete(c);
  }
  meta = lerGaleriaMeta(c) || meta;
  meta.atualizadoEm = Date.now();
  meta.ultimoEnvioEm = Date.now();
  meta.tentativas = (meta.tentativas || 0) + (falhou ? 1 : 0);
  if (falhou) {
    meta.ultimoErro = ultimoErro;
    console.warn(`[natal-core] Envio digital pendente (${c}): ${ultimoErro}`);
  }
  salvarGaleriaMeta(meta);
  return {
    success: !falhou && !!meta.manifestoEnviadoEm,
    codigo: c,
    pendente: galeriaPendente(meta),
    fotos: (meta.fotos || []).length,
    enviadas: (meta.fotos || []).filter((f) => f.enviadoEm).length,
    manifestoEnviado: !!meta.manifestoEnviadoEm,
    error: falhou ? ultimoErro : undefined,
  };
}

async function sincronizarGaleriasPendentes() {
  if (_galeriaWorkerRodando) return;
  _galeriaWorkerRodando = true;
  try {
    for (const meta of listarGalerias()) {
      if (!galeriaPendente(meta)) continue;
      try { await sincronizarGaleria(meta.codigo); } catch {}
    }
  } finally {
    _galeriaWorkerRodando = false;
  }
}

function galeriaReceberFoto(codigo, seq, buffer) {
  const c = String(codigo || '').toUpperCase();
  if (!galeriaCodigoValido(c)) return { error: 'Código inválido' };
  if (!Number.isFinite(seq) || seq < 1 || seq > 50) return { error: 'Sequência inválida' };
  if (!buffer || !buffer.length) return { error: 'Imagem vazia' };
  const dir = galeriaCodigoDir(c);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${seq}.jpg`), buffer);
  const meta = lerGaleriaMeta(c) || {
    codigo: c, criadoEm: Date.now(), pedidoId: null, total: 0,
    fotos: [], manifestoEnviadoEm: null, tentativas: 0, ultimoErro: '',
  };
  meta.fotos = Array.isArray(meta.fotos) ? meta.fotos : [];
  const existente = meta.fotos.find((f) => f.seq === seq);
  if (existente) {
    existente.enviadoEm = null; // reenvio (ex.: "Tentar novamente")
    existente.erro = '';
  } else {
    meta.fotos.push({ seq, enviadoEm: null, erro: '' });
    if (meta.manifestoEnviadoEm) meta.manifestoEnviadoEm = null; // manifesto precisa incluir a nova foto
  }
  meta.fotos.sort((a, b) => a.seq - b.seq);
  meta.atualizadoEm = Date.now();
  salvarGaleriaMeta(meta);
  return { meta };
}

// ─── Impressão ASK-400 ───────────────────────────────────────
// FILA PERSISTENTE de impressão: quando a impressora está desligada, o pedido
// PAGO fica enfileirado (fila-impressao.json) e um worker (a cada 15s + kick no
// enfileiramento e no /api/printer/status) retoma SOZINHO assim que a impressora
// voltar — inclusive depois de reiniciar o app. Nada mais fica dependendo de
// modal/clique do operador para a foto sair.
const JAVA_PRINTER_URL = 'http://localhost:8080/kws/v1/printer/print2';
const JAVA_CHECK_URL = 'http://localhost:8080/kws/v1/kiosk/checkPrinter';
const FILA_SCAN_MS = 15000;

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
let filaImpressao = (() => {
  const arr = readJson(FILA_IMPRESSAO_FILE, []);
  return Array.isArray(arr) ? arr.filter((j) => j && j.pedidoId) : [];
})();
let _workerRodando = false;
function saveFila() {
  try { writeJson(FILA_IMPRESSAO_FILE, filaImpressao); } catch (e) { console.warn('[natal-core] falha ao salvar fila:', e.message); }
}
// Impressora REAL respondendo (Java sidecar porta 8080 → checkPrinter).
async function impressoraOnline() {
  try {
    const resp = await fetch(JAVA_CHECK_URL, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return false;
    const json = await resp.json();
    return !!(json && json.status === 'OK' && Array.isArray(json.retorno) && json.retorno.length);
  } catch { return false; }
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

// Roda o pipeline de impressão de um pedido. Retorna true se TODAS as fotos
// saíram (ribbon consumido, pedido IMPRESSO, sessão FINALIZADA). Retorna false
// se falhou NO MEIO (erro real de hardware/ribbon — o worker NÃO re-tenta sozinho
// pra não imprimir foto duplicada; o modal de erro continua no PDV).
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
    return true;
  } catch (e) {
    console.error(`[natal-core] Falha na impressao do pedido ${pedidoId}: ${e.message}`);
    emit('print-complete', { pedidoId, success: false, error: `Falha Java sidecar: ${e.message}` });
    return false;
  }
}

// Enfileira um pedido PAGO pra impressão (upsert por pedidoId — idempotente).
function enfileirarImpressao(pedido, fotos) {
  const pedidoId = String(pedido.id);
  let job = filaImpressao.find((j) => j.pedidoId === pedidoId);
  if (job) {
    job.fotos = fotos;
    job.estado = 'PENDENTE'; // reenviado manualmente → volta pra fila
    job.tentadoEm = null;
  } else {
    filaImpressao.push({
      pedidoId,
      numero: pedido.numero,
      sessaoId: pedido.sessaoId || null,
      fotos,
      estado: 'PENDENTE',
      tries: 0,
      criadoEm: Date.now(),
      tentadoEm: null,
    });
  }
  saveFila();
}

// Worker da fila: pega o PENDENTE mais antigo. Impressora offline → mantém na
// fila (emite print-waiting pro PDV mostrar "na fila", sem modal). Online →
// imprime e, no sucesso, remove o job. Falha no meio → job FALHOU (não re-tenta).
async function processarFila() {
  if (_workerRodando) return;
  _workerRodando = true;
  try {
    const job = filaImpressao.find((j) => j.estado === 'PENDENTE');
    if (!job) return;
    if (pedidosImprimindo.has(job.pedidoId)) return;
    const pendentes = filaImpressao.filter((j) => j.estado === 'PENDENTE').length;
    if (!(await impressoraOnline())) {
      emit('print-waiting', { qtd: pendentes });
      return;
    }
    const pedido = pedidos.find((p) => p.id === job.pedidoId || String(p.numero) === job.pedidoId);
    if (!pedido || pedido.status !== 'PAGO') {
      filaImpressao = filaImpressao.filter((j) => j !== job);
      saveFila();
      return;
    }
    pedido.fotos = job.fotos;
    savePedidos();
    job.estado = 'IMPRIMINDO';
    job.tentadoEm = Date.now();
    job.tries++;
    saveFila();
    pedidosImprimindo.add(job.pedidoId);
    try {
      const ok = await runPrintPipeline(pedido);
      if (ok) {
        filaImpressao = filaImpressao.filter((j) => j !== job);
        saveFila();
      } else {
        job.estado = 'FALHOU';
        saveFila();
      }
    } finally {
      pedidosImprimindo.delete(job.pedidoId);
    }
  } finally {
    _workerRodando = false;
  }
}
function kickFila() { setImmediate(() => processarFila().catch(() => {})); }
setInterval(() => { processarFila().catch(() => {}); }, FILA_SCAN_MS);

// Lista resumida da fila pro modal ⚙ do PDV (limpeza de impressão).
function filaParaUI() {
  return filaImpressao.map((j) => ({
    pedidoId: j.pedidoId,
    numero: j.numero,
    sessaoId: j.sessaoId,
    fotos: (j.fotos || []).length,
    estado: j.estado,
    tries: j.tries || 0,
    criadoEm: j.criadoEm || null,
  }));
}
// Limpa 1 job ou todos os jobs da fila. Jobs IMPRIMINDO (saindo agora) NÃO são
// removidos — evita foto pela metade. Remove também a pasta de fotos do print-queue.
function limparFila(opts = {}) {
  const alvo = String(opts.pedidoId || '').trim();
  const todos = opts.todos === true;
  const removidos = [];
  filaImpressao = filaImpressao.filter((j) => {
    if (j.estado === 'IMPRIMINDO') return true; // nunca remove o que está saindo
    if (todos) { removidos.push(j); return false; }
    if (alvo && (j.pedidoId === alvo || String(j.numero) === alvo)) { removidos.push(j); return false; }
    return true;
  });
  saveFila();
  for (const j of removidos) {
    const dir = path.join(PRINT_QUEUE_DIR, sanitizeSegment(j.pedidoId));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
  const pendentes = filaImpressao.filter((j) => j.estado === 'PENDENTE').length;
  emit('print-fila:atualizada', { qtd: pendentes, removidos: removidos.length });
  return { success: true, removidos: removidos.map((j) => j.pedidoId), qtd: pendentes };
}

// ─── Manutenção: limpar todos os dados de teste do PDV ───────
// Usado pelo botão "Limpar dados" no ⚙ Config (protegido por senha). Faz
// backup do database/ antes, apaga sessões (com as fotos), pedidos, caixa,
// fila de impressão, auditoria e contador de ribbon, e RECARREGA o estado em
// memória — o app aberto continua funcionando e já nasce sem caixa aberto.
// database\config.json é preservado: machineId/kioskCode (pareamento) sobrevivem.
function limparDadosLocais(opts = {}) {
  const aberto = requireCaixaAberto();
  if (aberto && opts.forcar !== true) {
    return {
      success: false,
      error: 'CAIXA_ABERTO',
      message: `Há um caixa aberto (${aberto.numero || aberto.id}). Feche o caixa antes de limpar os dados.`,
      caixa: { id: aberto.id, numero: aberto.numero || null },
    };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupDir = path.join(path.dirname(DATA_DIR), `${path.basename(DATA_DIR)}-backup-${stamp}`);
  const resumo = {
    sessoes: (() => { try { return fs.readdirSync(SESSOES_DIR).length; } catch { return 0; } })(),
    pedidos: pedidos.length,
    auditoria: auditoria.length,
    filaImpressao: filaImpressao.length,
    filaPortal: filaPortal.length,
    caixaAberto: !!(aberto && aberto.numero),
    ribbon: getRibbon(),
    em: new Date().toISOString(),
  };

  // Backup: só o database/ (JSONs e contadores são leves). As fotos das
  // sessões não são copiadas — são descartadas junto com as sessões de teste.
  try {
    fs.mkdirSync(backupDir, { recursive: true });
    if (fs.existsSync(DB_DIR)) fs.cpSync(DB_DIR, path.join(backupDir, 'database'), { recursive: true });
    fs.writeFileSync(path.join(backupDir, 'resumo.json'), JSON.stringify(resumo, null, 2), 'utf-8');
  } catch (e) {
    return { success: false, error: 'BACKUP', message: 'Não consegui criar o backup: ' + (e.message || e) };
  }

  // Apaga as pastas e recria vazias (o sidecar e o PDV esperam que existam).
  for (const dir of [SESSOES_DIR, PEDIDOS_DIR, PRINT_QUEUE_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.mkdirSync(DB_DIR, { recursive: true });

  // Zera os arquivos. caixa.json some junto: o PDV passa a pedir "abrir caixa".
  writeJson(PEDIDOS_FILE, []);
  writeJson(CAIXAS_FILE, []);
  writeJson(AUDITORIA_FILE, []);
  writeJson(PASTA_IMPORTADAS_FILE, {});
  writeJson(FILA_IMPRESSAO_FILE, []);
  writeJson(FILA_PORTAL_FILE, []);
  writeJson(CACHE_PORTAL_FILE, {});
  writeJson(ENVIADOS_PORTAL_FILE, {});
  writeText(COUNTER_FILE, '0');
  writeText(RIBBON_FILE, '400');
  try { fs.rmSync(CAIXA_FILE, { force: true }); } catch {}

  pedidosImprimindo.clear();
  recarregarEstadoLocal();

  console.log(`[natal-core] DADOS LIMPOS (backup em ${backupDir}):`, JSON.stringify(resumo));
  emit('dados:limpos', resumo);
  return { success: true, ...resumo, backup: backupDir, ribbon: getRibbon() };
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
      return sendJson(res, 200, { ok: true, pdv: machineConfig.pdvNome || os.hostname(), time: Date.now(), ribbon: getRibbon(), filaPortal: filaPortal.length, build: BUILD_ID, pid: process.pid });
    }
    if (method === 'GET' && p === '/api/config') {
      return sendJson(res, 200, configPublica());
    }
    // Status real da impressora ASK-400 (proxy do Java sidecar na porta 8080)
    if (method === 'GET' && p === '/api/printer/status') {
      let status = { connected: false, paper10x15: null, paper15x20: null, lastError: null };
      try {
        const resp = await fetch('http://localhost:8080/kws/v1/kiosk/checkPrinter', {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        });
        if (resp.ok) {
          const json = await resp.json();
          if (json.status === 'OK' && Array.isArray(json.retorno) && json.retorno.length) {
            const info = json.retorno[0];
            status = {
              connected: true,
              paper10x15: info.paperRemainHalfSize != null ? Number(info.paperRemainHalfSize) : null,
              paper15x20: info.paperRemain != null ? Number(info.paperRemain) : null,
              lastError: info.lastError || null,
            };
          } else {
            status.lastError = 'Impressora sem resposta (desligada ou sem papel)';
          }
        } else {
          status.lastError = 'HTTP ' + resp.status;
        }
      } catch (e) {
        status.lastError = e.message || String(e);
      }
      if (status.connected && filaImpressao.some((j) => j.estado === 'PENDENTE')) kickFila(); // impressora voltou → retoma a fila já
      return sendJson(res, 200, { success: true, ...status, source: 'ask400' });
    }
    // Fila de impressão: listar (pro modal ⚙) e limpar (1 pedido ou todos).
    if (method === 'GET' && p === '/api/printer/fila') {
      return sendJson(res, 200, { success: true, fila: filaParaUI() });
    }
    if (method === 'POST' && p === '/api/printer/fila/limpar') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      if (!body.todos && !String(body.pedidoId || '').trim()) {
        return sendJson(res, 400, { success: false, error: 'Informe pedidoId ou todos:true' });
      }
      return sendJson(res, 200, limparFila(body));
    }
    if (method === 'POST' && p === '/api/config') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      setMachineConfig(body);
      return sendJson(res, 200, { success: true, config: configPublica() });
    }
    // ── Importador de fotos do cartao (Pegar_Fotos headless) ──
    // Proxy do /api/status do importador (porta 8099) + sessoes ja criadas por
    // lote. O PDV usa isso na aba "Cartao" e no chip da topbar.
    if (method === 'GET' && p === '/api/import/status') {
      const importFolder = getImportFolder();
      let importer = null;
      try {
        const resp = await fetch('http://127.0.0.1:8099/api/status', {
          headers: { Accept: 'application/json' },
          signal: AbortSignal.timeout(1500),
        });
        if (resp.ok) importer = await resp.json();
      } catch {}
      const sessoes = {};
      for (const [abs, reg] of Object.entries(pastaImportadas)) {
        if (reg && typeof reg === 'object' && reg.id) sessoes[path.basename(abs)] = reg.id;
      }
      return sendJson(res, 200, {
        success: true,
        online: !!(importer && importer.ok),
        importFolder,
        importSessoes: machineConfig.importSessoes !== false,
        importer: importer || null,
        sessoes,
      });
    }
    // Botao "Procurar agora" da aba Cartao: forca o importador a buscar o cartao.
    if (method === 'POST' && p === '/api/import/sincronizar') {
      let ok = false;
      let erro = null;
      try {
        const resp = await fetch('http://127.0.0.1:8099/api/sync-now', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(8000),
        });
        ok = resp.ok;
        if (!resp.ok) erro = 'HTTP ' + resp.status;
      } catch (e) {
        erro = e.message || String(e);
      }
      return sendJson(res, ok ? 200 : 502, { success: ok, error: erro });
    }

    // ── Outbox do portal (fila durável de envio) ──────────────
    // O PDV enfileira aqui tudo que precisa registrar no portal e só
    // remove quando o portal confirma. Sem internet, a fila só cresce.
    if (method === 'GET' && p === '/api/portal/fila') {
      // enviadosAt: quando cada chave foi confirmada (ms). Usado pelo PDV para
      // saber se um registro antigo mudou DEPOIS do último envio (ex.: um dia
      // cujo pedido foi cancelado depois do snapshot já ter subido).
      const enviadosAt = {};
      for (const [k, v] of Object.entries(enviadosPortal)) {
        enviadosAt[k] = v && typeof v === 'object' ? Number(v.em || 0) : Number(v || 0);
      }
      return sendJson(res, 200, {
        success: true,
        itens: filaPortalParaUI(),
        total: filaPortal.length,
        enviados: Object.keys(enviadosPortal),
        enviadosAt,
      });
    }
    if (method === 'POST' && p === '/api/portal/fila') {
      const body = JSON.parse((await readBody(req, 8 * 1024 * 1024)).toString() || '{}');
      const r = enfileirarPortal({ tipo: body.tipo, chave: body.chave, payload: body.payload });
      if (!r) return sendJson(res, 400, { success: false, error: 'DADOS_INCOMPLETOS: tipo e chave são obrigatórios' });
      return sendJson(res, 200, {
        success: true,
        id: r.item ? r.item.id : null,
        criado: r.criado,
        inalterado: !!r.inalterado,
        total: filaPortal.length,
      });
    }
    if (method === 'POST' && p === '/api/portal/fila/confirmar') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      return sendJson(res, 200, confirmarPortal(body));
    }
    if (method === 'POST' && p === '/api/portal/fila/erro') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      const r = erroPortal(body);
      return sendJson(res, r.success ? 200 : 404, r);
    }
    if (method === 'POST' && p === '/api/portal/fila/limpar') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      if (!senhaConfere(body.senha)) {
        return sendJson(res, 401, { success: false, error: 'SENHA', message: 'Senha incorreta.' });
      }
      const total = filaPortal.length;
      filaPortal = [];
      saveFilaPortal();
      emit('portal:fila', { total: 0 });
      return sendJson(res, 200, { success: true, removidos: total });
    }
    // Zera o registro do que já foi enviado → o PDV reenvia tudo ao portal.
    if (method === 'POST' && p === '/api/portal/enviados/limpar') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      if (!senhaConfere(body.senha)) {
        return sendJson(res, 401, { success: false, error: 'SENHA', message: 'Senha incorreta.' });
      }
      const total = Object.keys(enviadosPortal).length;
      enviadosPortal = {};
      saveEnviadosPortal();
      return sendJson(res, 200, { success: true, removidos: total });
    }

    // ── Cache local do portal (preços, equipe, credenciais) ────
    if (method === 'GET' && p === '/api/cache/portal') {
      return sendJson(res, 200, { success: true, cache: cachePortal });
    }
    if (method === 'POST' && p === '/api/cache/portal') {
      const body = JSON.parse((await readBody(req, 4 * 1024 * 1024)).toString() || '{}');
      const cache = mesclarCachePortal(body);
      return sendJson(res, 200, { success: true, cache });
    }
    // Conferência de credencial em cache (login offline). Não expõe hash.
    if (method === 'POST' && p === '/api/cache/portal/conferir') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      return sendJson(res, 200, { success: true, ok: conferirCredencialCache(body.usuario, body.senha) });
    }
    // Manutenção: limpa TODOS os dados de teste do PDV (senha obrigatória).
    if (method === 'POST' && p === '/api/manutencao/limpar') {
      const body = JSON.parse((await readBody(req, 64 * 1024)).toString() || '{}');
      if (!senhaConfere(body.senha)) {
        return sendJson(res, 401, { success: false, error: 'SENHA', message: 'Senha incorreta.' });
      }
      return sendJson(res, 200, limparDadosLocais(body));
    }

    // ── Envio digital (galeria pública /natal) ─────────────────
    // O PDV manda: POST /api/galeria/upload/<CODIGO>/<seq> (JPEG binário) por
    // foto e depois POST /api/galeria/finalizar/<CODIGO> { total, pedidoId }.
    // O manifesto só sobe depois de todas as fotos → a página nunca mostra
    // uma venda pela metade. Sem FTP, fica em fila local e reenvia sozinho.
    const galeriaUpload = p.match(/^\/api\/galeria\/upload\/([^/]+)\/([^/]+)$/);
    if (method === 'POST' && galeriaUpload) {
      const codigo = String(galeriaUpload[1] || '').toUpperCase();
      const seq = parseInt(galeriaUpload[2], 10);
      const buffer = await readBody(req);
      const r = galeriaReceberFoto(codigo, seq, buffer);
      if (r.error) return sendJson(res, 400, { success: false, error: r.error });
      const sync = await sincronizarGaleria(codigo);
      return sendJson(res, 200, { success: true, salvo: true, ...sync });
    }
    const galeriaFinalizar = p.match(/^\/api\/galeria\/finalizar\/([^/]+)$/);
    if (method === 'POST' && galeriaFinalizar) {
      const codigo = String(galeriaFinalizar[1] || '').toUpperCase();
      if (!galeriaCodigoValido(codigo)) return sendJson(res, 400, { success: false, error: 'Código inválido' });
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      const meta = lerGaleriaMeta(codigo);
      if (!meta) return sendJson(res, 404, { success: false, error: 'Código desconhecido' });
      meta.total = Math.max(Number(body.total || 0) || 0, (meta.fotos || []).length);
      meta.finalizadoEm = meta.finalizadoEm || Date.now();
      if (body.pedidoId) meta.pedidoId = String(body.pedidoId);
      meta.atualizadoEm = Date.now();
      salvarGaleriaMeta(meta);
      const sync = await sincronizarGaleria(codigo, { forcar: true });
      return sendJson(res, 200, { success: true, ...sync });
    }
    if (method === 'GET' && p === '/api/galeria/fila') {
      const itens = listarGalerias().map(galeriaStatusUI);
      const pendentes = itens.filter((i) => i.pendente);
      return sendJson(res, 200, {
        success: true,
        itens,
        pendentes: pendentes.length,
        fotosPendentes: pendentes.reduce((s, i) => s + (i.fotos - i.enviadas), 0),
        urlBase: getFtpConfig().galeriaUrl,
      });
    }
    if (method === 'POST' && p === '/api/galeria/fila/sincronizar') {
      let body = {};
      try {
        const raw = await readBody(req, 64 * 1024);
        if (raw.length) body = JSON.parse(raw.toString('utf-8') || '{}');
      } catch {}
      const codigo = String(body.codigo || '').trim().toUpperCase();
      if (codigo && galeriaCodigoValido(codigo)) {
        await sincronizarGaleria(codigo); // só o código pedido (respeita o que já subiu)
      } else {
        await sincronizarGaleriasPendentes();
      }
      const itens = listarGalerias().map(galeriaStatusUI);
      return sendJson(res, 200, { success: true, itens, pendentes: itens.filter((i) => i.pendente).length });
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
        // nomes de arquivo são únicos por sessão e nunca mudam: cache longo evita
        // revalidar/re-baixar o mesmo JPEG a cada render (perf com 1000+ fotos/dia)
        'Cache-Control': 'public, max-age=604800, immutable',
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
        id: `PED-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`,
        numero,
        sessaoId: sessao.id,
        // Multi-sessão: todas as sessões que participaram do pedido (a 1ª é a
        // sessaoId). O PDV usa essa lista no push ao portal (pedido.push).
        sessoes: (Array.isArray(body.sessoes) && body.sessoes.length)
          ? body.sessoes.map((s) => ({ id: String((s && s.id) || s) }))
          : [{ id: sessao.id }],
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
      if (caixa.pedidos && !caixa.pedidos.includes(pedido.id)) caixa.pedidos.push(pedido.id);
      saveCaixa();
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
      if (pedido.status !== 'AGUARDANDO') {
        return sendJson(res, 409, { success: false, error: 'Pedido ja foi pago/cancelado' });
      }
      if (Array.isArray(body.pagamentos) && body.pagamentos.length) {
        const pgs = body.pagamentos
          .filter((pg) => pg && Number(pg.valor) > 0)
          .map((pg) => ({
            meio: String(pg.meio || ''),
            valor: Number(pg.valor),
            parcelas: pg.parcelas ? Number(pg.parcelas) : undefined,
          }));
        const somaPaga = pgs.reduce((s, pg) => s + pg.valor, 0);
        if (Math.abs(somaPaga - Number(pedido.total || 0)) > 0.005) {
          return sendJson(res, 400, { success: false, error: `Soma dos pagamentos (${somaPaga.toFixed(2)}) diferente do total (${Number(pedido.total || 0).toFixed(2)})` });
        }
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

    // Atualização de correções pós-pagamento feitas no PDV (cobrança de
    // diferença, correção da forma de pagamento, cancelamento com devolução).
    // Persiste no sidecar para sobreviver a restart e mantém o portal coerente.
    const pedidoPut = p.match(/^\/api\/pedidos\/([^/]+)$/);
    if (method === 'PUT' && pedidoPut) {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      const idx = pedidos.findIndex((x) => x.id === pedidoPut[1] || String(x.numero) === pedidoPut[1]);
      if (idx < 0) return sendJson(res, 404, { success: false, error: 'Pedido nao encontrado' });
      const pedido = pedidos[idx];
      if (typeof body.total === 'number' && Number.isFinite(body.total)) {
        pedido.total = Number(+body.total.toFixed(2));
      }
      if (Array.isArray(body.pagamentos)) {
        const pgs = body.pagamentos
          .filter((pg) => pg && Number(pg.valor) > 0)
          .map((pg) => ({
            meio: String(pg.meio || ''),
            valor: Number(pg.valor),
            parcelas: pg.parcelas ? Number(pg.parcelas) : undefined,
          }));
        pedido.pagamentos = pgs;
        pedido.meio = pgs.length === 1 ? pgs[0].meio : 'MULTI';
      }
      if (Array.isArray(body.itens)) pedido.itens = body.itens;
      if (Array.isArray(body.produtos)) pedido.produtos = body.produtos;
      if (body.desconto !== undefined) pedido.desconto = body.desconto || null;
      if (typeof body.guiaImpressa === 'boolean') pedido.guiaImpressa = body.guiaImpressa;
      if (body.codigoDigital !== undefined) pedido.codigoDigital = body.codigoDigital ? String(body.codigoDigital) : null;
      if (Array.isArray(body.sessoes) && body.sessoes.length) {
        pedido.sessoes = body.sessoes.map((s) => ({ id: String((s && s.id) || s) }));
      }
      if (typeof body.status === 'string') {
        const st = body.status.toUpperCase();
        if (['AGUARDANDO', 'PAGO', 'IMPRESSO', 'CANCELADO'].includes(st)) {
          pedido.status = st;
          if (st === 'CANCELADO') pedido.canceladoEm = Date.now();
        }
      }
      pedidos[idx] = pedido;
      savePedidos();
      emit('pedido:atualizado', { pedidoId: pedido.id, status: pedido.status, total: pedido.total });
      return sendJson(res, 200, { success: true, pedido });
    }

    // ── Auditoria (usos de senha master) — persistência local ──
    if (method === 'GET' && p === '/api/auditoria') {
      return sendJson(res, 200, { success: true, usos: [...auditoria].sort((a, b) => String(b.id).localeCompare(String(a.id))) });
    }
    if (method === 'POST' && p === '/api/auditoria') {
      const body = JSON.parse((await readBody(req, 1024 * 1024)).toString() || '{}');
      if (!body || !Array.isArray(body.usos)) {
        return sendJson(res, 400, { success: false, error: 'Esperado { usos: [...] }' });
      }
      body.usos.forEach((u) => {
        if (!u || !u.id) return;
        const idx = auditoria.findIndex((x) => x.id === u.id);
        if (idx >= 0) auditoria[idx] = u; else auditoria.push(u);
      });
      saveAuditoria();
      return sendJson(res, 200, { success: true, total: auditoria.length });
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

    // Iniciar impressão de um pedido PAGO (enfileira na fila persistente)
    const imprimirMatch = p.match(/^\/api\/pedidos\/([^/]+)\/imprimir$/);
    if (method === 'POST' && imprimirMatch) {
      const body = JSON.parse((await readBody(req, 5 * 1024 * 1024)).toString() || '{}');
      const pedido = pedidos.find((x) => x.id === imprimirMatch[1] || String(x.numero) === imprimirMatch[1]);
      if (!pedido) return sendJson(res, 404, { success: false, error: 'Pedido nao encontrado' });
      if (pedido.status !== 'PAGO') return sendJson(res, 400, { success: false, error: 'Pedido nao pago' });
      const fotos = Array.isArray(body.fotos) ? body.fotos : [];
      if (!fotos.length) return sendJson(res, 400, { success: false, error: 'Nenhuma foto para imprimir' });
      pedido.fotos = fotos;
      savePedidos();
      // Se já está IMPRIMINDO agora, ignora (não duplica); se está aguardando,
      // atualiza as fotos e mantém. O worker resolve o resto.
      const jaAtivo = pedidosImprimindo.has(pedido.id);
      if (!jaAtivo) enfileirarImpressao(pedido, fotos);
      kickFila(); // online → imprime já; offline → fica na fila e o worker retoma
      return sendJson(res, 200, { success: true, enfileirado: !jaAtivo });
    }

    // ── Caixa ──
    if (method === 'GET' && p === '/api/pdv/caixa') {
      return sendJson(res, 200, { success: true, caixa: caixa });
    }
    if (method === 'GET' && p === '/api/pdv/caixas') {
      const historico = [...caixas].sort((a, b) => (b.fechadoEm || 0) - (a.fechadoEm || 0));
      return sendJson(res, 200, { success: true, caixas: historico });
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
      const totalVendido = pedidosDoCaixa
        .filter((x) => x.status === 'PAGO')
        .reduce((acc, x) => acc + x.total, 0);
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
      const valorEnvelope = Number(body.valorEnvelope || 0);
      const fechadoPor = String(body.fechadoPor || caixa.operador || '');
      caixa = {
        ...caixa,
        numero: caixas.length + 1,
        fechadoEm: Date.now(),
        totalVendido,
        totalPorMeio,
        meiosDeclarados: meios,
        totalRecebido,
        diferenca: Number((totalRecebido - totalVendido).toFixed(2)),
        valorEnvelope,
        saldoRestante: Number(((meios['dinheiro'] || 0) - valorEnvelope).toFixed(2)),
        fechadoPor,
        observacoes: body.observacoes || '',
      };
      arquivarCaixa(caixa);
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
  if (machineConfig.photosFolder) {
    console.log(`[natal-core] Importador de pasta ativo: ${machineConfig.photosFolder}`);
  }
  ensurePhotosWatcher();
  kickFila(); // fila persistente do disco → retoma impressões que ficaram pra trás
  sincronizarGaleriasPendentes().catch(() => {}); // envio digital que ficou na fila offline
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

// Reenvio automático das fotos digitais que ficaram sem internet na venda.
setInterval(() => { sincronizarGaleriasPendentes().catch(() => {}); }, GALERIA_SYNC_MS);

// Se o pai (electron-main) morrer, o stdin fecha -> sai junto (evita orphan).
process.stdin.on('end', () => {
  console.log('[natal-core] stdin fechado (pai encerrado), saindo...');
  process.exit(0);
});
