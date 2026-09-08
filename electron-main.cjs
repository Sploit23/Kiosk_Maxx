const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
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

function startSidecar() {
  const sidecarPath = getSidecarPath();
  if (!fs.existsSync(sidecarPath)) {
    console.warn('[Sidecar] natal-core.cjs nao encontrado.');
    return;
  }
  if (sidecarRestartCount >= SIDECAR_MAX_RESTARTS) return;
  isPortInUse(9877).then((inUse) => {
    if (inUse) {
      console.warn('[Sidecar] Porta 9877 ja em uso (outra instancia). Usando a existente.');
      return;
    }
    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      NATAL_DATA_DIR: app.getPath('userData'),
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
  });
}

// ─── 2. Sidecar Java (Fujifilm ASK-400) ─────────────────────
function findJava() {
  const candidates = [
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
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, 'dist', 'index.html'));
  }
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
