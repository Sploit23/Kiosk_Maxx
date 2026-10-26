const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const isDev = !app.isPackaged;
let mainWindow = null;
let sidecarProcess = null;
let javaProcess = null;

// ─── Single Instance ────────────────────────────────────────
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

// ─── Paths ──────────────────────────────────────────────────
function getResourcePath(relativePath) {
  if (app.isPackaged) return path.join(process.resourcesPath, relativePath);
  return path.join(__dirname, relativePath);
}
function getSidecarPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'natal-core.cjs');
  return path.join(__dirname, 'sidecar', 'natal-core.cjs');
}

// ─── Config (fora do pacote em produção) ────────────────────
const CONFIG_PATH = app.isPackaged
  ? path.join('C:', 'ProgramData', 'MaxxNatal', 'electron-config.json')
  : path.join(__dirname, 'electron-config.json');

let config = {};
function loadConfig() {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    try {
      config = JSON.parse(fs.readFileSync(path.join(__dirname, 'electron-config.template.json'), 'utf-8'));
    } catch {
      config = {};
    }
  }
}
loadConfig();

// Instalacao nova chega sem pasta de fotos e o importador do cartao nunca
// subia ("Pasta de fotos ainda nao configurada"), deixando o PC sem receber
// nada. Documentos\Natal_Recebidas funciona sem senha e pode ser trocada no
// ⚙ Config > Sistema (a pasta escolhida continua tendo prioridade).
function aplicarPastaDeFotosPadrao() {
  if (String(config.photosFolder || '').trim()) return;
  let docs = '';
  try { docs = app.getPath('documents'); } catch {}
  if (!docs) docs = path.join(process.env.USERPROFILE || '', 'Documents');
  const pasta = path.join(docs, 'Natal_Recebidas');
  try {
    fs.mkdirSync(pasta, { recursive: true });
  } catch (e) {
    console.warn(`[Config] nao consegui criar a pasta padrao ${pasta}: ${(e && e.message) || e}`);
    return;
  }
  config.photosFolder = pasta;
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
  } catch (e) {
    // Sem permissao de escrita a pasta ainda vale para esta sessao (env abaixo).
    console.warn(`[Config] nao consegui gravar ${CONFIG_PATH}: ${(e && e.message) || e}`);
  }
  logMain(`[Config] pasta de fotos padrao: ${pasta}`);
}

// ─── 1. Sidecar servidor (natal-core.cjs) ───────────────────
const SIDECAR_MAX_RESTARTS = 5;
let sidecarRestartCount = 0;

function isPortInUse(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(1500);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('error', () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

// Hash do natal-core.cjs no disco (12 chars) — mesmo cálculo do BUILD_ID
// embutido no sidecar. Comparar os dois detecta instância ANTIGA na porta.
function localSidecarBuild(sidecarPath) {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(sidecarPath)).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

// GET /api/health da instância que já está na porta (null se não responder).
function fetchSidecarHealth(port, host = '127.0.0.1', timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: '/api/health', timeout }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 4096) { req.destroy(); resolve(null); } });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// PID do processo que escuta na porta (Windows: netstat -ano). Usado só quando
// o health não devolve o pid (sidecar antigo ou porta de outro programa).
function pidListeningOn(port) {
  try {
    const { execSync } = require('child_process');
    const out = execSync(`netstat -ano -p tcp`, { encoding: 'utf8', timeout: 4000 });
    const alvo = `:${port}`;
    for (const linha of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(linha)) continue;
      const cols = linha.trim().split(/\s+/);
      if (cols.length < 5) continue;
      if (cols[1] !== `0.0.0.0:${port}` && cols[1] !== `[::]:${port}` && cols[1] !== `127.0.0.1:${port}`) continue;
      const pid = parseInt(cols[4], 10);
      if (pid && pid !== process.pid) return pid;
    }
  } catch {}
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spawnSidecar(sidecarPath, expectedBuild) {
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    NATAL_DATA_DIR: app.getPath('userData'),
    NATAL_PHOTOS_FOLDER: (config.photosFolder || '').trim(),
  };
  sidecarProcess = spawn(process.execPath, [sidecarPath], { env, windowsHide: true });
  sidecarProcess.stdout.on('data', (d) => console.log(`[Sidecar] ${d}`.trim()));
  sidecarProcess.stderr.on('data', (d) => console.error(`[Sidecar] ${d}`.trim()));
  sidecarProcess.on('close', (code) => {
    console.warn(`[Sidecar] Finalizado com codigo ${code}`);
    sidecarProcess = null;
    if (code !== 0 && code !== null) {
      sidecarRestartCount++;
      setTimeout(startSidecar, 3000);
    }
  });
  // Guarda pós-spawn: se em 4s a porta não subir (ou subir com build antigo),
  // mata e tenta de novo — nunca fica conversando com sidecar desatualizado.
  // O relançamento é agendado AQUI (e não no close): kill no Windows fecha o
  // filho com code=null, e o handler de close só relança em code !== 0.
  if (expectedBuild) {
    setTimeout(async () => {
      if (!sidecarProcess) return;
      const h = await fetchSidecarHealth(9877);
      if (!h || (h.build && h.build !== expectedBuild)) {
        console.warn('[Sidecar] Instancia nova nao respondeu com o build atual. Relancando...');
        sidecarRestartCount++;
        const proc = sidecarProcess;
        try { proc.kill(); } catch {}
        setTimeout(() => startSidecar(), 1500);
      }
    }, 4000);
  }
}

