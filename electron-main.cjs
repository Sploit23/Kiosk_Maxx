const { app, BrowserWindow, ipcMain, dialog } = require('electron');
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
  startSidecar();
  startJavaSidecar();
  createWindow();

  setTimeout(() => {
    performAutoUpdate();
    setInterval(() => { if (isIdle && !isUpdating) performAutoUpdate(); }, 60000);
  }, 10000);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('will-quit', () => {
  for (const [name, proc] of [['Sidecar', sidecarProcess], ['Java', javaProcess]]) {
    if (proc) { console.log(`[${name}] Finalizando...`); proc.kill(); }
  }
});