async function startSidecar() {
  const sidecarPath = getSidecarPath();
  if (!fs.existsSync(sidecarPath)) {
    console.warn('[Sidecar] natal-core.cjs nao encontrado.');
    return;
  }
  if (sidecarRestartCount >= SIDECAR_MAX_RESTARTS) return;
  const expectedBuild = localSidecarBuild(sidecarPath);
  const inUse = await isPortInUse(9877);

  if (inUse) {
    const health = await fetchSidecarHealth(9877);
    const sameBuild = health && health.ok && expectedBuild && health.build === expectedBuild;
    if (sameBuild) {
      console.warn('[Sidecar] Porta 9877 ja em uso (instancia identica). Usando a existente.');
      return;
    }
    // Instância na porta é antiga (build diferente), não responde health, ou o
    // disco não bate — reutilizá-la deixaria o PDV sem as rotas novas
    // ("Rota nao encontrada"). Mata o dono da porta e relança com o código atual.
    const motivo = !health ? 'sem resposta' : (!health.ok ? 'health invalido' : `build ${health.build || '?'} != ${expectedBuild || '?'}`);
    const pid = (health && health.pid) || pidListeningOn(9877);
    console.warn(`[Sidecar] Porta 9877 em uso por instancia DESATUALIZADA (${motivo}). Substituindo...`);
    if (pid) {
      try {
        process.kill(pid);
      } catch (e) {
        console.error(`[Sidecar] Nao consegui matar o pid ${pid}: ${e.message}`);
        return;
      }
      for (let i = 0; i < 20; i++) {
        if (!(await isPortInUse(9877))) break;
        await sleep(250);
      }
      if (await isPortInUse(9877)) {
        console.error('[Sidecar] Porta 9877 continua ocupada apos kill. Mantendo a existente.');
        return;
      }
    } else {
      console.error('[Sidecar] Nao identifiquei o pid dono da 9877. Mantendo a existente.');
      return;
    }
  }

  spawnSidecar(sidecarPath, expectedBuild);
}

// ─── 2. Sidecar Java (Fujifilm ASK-400) ─────────────────────
function findJava() {
  const candidates = [
    path.join(getResourcePath('jre8'), 'bin', 'java.exe'),
    path.join(__dirname, 'jre8', 'runtime', 'bin', 'java.exe'),
    'C:\\Program Files (x86)\\Eclipse Adoptium\\jre-8.0.472.8-hotspot\\bin\\java.exe',
    'C:\\Program Files\\Eclipse Adoptium\\jre-8.0.472.8-hotspot\\bin\\java.exe',
    ...(process.env.JAVA_HOME ? [path.join(process.env.JAVA_HOME, 'bin', 'java.exe')] : []),
  ];
  for (const dir of ['C:\\Program Files\\Eclipse Adoptium', 'C:\\Program Files\\Java', 'C:\\Program Files (x86)\\Java']) {
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const exe = path.join(dir, entry, 'bin', 'java.exe');
      if (fs.existsSync(exe)) candidates.push(exe);
    }
  }
  for (const c of candidates) { if (c && fs.existsSync(c)) return c; }
  try {
    return execFileSyncWhere('java');
  } catch { return null; }
}
function execFileSyncWhere(cmd) {
  const { execSync } = require('child_process');
  return execSync(`where ${cmd} 2>nul`, { encoding: 'utf8', timeout: 3000 }).trim().split('\n')[0];
}

function startJavaSidecar() {
  const jarPath = path.join(getResourcePath('impressora'), 'status_ok', 'build', 'sidecar-ask400.jar');
  const javaPath = findJava();
  if (!fs.existsSync(jarPath)) { console.warn('[Java] JAR nao encontrado. Impressora desativada.'); return; }
  if (!javaPath) { console.warn('[Java] JRE nao encontrado.'); return; }
  console.log('[Java] Iniciando sidecar ASK-400...');
  javaProcess = spawn(javaPath, ['-Xmx128m', '-jar', jarPath], { cwd: path.join(getResourcePath('impressora'), 'status_ok') });
  javaProcess.stdout.on('data', (d) => console.log(`[Java] ${d}`.trim()));
  javaProcess.stderr.on('data', (d) => console.error(`[Java] ${d}`.trim()));
  javaProcess.on('close', (code) => { console.log(`[Java] Finalizado (${code})`); javaProcess = null; });
}

// ─── 2b. Importador de fotos do cartao (Pegar_Fotos headless) ─
// Sobe junto do PDV, sem janela. O importador vigia/baixa os lotes do cartao
// (porta 8099 + descoberta UDP 50000) e grava em <photosFolder>\_cartao; o
// sidecar transforma cada lote em sessao. O PDV mostra o status via
// GET /api/import/status (proxy do sidecar).
const IMPORTER_PORT = 8099;
let importerProcess = null;
let importerPid = null;
let importerRestartCount = 0;
let importerStopping = false;
let importerBusy = false;
let importerLastError = '';
let importerWatchdog = null;

function mainLogFile() {
  return path.join(app.getPath('userData'), 'logs', 'main.log');
}

// Log em arquivo: o app empacotado nao tem console, entao sem isso nao da
// para descobrir no PC do evento por que o importador nao subiu.
function logMain(msg) {
  const linha = `[${new Date().toISOString()}] ${msg}`;
  try {
    const file = mainLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.writeFileSync(file, '');
    fs.appendFileSync(file, linha + '\n');
  } catch {}
  console.log(linha);
}

function setImporterError(msg) {
  const texto = String(msg || '');
  if (texto === importerLastError) return;
  importerLastError = texto;
  if (texto) logMain('[Importador] ' + texto);
}

function importerBackoff() {
  return Math.min(3000 + importerRestartCount * 2000, 20000);
}

// PyInstaller onefile roda pai + filho e usa a trava Global\NatalFotoImport.
// Se o filho ficar orfao, a nova instancia sai sozinha (codigo 0) e o PDV fica
// sem importador; aqui derrubamos a instancia presa antes de relancar.
function killAllImporters() {
  if (process.platform !== 'win32') return;
  try {
    spawn('taskkill', ['/IM', 'Natal_Foto_Import.exe', '/T', '/F'], { windowsHide: true });
  } catch {}
}

function getImporterPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'importador', 'Natal_Foto_Import.exe');
  // Build atual = onedir (dist/Natal_Foto_Import/Natal_Foto_Import.exe).
  const onedir = path.join(__dirname, 'tools', 'pegar-fotos', 'dist', 'Natal_Foto_Import', 'Natal_Foto_Import.exe');
  if (fs.existsSync(onedir)) return onedir;
  // Fallback para o exe onefile antigo (quem ainda nao rebuildou o importador).
  return path.join(__dirname, 'tools', 'pegar-fotos', 'dist', 'Natal_Foto_Import.exe');
}
function importerScriptPath() {
  return path.join(__dirname, 'tools', 'pegar-fotos', 'app.py');
}
function importerConfigFile() {
  return path.join(app.getPath('userData'), 'importador-config.json');
}
function importerLogFile() {
  return path.join(app.getPath('userData'), 'logs', 'importador.log');
}

function fetchJson(port, urlPath, host = '127.0.0.1', timeout = 2000) {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: urlPath, timeout }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; if (data.length > 256 * 1024) { req.destroy(); resolve(null); } });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

async function importerStatus() {
  return fetchJson(IMPORTER_PORT, '/api/status', '127.0.0.1', 2500);
}

async function waitImporterReady(proc, timeoutMs) {
  const t0 = Date.now();
  while (!importerStopping && importerProcess === proc && Date.now() - t0 < timeoutMs) {
    const st = await importerStatus();
    if (st && st.ok) {
      importerRestartCount = 0;
      setImporterError('');
      return true;
    }
    await sleep(1500);
  }
  return false;
}

// O exe onefile do PyInstaller pode rodar como pai + filho; matar só o PID
// inicial deixa o filho escutando a porta 8099. No Windows usamos taskkill /T.
function killImporterPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid);
  } catch {}
}

async function resolverImportFolder() {
  const cfg = await fetchJson(9877, '/api/config');
  if (!cfg) return null;
  const base = String(cfg.photosFolder || '').trim();
  if (!base) return null;
  const folder = String(cfg.importFolder || '').trim() || path.join(base, '_cartao');
  return { folder };
}

async function startImporter() {
  if (importerBusy || importerStopping) return;
  importerBusy = true;
  try {
    await startImporterInner();
  } catch (e) {
    setImporterError(`Falha ao iniciar o importador: ${(e && e.message) || e}`);
    setTimeout(startImporter, 15000);
  } finally {
    importerBusy = false;
  }
}

async function startImporterInner() {
  if (importerStopping) return;
  const info = await resolverImportFolder();
  if (!info) {
    // Sidecar ainda subindo ou maquina sem pasta de fotos (wizard). Continua
    // tentando: a pasta pode ser configurada depois sem reiniciar o app.
    setImporterError('Pasta de fotos ainda nao configurada');
    setTimeout(startImporter, 10000);
    return;
  }

  const exe = getImporterPath();
  const script = importerScriptPath();
  const usarExe = fs.existsSync(exe);
  if (!usarExe && !fs.existsSync(script)) {
    setImporterError(`Importador nao encontrado: ${exe} (instalacao incompleta ou antivirus)`);
    setTimeout(startImporter, 30000);
    return;
  }

  // Instancia orfa de uma execucao anterior: adota se estiver na mesma pasta,
  // senao mata para relancar com a config atual.
  const atual = await importerStatus();
  if (atual && atual.ok) {
    if (path.resolve(atual.root || '') === path.resolve(info.folder)) {
      importerPid = atual.pid || null;
      importerRestartCount = 0;
      setImporterError('');
      logMain(`[Importador] ja rodando em ${info.folder} (pid ${importerPid}); usando a instancia existente`);
      return;
    }
    if (atual.pid) {
      logMain(`[Importador] rodando em pasta antiga (${atual.root}); substituindo`);
      try { killImporterPid(atual.pid); } catch {}
      for (let i = 0; i < 20; i++) {
        if (!(await isPortInUse(IMPORTER_PORT))) break;
        await sleep(200);
      }
    }
  } else if (await isPortInUse(IMPORTER_PORT)) {
    // Porta presa por um importador que nao responde. Confere uma segunda vez
    // antes de derrubar, para nao interromper uma copia grande em andamento.
    await sleep(1500);
    const segunda = await importerStatus();
    if (segunda && segunda.ok) {
      importerPid = segunda.pid || null;
      importerRestartCount = 0;
      setImporterError('');
      logMain(`[Importador] instancia existente respondeu (pid ${importerPid}); usando`);
      return;
    }
    setImporterError('Importador orfao preso na porta 8099; reiniciando');
    killAllImporters();
    for (let i = 0; i < 15; i++) {
      if (!(await isPortInUse(IMPORTER_PORT))) break;
      await sleep(300);
    }
  }
  if (await isPortInUse(IMPORTER_PORT)) {
    setImporterError('Porta 8099 ocupada por outro programa');
    setTimeout(startImporter, 15000);
    return;
  }

  const args = [
    '--headless',
    '--root', info.folder,
    '--port', String(IMPORTER_PORT),
    '--config', importerConfigFile(),
    '--no-firewall',
    '--log', importerLogFile(),
  ];
  const cmd = usarExe ? exe : 'python';
  const cmdArgs = usarExe ? args : [script, ...args];
  try {
    fs.mkdirSync(path.dirname(importerLogFile()), { recursive: true });
    fs.mkdirSync(info.folder, { recursive: true });
  } catch (e) {
    // Pasta de fotos em HD externo/rede desconectado: antes o start morria
    // calado e o importador ficava parado ate reiniciar o app.
    setImporterError(`Pasta indisponivel: ${info.folder} (${(e && (e.code || e.message)) || e})`);
    setTimeout(startImporter, 30000);
    return;
  }

  logMain(`[Importador] iniciando (${usarExe ? 'exe' : 'python'}) -> ${info.folder}`);
  const proc = spawn(cmd, cmdArgs, { windowsHide: true, env: { ...process.env } });
  importerProcess = proc;
  importerPid = proc.pid || null;
  let spawnError = false;

  proc.on('error', (e) => {
    spawnError = true;
    const codigo = (e && e.code) || '';
    if (codigo === 'EACCES' || codigo === 'EPERM') {
      setImporterError('Acesso negado ao importador (antivirus bloqueando?)');
    } else if (codigo === 'ENOENT') {
      setImporterError(`Executavel do importador nao encontrado: ${cmd}`);
    } else {
      setImporterError(`Falha ao iniciar o importador: ${(e && e.message) || e}`);
    }
    if (importerProcess === proc) { importerProcess = null; importerPid = null; }
    importerRestartCount++;
    setTimeout(startImporter, importerBackoff());
  });
  if (proc.stdout) proc.stdout.on('data', (d) => logMain(`[Importador] ${String(d).trim()}`));
  if (proc.stderr) proc.stderr.on('data', (d) => logMain(`[Importador][erro] ${String(d).trim()}`));

  proc.on('close', async (code) => {
    logMain(`[Importador] finalizado (codigo ${code})`);
    const eraAtual = importerProcess === proc;
    if (eraAtual) { importerProcess = null; importerPid = null; }
    if (spawnError || importerStopping || !eraAtual) return;
    const st = await importerStatus();
    if (st && st.ok) {
      importerPid = st.pid || null;
      importerRestartCount = 0;
      setImporterError('');
      return;
    }
    if (code === 0) {
      // Saiu porque a trava de instancia unica estava presa num orfao.
      setImporterError('Outra instancia do importador estava travada; reiniciando');
      killAllImporters();
    } else {
      setImporterError(`Importador encerrou sozinho (codigo ${code})`);
    }
    importerRestartCount++;
    setTimeout(startImporter, importerBackoff());
  });

  // O 1o start de um exe PyInstaller pode demorar enquanto o antivirus escaneia
  // o arquivo; so relanca depois de 45s sem resposta (antes eram 6s e o
  // importador era morto no meio da inicializacao).
  const ok = await waitImporterReady(proc, 45000);
  if (!ok && !importerStopping && importerProcess === proc) {
    setImporterError('Importador nao respondeu em 45s; relancando');
    killImporterPid(proc.pid);
    importerRestartCount++;
    setTimeout(startImporter, importerBackoff());
  }
}

function stopImporter() {
  importerStopping = true;
  const pid = (importerProcess && importerProcess.pid) || importerPid;
  if (pid) {
    console.log(`[Importador] Finalizando (pid ${pid})...`);
    killImporterPid(pid);
  }
  importerProcess = null;
  importerPid = null;
}

function restartImporter() {
  importerStopping = true;
  const pid = (importerProcess && importerProcess.pid) || importerPid;
  if (pid) killImporterPid(pid);
  importerProcess = null;
  importerPid = null;
  importerRestartCount = 0;
  setImporterError('');
  // Se o start anterior ainda esta no meio da espera (importerBusy), espera ele
  // soltar para nao perder o relancamento.
  const tentar = () => {
    if (importerBusy) { setTimeout(tentar, 300); return; }
    importerStopping = false;
    startImporter();
  };
  setTimeout(tentar, 800);
}

// Rede de seguranca: se o importador cair depois do boot (orfao, antivirus,
// update), tenta subir de novo a cada 30s em vez de ficar parado para sempre.
function startImporterWatchdog() {
  if (importerWatchdog) return;
  importerWatchdog = setInterval(async () => {
    if (importerStopping || importerBusy) return;
    const st = await importerStatus();
    if (st && st.ok) { importerRestartCount = 0; return; }
    startImporter();
  }, 30000);
}

// ─── 3. Janela principal ────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 900,
    fullscreen: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  if (isDev) {
    mainWindow.loadURL('http://localhost:5173/vendas.html');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'vendas.html'));
  }
  // Repassa console do renderer para o terminal (mesmo estilo [Sidecar]/[Java]),
  // pra erros da UI aparecerem mesmo sem abrir o DevTools.
  mainWindow.webContents.on('console-message', (_e, a, b, c, d) => {
    const args = typeof a === 'object' ? a : { level: a, message: b, lineNumber: c, sourceId: d };
    const lv = { 0: 'log', 1: 'warn', 2: 'error', 3: 'info' }[args.level] || 'log';
    const line = `${args.message}`.trim();
    if (!line) return;
    if (lv === 'error' || lv === 'warn') console.error(`[renderer:${lv}] ${line}`);
    else console.log(`[renderer] ${line}`);
  });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── 4. IPC: fullscreen ─────────────────────────────────────
ipcMain.handle('natal:exitFullscreen', () => {
  if (mainWindow?.isFullScreen()) mainWindow.setFullScreen(false);
});
ipcMain.handle('natal:enterFullscreen', () => {
  if (mainWindow && !mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
});
ipcMain.handle('natal:appVersion', () => app.getVersion());

// ─── IPC: config + folder picker ──────────────────────────────
ipcMain.handle('natal:getConfig', () => ({ ...config }));
ipcMain.handle('natal:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Selecionar pasta de fotos',
    defaultPath: config.photosFolder || undefined,
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('natal:saveConfig', async (_event, partial) => {
  config = { ...config, ...partial };
  try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8'); } catch {}
  return { success: true };
});
// Reinicia o importador depois de salvar pasta/config (a raiz pode ter mudado).
ipcMain.handle('natal:restartImporter', async () => {
  restartImporter();
  return { success: true };
});
// Diagnostico do importador para a aba "Cartao" (o app empacotado nao tem
// console; sem isso o operador so ve "nao esta rodando" sem o motivo).
ipcMain.handle('natal:importerInfo', async () => {
  const exe = getImporterPath();
  const script = importerScriptPath();
  let info = null;
  try { info = await resolverImportFolder(); } catch {}
  const st = await importerStatus();
  let portBusy = false;
  try { portBusy = await isPortInUse(IMPORTER_PORT); } catch {}
  return {
    success: true,
    online: !!(st && st.ok),
    exe,
    exeExists: fs.existsSync(exe),
    script,
    scriptExists: fs.existsSync(script),
    folder: info ? info.folder : '',
    pid: importerPid,
    port: IMPORTER_PORT,
    portBusy,
    restartCount: importerRestartCount,
    lastError: importerLastError,
    logFile: importerLogFile(),
    mainLogFile: mainLogFile(),
    userData: app.getPath('userData'),
  };
});
ipcMain.handle('natal:openImporterLog', async () => {
  const file = importerLogFile();
  try {
    if (fs.existsSync(file)) {
      const err = await shell.openPath(file);
      return err ? { success: false, error: err } : { success: true };
    }
    shell.showItemInFolder(path.join(app.getPath('userData'), 'logs'));
    return { success: true };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
});
// Abre uma pasta/arquivo no Explorer (botoes da aba "Cartao").
ipcMain.handle('natal:openPath', async (_event, target) => {
  const p = String(target || '').trim();
  if (!p) return { success: false, error: 'caminho vazio' };
  const err = await shell.openPath(p);
  return err ? { success: false, error: err } : { success: true };
});

// ─── 5. IPC: impressão da guia (impressora térmica via driver) ──
// Recebe o HTML da guia do renderer e imprime silencioso na impressora
// configurada (thermalPrinterName). Fallback: impressora padrão do Windows.
ipcMain.handle('natal:printGuia', async (event, { html, printerName } = {}) => {
  const deviceName = printerName || config.thermalPrinterName || '';
  const win = new BrowserWindow({
    width: 380,
    height: 520,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    const printOpts = { silent: true, printBackground: true, margins: { marginType: 'none' } };
    if (deviceName) printOpts.deviceName = deviceName;
    await new Promise((resolve) => {
      win.webContents.print(printOpts, (success, failureReason) => resolve({ success, failureReason }));
    });
    win.destroy();
    return { success: true };
  } catch (e) {
    win.destroy();
    return { success: false, error: e.message };
  }
});

// ─── 6. Auto-update (electron-updater, feed do Render) ──────
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

let isIdle = false;
let isUpdating = false;
let updateReady = false;

ipcMain.on('natal:setIdle', (_, idle) => { isIdle = idle; });

ipcMain.handle('natal:updateApp', async (event) => {
  try {
    if (isUpdating) return { success: false, error: 'Verificacao em andamento' };
    if (updateReady) {
      setTimeout(() => autoUpdater.quitAndInstall(false, true), 1500);
      return { success: true, installing: true };
    }
    isUpdating = true;
    event.sender.send('natal:updateProgress', 'Verificando atualizacoes...');
    const result = await autoUpdater.checkForUpdates();
    const available = !!(result && result.updateInfo && result.updateInfo.version !== app.getVersion());
    if (!available) {
      isUpdating = false;
      event.sender.send('natal:updateProgress', 'App ja esta atualizado');
      return { success: true, upToDate: true };
    }
    event.sender.send('natal:updateProgress', `Baixando v${result.updateInfo.version}...`);
    await autoUpdater.downloadUpdate();
    updateReady = true;
    isUpdating = false;
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 1500);
    return { success: true, installing: true };
  } catch (e) {
    isUpdating = false;
    return { success: false, error: e.message || 'Erro ao atualizar' };
  }
});

autoUpdater.on('update-available', (info) => {
  isUpdating = false;
  if (mainWindow) mainWindow.webContents.send('natal:updateAvailable', { version: info.version });
});
autoUpdater.on('update-not-available', () => {
  isUpdating = false;
  if (mainWindow) mainWindow.webContents.send('natal:updateNotAvailable');
});
autoUpdater.on('update-downloaded', () => {
  updateReady = true;
  isUpdating = false;
});
autoUpdater.on('error', (err) => {
  console.error('[AutoUpdate] Erro:', err.message);
  isUpdating = false;
});

function performAutoUpdate() {
  if (isUpdating || updateReady) return;
  isUpdating = true;
  autoUpdater.checkForUpdates().catch((e) => {
    console.error('[AutoUpdate] Erro:', e.message);
    isUpdating = false;
  });
}

// ─── 7. Lifecycle ───────────────────────────────────────────
app.whenReady().then(() => {
  aplicarPastaDeFotosPadrao();
  startSidecar();
  startJavaSidecar();
  createWindow();
  setTimeout(startImporter, 4000);
  startImporterWatchdog();

  setTimeout(() => {
    performAutoUpdate();
    setInterval(() => { if (isIdle && !isUpdating) performAutoUpdate(); }, 60000);
  }, 10000);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});



ipcMain.handle('natal:printBematech', async (_event, { texto } = {}) => {
  try {
    const txt = typeof texto === 'string' ? texto : '';
    if (!txt || txt.trim().length === 0) {
      try { logMain('[ImpressaoBematech] texto vazio'); } catch(e){}
      return { success: false, error: 'texto vazio' };
    }
    const printer = 'MP-4200 TH';
    const safe = txt.replace(/\r/g, '').replace(/\n/g, '\r\n');
    const b64 = Buffer.from(safe + '\r\n\r\n\r\n', 'utf8').toString('base64');
    const ps = "Add-Type -AssemblyName System.Drawing; Add-Type -AssemblyName System.Windows.Forms; $pd = New-Object System.Drawing.Printing.PrintDocument; $pd.PrinterSettings.PrinterName = '" + printer.replace(/'/g, "''") + "'; $pd.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins -ArgumentList 0,0,0,0; $txt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('" + b64 + "')); $pd.Add_PrintPage({ param($s,$ev); $ev.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Pixel; $base = 12.0; $f0 = New-Object System.Drawing.Font('Courier New', $base, [System.Drawing.FontStyle]::Bold); $widest = (($txt -split ([Environment]::NewLine)) | ForEach-Object { $_.Length } | Measure-Object -Maximum).Maximum; $sample = ('0' * [int]$widest); $sz = [System.Windows.Forms.TextRenderer]::MeasureText($ev.Graphics, $sample, $f0); $target = $ev.Graphics.VisibleClipBounds.Width * 0.98; if ($target -le 0) { $target = 576 }; $scale = 1.0; if ($sz.Width -gt 0) { $scale = $target / $sz.Width }; $newSize = [float]([Math]::Max(8.0, [Math]::Min(30.0, $base * $scale))); $f = New-Object System.Drawing.Font('Courier New', $newSize, [System.Drawing.FontStyle]::Bold); [System.Windows.Forms.TextRenderer]::DrawText($ev.Graphics, $txt, $f, (New-Object System.Drawing.Point 4,4), [System.Drawing.Color]::Black); [Console]::WriteLine('PRINT widest=' + $widest + ' measured=' + $sz.Width + ' target=' + [Math]::Round($target,1) + ' scale=' + [Math]::Round($scale,3) + ' size=' + [Math]::Round($newSize,2) + ' visW=' + [Math]::Round($ev.Graphics.VisibleClipBounds.Width,1) + ' dpiY=' + $ev.Graphics.DpiY) }); $pd.Print();";
    const { spawn } = require('child_process');
    return await new Promise((resolve) => {
      try {
        try { logMain('[ImpressaoBematech] enviando para ' + printer + ' (' + txt.length + ' chars)'); } catch(e){}
        const psp = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { windowsHide: true });
        psp.stdout.on('data', (d) => { try { logMain('[ImpressaoBematech] out: ' + String(d).trim()); } catch(e){} });
        psp.stderr.on('data', (d) => { try { logMain('[ImpressaoBematech] err: ' + String(d).trim()); } catch(e){} });
        let done = false;
        const fim = (r) => { if (!done) { done = true; resolve(r); } };
        const t = setTimeout(() => { try { psp.kill(); } catch(e){} fim({ success: false, error: 'timeout', printer }); }, 15000);
        psp.on('error', (e) => { clearTimeout(t); try { logMain('[ImpressaoBematech] erro: ' + e.message); } catch(e2){} fim({ success: false, error: e.message, printer }); });
        psp.on('close', (code) => { clearTimeout(t); if (code === 0) { try { logMain('[ImpressaoBematech] ok'); } catch(e){} fim({ success: true, printer }); } else { try { logMain('[ImpressaoBematech] ps_exit_' + code); } catch(e){} fim({ success: false, error: 'ps_exit_' + code, printer }); } });
      } catch (e) {
        try { logMain('[ImpressaoBematech] exc: ' + e.message); } catch(e2){}
        resolve({ success: false, error: e.message, printer });
      }
    });
  } catch (e) {
    try { logMain('[ImpressaoBematech] exc2: ' + e.message); } catch(e2){}
    return { success: false, error: e.message };
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('will-quit', () => {
  stopImporter();
  for (const [name, proc] of [['Sidecar', sidecarProcess], ['Java', javaProcess]]) {
    if (proc) { console.log(`[${name}] Finalizando...`); proc.kill(); }
  }
});
