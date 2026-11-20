const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const net = require('net');
const http = require('http');
const https = require('https');
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
function getThermalPrintPath() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'thermal-print.cjs');
  return path.join(__dirname, 'sidecar', 'thermal-print.cjs');
}
const { printBematech } = require(getThermalPrintPath());

// ─── Config (fora do pacote em produção) ────────────────────
const CONFIG_PATH = app.isPackaged
  ? path.join('C:', 'ProgramData', 'MaxxNatal', 'electron-config.json')
  : path.join(__dirname, 'electron-config.json');

let config = {};
// true quando o electron-config.json existe mas não abre (escrita interrompida/
// queda de energia). Nesse caso não sobrescrevemos nada: o sidecar tem o
// ponteiro `fotos-folder.txt` e o backup de identidade em ProgramData, que
// recuperam pasta/loja. Sobrescrever com o template zerava photosFolder e fazia
// o PDV abrir numa pasta vazia (sessões, pedidos e ribbon "desapareciam").
let configInvalido = false;
function writeConfigAtomico() {
  const tmp = `${CONFIG_PATH}.tmp`;
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, CONFIG_PATH);
}
function loadConfig() {
  configInvalido = false;
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    configInvalido = fs.existsSync(CONFIG_PATH);
    try {
      config = JSON.parse(fs.readFileSync(path.join(__dirname, 'electron-config.template.json'), 'utf-8'));
    } catch {
      config = {};
    }
    if (configInvalido) {
      console.error(`[Config] ${CONFIG_PATH} ilegivel; mantendo o arquivo e usando o ponteiro de pasta do sidecar`);
    }
  }
}
loadConfig();

// Instalacao nova chega sem pasta de fotos e o importador do cartao nunca
// subia ("Pasta de fotos ainda nao configurada"), deixando o PC sem receber
// nada. Documentos\Natal_Recebidas funciona sem senha e pode ser trocada no
// ⚙ Config > Sistema (a pasta escolhida continua tendo prioridade).
function aplicarPastaDeFotosPadrao() {
  // Config ilegível: não inventa pasta nova (o ponteiro do sidecar manda).
  if (configInvalido) return;
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
    writeConfigAtomico();
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
    // Config ilegível: sem env, o sidecar usa o ponteiro fotos-folder.txt
    // (recuperação) em vez de uma pasta recém-criada e vazia.
    NATAL_PHOTOS_FOLDER: configInvalido ? '' : (config.photosFolder || '').trim(),
    NATAL_WEB_DIR: app.isPackaged ? getResourcePath('web') : path.join(__dirname, 'dist'),
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
      } else {
        // Subiu e respondeu com o build atual: backend saudável, zera a cota.
        sidecarRestartCount = 0;
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
      // Instância saudável na porta: o backend está de pé. Zera o orçamento de
      // restarts (antes ele era cumulativo e, após 5 falhas ao longo do dia, o
      // sidecar nunca mais subia até reiniciar o app).
      sidecarRestartCount = 0;
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

function stopJavaSidecar() {
  const proc = javaProcess;
  javaProcess = null;
  if (!proc) return;
  try {
    if (process.platform === 'win32' && proc.pid) {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { proc.kill(); } catch {}
    }
  } catch { try { proc.kill(); } catch {} }
}

function javaHealthOk() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 8080, path: '/health', timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function restartJavaSidecar() {
  const subir = async () => {
    startJavaSidecar();
    for (let i = 0; i < 20; i++) {
      if (await javaHealthOk()) return true;
      await sleep(500);
    }
    return false;
  };
  stopJavaSidecar();
  // Espera a porta 8080 liberar antes de subir de novo (kill no Windows nao e
  // instantaneo; subir cedo demais faz o Java novo morrer no bind).
  for (let i = 0; i < 12; i++) {
    if (!(await isPortInUse(8080))) break;
    await sleep(500);
  }
  if (await subir()) return true;
  // Uma segunda tentativa: as vezes o driver/JVM demora a soltar a porta.
  stopJavaSidecar();
  for (let i = 0; i < 8; i++) {
    if (!(await isPortInUse(8080))) break;
    await sleep(500);
  }
  return await subir();
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
// Um único timer de retry para o importador. Antes cada falha agendava o seu
// próprio setTimeout e o watchdog (30s) disparava mais uma corrente — com o
// exe bloqueado/HD fora, as correntes se multiplicavam sem limite.
let importerRetryTimer = null;
function agendarRetryImporter(ms) {
  if (importerRetryTimer) clearTimeout(importerRetryTimer);
  importerRetryTimer = setTimeout(() => { importerRetryTimer = null; startImporter(); }, ms);
}

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
  // Se estamos iniciando agora (watchdog/boot), o retry pendente não é mais
  // necessário — cancelar evita correntes paralelas de tentativa.
  if (importerRetryTimer) { clearTimeout(importerRetryTimer); importerRetryTimer = null; }
  if (importerBusy || importerStopping) return;
  importerBusy = true;
  try {
    await startImporterInner();
  } catch (e) {
    setImporterError(`Falha ao iniciar o importador: ${(e && e.message) || e}`);
    agendarRetryImporter(15000);
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
    agendarRetryImporter(10000);
    return;
  }

  const exe = getImporterPath();
  const script = importerScriptPath();
  const usarExe = fs.existsSync(exe);
  if (!usarExe && !fs.existsSync(script)) {
    setImporterError(`Importador nao encontrado: ${exe} (instalacao incompleta ou antivirus)`);
    agendarRetryImporter(30000);
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
    agendarRetryImporter(15000);
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
    agendarRetryImporter(30000);
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
    agendarRetryImporter(importerBackoff());
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
    agendarRetryImporter(importerBackoff());
  });

  // O 1o start de um exe PyInstaller pode demorar enquanto o antivirus escaneia
  // o arquivo; so relanca depois de 45s sem resposta (antes eram 6s e o
  // importador era morto no meio da inicializacao).
  const ok = await waitImporterReady(proc, 45000);
  if (!ok && !importerStopping && importerProcess === proc) {
    setImporterError('Importador nao respondeu em 45s; relancando');
    killImporterPid(proc.pid);
    importerRestartCount++;
    agendarRetryImporter(importerBackoff());
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
    fullscreen: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.maximize();
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
  /* Se a atualização já baixou (ou está baixando) quando a tela recarrega,
     reavisa o renderer para o aviso de "Instalar agora" continuar aparecendo. */
  mainWindow.webContents.on('did-finish-load', () => {
    if (updateReady) enviarUpdate('natal:updateReady', { version: updateVersion });
    else if (updateDownload) enviarUpdate('natal:updateAvailable', { version: updateVersion, downloading: true });
  });
  mainWindow.on('focus', () => { performAutoUpdate(); });
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── 4. IPC: fullscreen ─────────────────────────────────────
ipcMain.handle('natal:exitFullscreen', () => {
  if (!mainWindow) return;
  if (mainWindow.isFullScreen()) {
    mainWindow.once('leave-full-screen', () => {
      if (mainWindow && !mainWindow.isMaximized()) mainWindow.maximize();
    });
    mainWindow.setFullScreen(false);
  } else if (!mainWindow.isMaximized()) {
  mainWindow.maximize();
  // Quiosque: a janela não pode sair do app. Uma página remota (link, redirect,
  // window.open) herdaria o preload desta janela — ou seja, window.natal com
  // acesso a IPC de config/impressora/updater. Nega popups e navegação externa.
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const navegacaoPermitida = (url) => (isDev
    ? /^http:\/\/localhost:5173\//.test(String(url))
    : String(url).startsWith('file://'));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!navegacaoPermitida(url)) {
      console.warn(`[Janela] navegacao bloqueada: ${url}`);
      event.preventDefault();
    }
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!navegacaoPermitida(url)) event.preventDefault();
  });
  }
});
ipcMain.handle('natal:enterFullscreen', () => {
  if (mainWindow && !mainWindow.isFullScreen()) mainWindow.setFullScreen(true);
});
ipcMain.handle('natal:appVersion', () => app.getVersion());

// ─── Camera DSLR direta (digiCamControl embutido) ───────────
// Modalidade "cabo 100% direto": o app abre o digiCamControl junto do PDV, ele
// salva os JPEGs na pasta da sessao e o sidecar cria a sessao no "Fechar sessao".
// A foto fica SEMPRE no PC (CaptureInSdRam=false): nada de gravar no cartao.
const DIGICAM_PORT = 5513;
let digiCamProcess = null;
let digiCamWatchdogTimer = null;
let digiCamBusy = false;
let digiCamDesejado = false;

function getDigiCamPath() {
  const candidatos = [];
  if (app.isPackaged) candidatos.push(path.join(process.resourcesPath, 'digicam', 'CameraControl.exe'));
  candidatos.push(path.join(__dirname, 'digicam', 'CameraControl.exe'));
  candidatos.push(path.join('C:', 'Program Files (x86)', 'digiCamControl', 'CameraControl.exe'));
  candidatos.push(path.join('C:', 'Program Files', 'digiCamControl', 'CameraControl.exe'));
  for (const c of candidatos) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return candidatos[0];
}
function digiCamBundled() {
  if (app.isPackaged) return fs.existsSync(path.join(process.resourcesPath, 'digicam', 'CameraControl.exe'));
  return fs.existsSync(path.join(__dirname, 'digicam', 'CameraControl.exe'));
}
function digiCamSettingsPath() {
  return path.join(process.env.ProgramData || 'C:\\ProgramData', 'digiCamControl', 'settings.json');
}
function digiCamLogFile() {
  return path.join(app.getPath('userData'), 'logs', 'digicam.log');
}
function digiCamLogar(msg) {
  const linha = `[${new Date().toISOString()}] ${msg}\r\n`;
  try {
    const file = digiCamLogFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, linha, 'utf-8');
  } catch {}
}
function digiCamProgramData() {
  return process.env.ProgramData || 'C:\\ProgramData';
}
function digiCamSessionName() {
  try {
    const json = JSON.parse(fs.readFileSync(digiCamSettingsPath(), 'utf-8'));
    const nome = json && String(json.DefaultSessionName || '').trim();
    if (nome) return nome;
  } catch {}
  return 'Session1';
}
function digiCamSessionPath() {
  return path.join(digiCamProgramData(), 'digiCamControl', 'Sessions', digiCamSessionName() + '.json');
}
function digiCamRemotePath() {
  try { return path.join(path.dirname(getDigiCamPath()), 'CameraControlRemoteCmd.exe'); } catch { return ''; }
}
function lerSessaoDigiCam() {
  try {
    const file = digiCamSessionPath();
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch { return null; }
}
// Pasta que o kiosk quer usar: config do sidecar (fonte da verdade) > config do
// electron > pasta padrao do digiCamControl (Pictures\digiCamControl\<sessao>).
async function resolverPastaDigiCam() {
  try {
    const cfg = await fetchJson(9877, '/api/config', '127.0.0.1', 2500);
    const resolved = cfg && String(cfg.dslrFolderResolved || '').trim();
    if (resolved) return resolved;
    const custom = cfg && String(cfg.dslrFolder || '').trim();
    if (custom) return custom;
  } catch {}
  const custom = String(config.dslrFolder || '').trim();
  if (custom) return custom;
  const userProfile = String(process.env.USERPROFILE || app.getPath('home') || '').trim();
  return path.join(userProfile, 'Pictures', 'digiCamControl', digiCamSessionName());
}
// O digiCamControl salva o "Folder" dentro da sessao; se ele ficou apontando
// para outra pasta (outro projeto/teste), as fotos nunca aparecem no PDV.
// Compara o que esta gravado com a pasta desejada para decidir se precisa
// reiniciar o programa antes de reescrever.
function digiCamPrecisaAjuste(pasta) {
  let settingsAjuste = false;
  try {
    const json = JSON.parse(fs.readFileSync(digiCamSettingsPath(), 'utf-8'));
    if (json && json.UseWebserver !== true) settingsAjuste = true;
    if (json && json.AllowWebserverActions !== true) settingsAjuste = true;
    if (json && json.NewSessionOnStartUp === true) settingsAjuste = true;
    const itens = json && json.CameraProperties && Array.isArray(json.CameraProperties.Items)
      ? json.CameraProperties.Items : [];
    for (const item of itens) {
      if (!item) continue;
      if (item.CaptureInSdRam !== false || item.NoDownload === true) { settingsAjuste = true; break; }
    }
  } catch {}
  const sessao = lerSessaoDigiCam();
  let folderAjuste = false;
  if (sessao && pasta) {
    const atual = String(sessao.Folder || '').trim();
    folderAjuste = !atual || path.resolve(atual) !== path.resolve(pasta);
  }
  return settingsAjuste || folderAjuste;
}
// Rede de seguranca: as fotos de teste podem ter ficado na pasta antiga da
// sessao. Se a pasta nova estiver vazia, move os JPEGs para ela na primeira
// abertura (nada e apagado; se o move falhar, copia).
function migrarFotosSessaoAntiga(origem, destino) {
  try {
    if (!origem || !destino) return 0;
    const o = path.resolve(origem);
    const d = path.resolve(destino);
    if (o === d || !fs.existsSync(o) || !fs.existsSync(d)) return 0;
    const ehFoto = (n) => /\.(jpe?g|png)$/i.test(n) && !n.startsWith('.');
    const fotos = fs.readdirSync(o).filter(ehFoto);
    if (!fotos.length) return 0;
    if (fs.readdirSync(d).some(ehFoto)) return 0;
    let movidas = 0;
    for (const nome of fotos) {
      const src = path.join(o, nome);
      const dst = path.join(d, nome);
      try { fs.renameSync(src, dst); movidas += 1; }
      catch { try { fs.copyFileSync(src, dst); fs.rmSync(src, { force: true }); movidas += 1; } catch {} }
    }
    if (movidas) digiCamLogar(`migradas ${movidas} foto(s) de ${o} para ${d}`);
    return movidas;
  } catch (e) {
    digiCamLogar('falha ao migrar fotos da sessao: ' + ((e && e.message) || e));
    return 0;
  }
}
// Grava a pasta desejada na sessao ativa. Deve rodar com o CameraControl
// fechado (senao ele regrava o arquivo ao sair).
function ajustarSessaoDigiCam(pasta) {
  try {
    if (!pasta) return false;
    fs.mkdirSync(pasta, { recursive: true });
    const file = digiCamSessionPath();
    if (!fs.existsSync(file)) return false;
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!json || typeof json !== 'object') return false;
    const atual = String(json.Folder || '').trim();
    if (atual && path.resolve(atual) !== path.resolve(pasta)) {
      migrarFotosSessaoAntiga(atual, pasta);
    }
    if (atual === pasta) return false;
    json.Folder = pasta;
    fs.writeFileSync(file, JSON.stringify(json), 'utf-8');
    digiCamLogar(`sessao ${json.Name || ''} apontada para ${pasta}`);
    return true;
  } catch (e) {
    digiCamLogar('nao consegui ajustar a sessao do digiCamControl: ' + ((e && e.message) || e));
    return false;
  }
}
// Com o programa aberto, a sessao em memoria e alterada pelo utilitario
// remoto (CameraControlRemoteCmd.exe /c set session.folder). Retenta enquanto
// o webserver local (5513) sobe.
function aplicarPastaDigiCam(pasta) {
  return new Promise((resolve) => {
    if (!pasta) return resolve(false);
    const exe = digiCamRemotePath();
    if (!exe || !fs.existsSync(exe)) {
      digiCamLogar('CameraControlRemoteCmd.exe nao encontrado: ' + exe);
      return resolve(false);
    }
    let tentativa = 0;
    const tentar = () => {
      tentativa += 1;
      execFile(exe, ['/c', 'set', 'session.folder', pasta], { windowsHide: true, timeout: 6000 }, (err, stdout, stderr) => {
        if (!err) {
          digiCamLogar(`pasta da sessao aplicada (${tentativa}x): ${pasta}`);
          return resolve(true);
        }
        if (tentativa < 8) return setTimeout(tentar, 1000);
        const saida = (String(stdout || '') + String(stderr || '')).trim();
        digiCamLogar('falha ao aplicar a pasta da sessao: ' + ((err && err.message) || err) + (saida ? ' | ' + saida : ''));
        resolve(false);
      });
    };
    tentar();
  });
}
// Foto apenas no PC: se o perfil da camera mandar "CaptureInSdRam=true" a foto
// nao aparece na pasta e a sessao fica vazia. Webserver local tambem e ligado
// (porta 5513) porque e por ele que o status sabe que a camera respondeu.
function ajustarDigiCamSettings() {
  try {
    const file = digiCamSettingsPath();
    if (!fs.existsSync(file)) return false;
    const json = JSON.parse(fs.readFileSync(file, 'utf-8'));
    let alterou = false;
    const itens = json && json.CameraProperties && Array.isArray(json.CameraProperties.Items)
      ? json.CameraProperties.Items : [];
    for (const item of itens) {
      if (!item) continue;
      if (item.CaptureInSdRam !== false) { item.CaptureInSdRam = false; alterou = true; }
      if (item.NoDownload === true) { item.NoDownload = false; alterou = true; }
    }
    if (json && json.UseWebserver !== true) { json.UseWebserver = true; alterou = true; }
    if (json && json.AllowWebserverActions !== true) { json.AllowWebserverActions = true; alterou = true; }
    if (json && json.NewSessionOnStartUp === true) { json.NewSessionOnStartUp = false; alterou = true; }
    if (alterou) {
      fs.writeFileSync(file, JSON.stringify(json, null, 2), 'utf-8');
      digiCamLogar(`settings.json ajustado (CaptureInSdRam=false, UseWebserver=true) em ${itens.length} perfil(is)`);
    }
    return alterou;
  } catch (e) {
    digiCamLogar('nao consegui ajustar settings.json: ' + ((e && e.message) || e));
    return false;
  }
}
function digiCamJaAberto() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', 'IMAGENAME eq CameraControl.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      resolve(!err && /CameraControl\.exe/i.test(String(stdout || '')));
    });
  });
}
function killDigiCamProcessos() {
  try {
    const killer = spawn('taskkill', ['/IM', 'CameraControl.exe', '/T', '/F'], { windowsHide: true });
    killer.on('error', () => {});
  } catch {}
}
async function startDigiCam() {
  if (digiCamBusy) return { success: false, error: 'OCUPADO' };
  digiCamBusy = true;
  try {
    const exe = getDigiCamPath();
    if (!fs.existsSync(exe)) {
      digiCamLogar('digiCamControl nao encontrado: ' + exe);
      return { success: false, error: 'NAO_ENCONTRADO', exe };
    }
    const pasta = await resolverPastaDigiCam();
    const aberto = await digiCamJaAberto();
    if (aberto && digiCamPrecisaAjuste(pasta)) {
      digiCamLogar('config/sessao diferente com o digiCamControl aberto; reiniciando para aplicar');
      killDigiCamProcessos();
      await new Promise((r) => setTimeout(r, 3500));
    }
    ajustarDigiCamSettings();
    ajustarSessaoDigiCam(pasta);
    const jaAberto = await digiCamJaAberto();
    if (!jaAberto) {
      digiCamLogar('iniciando ' + exe + ' (pasta: ' + pasta + ')');
      const proc = spawn(exe, [], { windowsHide: true });
      digiCamProcess = proc;
      proc.on('error', (e) => digiCamLogar('falha ao iniciar: ' + ((e && e.message) || e)));
      proc.on('close', (code) => {
        if (digiCamProcess === proc) digiCamProcess = null;
        digiCamLogar('finalizado (code=' + code + ')');
      });
    } else {
      digiCamProcess = null;
    }
    // Garante a pasta também na instância que já estava aberta (ou que subiu
    // agora), via utilitário remoto do próprio digiCamControl.
    const remote = await aplicarPastaDigiCam(pasta);
    return { success: true, exe, folder: pasta, remote, jaAberto };
  } catch (e) {
    digiCamLogar('falha ao iniciar: ' + ((e && e.message) || e));
    return { success: false, error: (e && e.message) || String(e) };
  } finally {
    digiCamBusy = false;
  }
}
async function pararDigiCam() {
  digiCamDesejado = false;
  if (!(await digiCamJaAberto())) return { success: true };
  killDigiCamProcessos();
  return { success: true };
}
// Liga/desliga o modo direto. O renderer chama no boot e ao salvar a config do
// Sistema; a resposta alimenta o diagnostico da aba.
async function sincronizarDigiCam(enabled) {
  digiCamDesejado = !!enabled;
  if (!digiCamDesejado) {
    await pararDigiCam();
    return { success: true, enabled: false, running: false };
  }
  const r = await startDigiCam();
  return { success: !!r.success, enabled: true, running: await digiCamJaAberto(), ...r };
}
function startDigiCamWatchdog() {
  if (digiCamWatchdogTimer) clearInterval(digiCamWatchdogTimer);
  digiCamWatchdogTimer = setInterval(async () => {
    if (!digiCamDesejado || digiCamBusy) return;
    if (await digiCamJaAberto()) return;
    digiCamLogar('watchdog: camera nao esta aberta, reabrindo');
    await startDigiCam();
  }, 30000);
}
async function digiCamInfo() {
  const exe = getDigiCamPath();
  let sidecarCfg = null;
  try { sidecarCfg = await fetchJson(9877, '/api/config', '127.0.0.1', 2500); } catch {}
  return {
    success: true,
    enabled: digiCamDesejado,
    running: await digiCamJaAberto(),
    exe,
    exeExists: fs.existsSync(exe),
    bundled: digiCamBundled(),
    settingsFile: digiCamSettingsPath(),
    logFile: digiCamLogFile(),
    folder: sidecarCfg ? String(sidecarCfg.dslrFolderResolved || '') : '',
    folderConfigured: sidecarCfg ? !!sidecarCfg.dslrEnabled : false,
  };
}
ipcMain.handle('natal:dslrSync', (_event, enabled) => sincronizarDigiCam(enabled));
ipcMain.handle('natal:dslrInfo', () => digiCamInfo());
ipcMain.handle('natal:dslrRestart', async () => {
  killDigiCamProcessos();
  await new Promise((r) => setTimeout(r, 1500));
  return sincronizarDigiCam(true);
});
ipcMain.handle('natal:dslrStop', async () => {
  const r = await pararDigiCam();
  return { ...r, enabled: false, running: false };
});
ipcMain.handle('natal:openDslrLog', async () => {
  const file = digiCamLogFile();
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

// ─── IPC: config + folder picker ──────────────────────────────
ipcMain.handle('natal:getConfig', () => ({ ...config }));
ipcMain.handle('natal:listPrinters', async (event) => {
  try {
    const printers = await event.sender.getPrintersAsync();
    return {
      success: true,
      printers: (printers || []).map((p) => ({
        name: p.name,
        displayName: p.displayName || p.name,
        isDefault: !!p.isDefault,
        status: p.status,
      })),
    };
  } catch (e) {
    return { success: false, error: e.message, printers: [] };
  }
});
ipcMain.handle('natal:selectFolder', async (_event, opts = {}) => {
  const { title, defaultPath } = opts || {};
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: title || 'Selecionar pasta de fotos',
    defaultPath: defaultPath || config.photosFolder || undefined,
  });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('natal:saveConfig', async (_event, partial) => {
  config = { ...config, ...partial };
  configInvalido = false;
  try {
    writeConfigAtomico();
    return { success: true };
  } catch (e) {
    console.error(`[Config] falha ao gravar ${CONFIG_PATH}: ${(e && e.message) || e}`);
    return { success: false, error: (e && e.message) || String(e) };
  }
});
// Reinicia o importador depois de salvar pasta/config (a raiz pode ter mudado).
ipcMain.handle('natal:restartImporter', async () => {
  restartImporter();
  return { success: true };
});
// Reinicia o motor de impressao (sidecar Java da ASK-400) sem tocar em config,
// loja, pareamento ou fila. Usado pelo botao "Reiniciar impressao" do Config >
// Sincronizar quando a impressora trava ou a fila empaca.
ipcMain.handle('natal:restartPrinter', async () => {
  try {
    const printerReady = await restartJavaSidecar();
    try { logMain('[Impressao] sidecar ASK-400 reiniciado (ok=' + printerReady + ')'); } catch {}
    return { success: true, printerReady };
  } catch (e) {
    try { logMain('[Impressao] falha ao reiniciar sidecar ASK-400: ' + e.message); } catch {}
    return { success: false, error: e.message };
  }
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
// Só pasta do app: o renderer nunca pode pedir para abrir um .exe/.lnk/.bat
// (um HTML injetado chegaria em `shell.openPath` e executaria código).
function caminhoDePastaPermitido(alvo) {
  try {
    const absoluto = path.resolve(String(alvo));
    const raizes = [config.photosFolder, config.importFolder, config.dslrFolder,
      app.getPath('userData'), app.getPath('logs')]
      .filter(Boolean).map((r) => path.resolve(String(r)));
    for (const raiz of raizes) {
      const rel = path.relative(raiz, absoluto);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return absoluto;
    }
  } catch {}
  return null;
}
ipcMain.handle('natal:openPath', async (_event, target) => {
  const p = String(target || '').trim();
  if (!p) return { success: false, error: 'caminho vazio' };
  const permitido = caminhoDePastaPermitido(p);
  if (!permitido) return { success: false, error: 'caminho nao permitido' };
  try {
    if (!fs.statSync(permitido).isDirectory()) return { success: false, error: 'nao e uma pasta' };
  } catch {
    return { success: false, error: 'pasta nao encontrada' };
  }
  const err = await shell.openPath(permitido);
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
    // Sem timeout, um driver/spooler travado nunca chamava o callback: o await
    // do checkout ficava pendurado e a janela oculta vazava a cada cupom.
    const result = await new Promise((resolve) => {
      let terminou = false;
      const finalizar = (r) => { if (!terminou) { terminou = true; clearTimeout(timer); resolve(r); } };
      const timer = setTimeout(() => finalizar({
        success: false,
        failureReason: 'Tempo esgotado na impressora térmica (driver sem resposta)',
      }), 20000);
      try {
        win.webContents.print(printOpts, (success, failureReason) => finalizar({ success, failureReason }));
      } catch (e) {
        finalizar({ success: false, failureReason: (e && e.message) || String(e) });
      }
    });
    if (result.success) return { success: true };
    return { success: false, error: result.failureReason || 'print_failed' };
  } catch (e) {
    return { success: false, error: e.message };
  } finally {
    try { if (!win.isDestroyed()) win.destroy(); } catch {}
  }
});

// ─── 6. Auto-update (electron-updater, feed do Render) ──────
const { autoUpdater } = require('electron-updater');
autoUpdater.autoDownload = false;   // baixamos aqui para controlar o estado/UI
autoUpdater.autoInstallOnAppQuit = false;

let isUpdating = false;
let updateReady = false;
let updateVersion = '';
let updateDownload = null;      // Promise do download em andamento
let updatePendenteDownload = false; // download adiado enquanto imprime/vende
let isBusy = false;
let ultimaVerificacao = 0;
const UPDATE_CHECK_MS = 5 * 60 * 1000; // procura sozinho a cada 5 min (qualquer tela)
const UPDATE_CHECK_MIN_MS = 60 * 1000; // nao repete antes de 1 min (foco/reabertura)

function enviarUpdate(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function baixarAtualizacao(imediato = false) {
  if (!updateDownload) {
    // Baixar ~400 MB durante uma venda/impressão trava o PC do balcão: adia até
    // o renderer avisar que terminou (natal:setBusy false).
    if (isBusy && !imediato) {
      updatePendenteDownload = true;
      return Promise.resolve(false);
    }
    updatePendenteDownload = false;
    updateDownload = autoUpdater.downloadUpdate()
      .then(() => { updateReady = true; return true; })
      .catch((e) => { updateDownload = null; throw e; });
  }
  return updateDownload;
}

ipcMain.on('natal:setBusy', (_event, busy) => {
  isBusy = !!busy;
  if (isBusy || !updatePendenteDownload || updateDownload || updateReady) return;
  baixarAtualizacao().catch((e) => {
    updateDownload = null;
    enviarUpdate('natal:updateError', { error: e.message || 'Falha ao baixar atualizacao' });
  });
});

ipcMain.handle('natal:updateStatus', () => ({
  ready: updateReady,
  version: updateVersion,
  downloading: !!updateDownload && !updateReady,
  checking: isUpdating,
}));

ipcMain.handle('natal:updateApp', async (event) => {
  try {
    if (updateReady) {
      setTimeout(() => autoUpdater.quitAndInstall(false, true), 1200);
      return { success: true, installing: true };
    }
    if (isUpdating) return { success: true, downloading: true };
    isUpdating = true;
    event.sender.send('natal:updateProgress', 'Verificando atualizacoes...');
    const result = await autoUpdater.checkForUpdates();
    const available = !!(result && result.updateInfo && result.updateInfo.version !== app.getVersion());
    if (!available) {
      isUpdating = false;
      event.sender.send('natal:updateProgress', 'App ja esta atualizado');
      return { success: true, upToDate: true };
    }
    updateVersion = result.updateInfo.version;
    const bloqueada = versaoBloqueada();
    if (bloqueada && updateVersion === bloqueada) {
      isUpdating = false;
      event.sender.send('natal:updateProgress', 'Versao v' + bloqueada + ' bloqueada apos rollback');
      return { success: false, error: 'A versao v' + bloqueada + ' foi bloqueada apos um rollback. Publique uma versao mais nova.' };
    }
    event.sender.send('natal:updateProgress', `Baixando v${updateVersion}...`);
    await baixarAtualizacao();
    updateReady = true;
    isUpdating = false;
    event.sender.send('natal:updateProgress', 'Atualizacao pronta. Reiniciando...');
    setTimeout(() => autoUpdater.quitAndInstall(false, true), 1500);
    return { success: true, installing: true };
  } catch (e) {
    isUpdating = false;
    return { success: false, error: e.message || 'Erro ao atualizar' };
  }
});

autoUpdater.on('update-available', (info) => {
  isUpdating = false;
  updateVersion = (info && info.version) || updateVersion;
  const bloqueada = versaoBloqueada();
  if (bloqueada && updateVersion === bloqueada) {
    console.warn('[AutoUpdate] v' + bloqueada + ' bloqueada apos rollback; ignorando');
    return;
  }
  enviarUpdate('natal:updateAvailable', { version: updateVersion, downloading: true });
  /* baixa em segundo plano: quando terminar, avisa o renderer em qualquer tela */
  baixarAtualizacao().catch((e) => {
    updateDownload = null;
    enviarUpdate('natal:updateError', { error: e.message || 'Falha ao baixar atualizacao' });
  });
});
autoUpdater.on('update-not-available', () => {
  isUpdating = false;
  enviarUpdate('natal:updateNotAvailable', { version: updateVersion });
});
autoUpdater.on('update-downloaded', (info) => {
  updateReady = true;
  isUpdating = false;
  if (info && info.version) updateVersion = info.version;
  enviarUpdate('natal:updateReady', { version: updateVersion });
});
autoUpdater.on('error', (err) => {
  console.error('[AutoUpdate] Erro:', err.message);
  isUpdating = false;
  updateDownload = null;
  enviarUpdate('natal:updateError', { error: err.message });
});

async function performAutoUpdate(force = false) {
  if (updateReady || isUpdating || (updateDownload && !updateReady)) return;
  const agora = Date.now();
  if (!force && agora - ultimaVerificacao < UPDATE_CHECK_MIN_MS) return;
  ultimaVerificacao = agora;
  isUpdating = true;
  autoUpdater.checkForUpdates().catch((e) => {
    console.error('[AutoUpdate] Erro:', e.message);
    isUpdating = false;
  });
}

// ─── 6b. Rollback (guardar instalador de uma versao anterior) ─
// Mantemos uma copia local do instalador da versao atual e da anterior. Se uma
// atualizacao nova quebrar o PDV, o operador volta em segundos pelo
// Config > Sistema ou por um atalho de emergencia na Area de Trabalho, sem
// depender do electron-updater nem da versao nova estar funcionando.
const ROLLBACK_DIR = path.join('C:', 'ProgramData', 'MaxxNatal', 'installers');
const ROLLBACK_KEEP = 3;
const ROLLBACK_DL_TIMEOUT_MS = 180000;
const GH_RELEASES_URL = 'https://api.github.com/repos/Sploit23/Kiosk_Maxx/releases?per_page=40';
const GH_DOWNLOAD_BASE = 'https://github.com/Sploit23/Kiosk_Maxx/releases/download';
const ROLLBACK_UA = 'Maxx-Foto-Vendas-Rollback';

let _rollbackBaixando = false;

function rollbackDirSeguro() {
  try {
    fs.mkdirSync(ROLLBACK_DIR, { recursive: true });
    return ROLLBACK_DIR;
  } catch {
    const alt = path.join(app.getPath('userData'), 'installers');
    try { fs.mkdirSync(alt, { recursive: true }); } catch {}
    return alt;
  }
}

function cmpVersao(a, b) {
  const pa = String(a || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/i, '').split('.').map(n => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

function nomeInstalador(versao) {
  return `Maxx-Foto-Vendas-Setup-${String(versao).replace(/^v/i, '')}.exe`;
}

function hashArquivoSha256(arquivo) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(arquivo);
    stream.on('error', reject);
    stream.on('data', (bloco) => hash.update(bloco));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function hashesRollback() {
  const estado = lerEstadoRollback();
  return estado && estado.hashes && typeof estado.hashes === 'object' ? estado.hashes : {};
}

function registrarHashRollback(versao, sha256) {
  const hashes = { ...hashesRollback(), [String(versao)]: String(sha256 || '').toLowerCase() };
  salvarEstadoRollback({ hashes });
}

// Digest publicado no release (GitHub preenche `digest: sha256:...`).
async function digestInstaladorRemoto(versao) {
  const v = String(versao).replace(/^v/i, '');
  try {
    const bruto = await httpGetTexto(`https://api.github.com/repos/Sploit23/Kiosk_Maxx/releases/tags/v${encodeURIComponent(v)}`);
    const rel = JSON.parse(bruto);
    const asset = (Array.isArray(rel && rel.assets) ? rel.assets : [])
      .find((a) => a && a.name === nomeInstalador(v));
    if (!asset) return null;
    const digest = String(asset.digest || '').toLowerCase();
    return {
      sha256: digest.startsWith('sha256:') ? digest.slice(7) : '',
      size: Number(asset.size) || 0,
    };
  } catch {
    return null;
  }
}

// Confere o instalador salvo antes de executar: hash conhecido localmente, senão
// o digest do release; se não houver internet, guarda o hash do arquivo atual.
async function verificarInstaladorRollback(versao, arquivo) {
  const v = String(versao).replace(/^v/i, '');
  const st = fs.statSync(arquivo);
  if (!st.isFile() || st.size < 1024 * 1024) throw new Error('instalador inválido');
  const sha = await hashArquivoSha256(arquivo);
  const conhecido = String(hashesRollback()[v] || '').toLowerCase();
  if (conhecido) {
    if (conhecido !== sha) throw new Error('instalador corrompido (hash local não confere)');
    return sha;
  }
  const remoto = await digestInstaladorRemoto(v);
  if (remoto && remoto.sha256 && remoto.sha256 !== sha) {
    throw new Error('instalador corrompido (hash do release não confere)');
  }
  registrarHashRollback(v, sha);
  return sha;
}

function arquivoEstadoRollback() {
  return path.join(rollbackDirSeguro(), 'state.json');
}

function lerEstadoRollback() {
  try { return JSON.parse(fs.readFileSync(arquivoEstadoRollback(), 'utf-8')) || {}; } catch { return {}; }
}

function salvarEstadoRollback(patch) {
  try {
    const atual = lerEstadoRollback();
    const novo = { ...atual, ...(patch || {}) };
    fs.writeFileSync(arquivoEstadoRollback(), JSON.stringify(novo, null, 2), 'utf-8');
    return novo;
  } catch (e) {
    console.warn('[Rollback] nao consegui salvar estado: ' + ((e && e.message) || e));
    return lerEstadoRollback();
  }
}

function versaoBloqueada() {
  return String(lerEstadoRollback().blockedVersion || '').replace(/^v/i, '');
}

function listarRollback() {
  const dir = rollbackDirSeguro();
  const atual = app.getVersion();
  const itens = [];
  try {
    for (const nome of fs.readdirSync(dir)) {
      const m = nome.match(/^Maxx-Foto-Vendas-Setup-(.+)\.exe$/i);
      if (!m) continue;
      const versao = m[1].replace(/^v/i, '');
      const completo = path.join(dir, nome);
      let st = null;
      try { st = fs.statSync(completo); } catch { continue; }
      if (!st.isFile() || st.size < 1024 * 1024) continue;
      itens.push({
        version: versao,
        path: completo,
        size: st.size,
        current: cmpVersao(versao, atual) === 0,
        previous: cmpVersao(versao, atual) < 0,
      });
    }
  } catch {}
  itens.sort((a, b) => cmpVersao(b.version, a.version));
  return { current: atual, dir, installers: itens };
}

function podarRollback() {
  try {
    const atual = app.getVersion();
    const antigos = listarRollback().installers
      .filter(i => cmpVersao(i.version, atual) < 0)
      .slice(ROLLBACK_KEEP);
    for (const item of antigos) {
      try { fs.unlinkSync(item.path); } catch {}
    }
  } catch {}
}

function httpGetTexto(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('redirecionamentos demais'));
    const req = https.get(url, { headers: { 'User-Agent': ROLLBACK_UA, Accept: 'application/vnd.github+json' } }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        return resolve(httpGetTexto(next, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let dados = '';
      res.setEncoding('utf8');
      res.on('data', c => { if (dados.length < 4 * 1024 * 1024) dados += c; });
      res.on('end', () => resolve(dados));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => req.destroy(new Error('timeout')));
  });
}

async function versaoAnteriorRemota() {
  const bruto = await httpGetTexto(GH_RELEASES_URL);
  const dados = JSON.parse(bruto);
  const atual = app.getVersion();
  const candidatas = (Array.isArray(dados) ? dados : [])
    .filter(r => r && !r.draft && !r.prerelease && r.tag_name)
    .map(r => ({ version: String(r.tag_name).replace(/^v/i, ''), assets: r.assets || [] }))
    .filter(x => cmpVersao(x.version, atual) < 0)
    .filter(x => x.assets.some(a => a && a.name === nomeInstalador(x.version)))
    .sort((a, b) => cmpVersao(b.version, a.version));
  return candidatas.length ? candidatas[0].version : '';
}

function baixarArquivoInstalador(url, parcial) {
  return new Promise((resolve, reject) => {
    const requisitar = (alvo, redirects = 0) => {
      if (redirects > 5) return reject(new Error('redirecionamentos demais'));
      const req = https.get(alvo, { headers: { 'User-Agent': ROLLBACK_UA } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return requisitar(new URL(res.headers.location, alvo).toString(), redirects + 1);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const out = fs.createWriteStream(parcial);
        let erro = null;
        out.on('error', (e) => { erro = e; });
        res.on('error', (e) => { erro = e; });
        res.pipe(out);
        out.on('finish', () => {
          out.close(() => (erro ? reject(erro) : resolve()));
        });
      });
      req.on('error', reject);
      req.setTimeout(ROLLBACK_DL_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    };
    requisitar(url);
  });
}

async function baixarInstalador(versao) {
  const v = String(versao).replace(/^v/i, '');
  const dir = rollbackDirSeguro();
  const destino = path.join(dir, nomeInstalador(v));
  const esperado = await digestInstaladorRemoto(v).catch(() => null);
  const conferir = async (arquivo) => {
    const st = fs.statSync(arquivo);
    if (st.size < 1024 * 1024) throw new Error('arquivo baixado invalido');
    if (esperado && esperado.size && st.size !== esperado.size) {
      throw new Error('tamanho do instalador nao confere');
    }
    const fd = fs.openSync(arquivo, 'r');
    const buf = Buffer.alloc(2);
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    if (buf[0] !== 0x4d || buf[1] !== 0x5a) throw new Error('download nao e um instalador Windows');
    const sha = await hashArquivoSha256(arquivo);
    if (esperado && esperado.sha256 && esperado.sha256 !== sha) {
      throw new Error('hash do instalador nao confere');
    }
    registrarHashRollback(v, sha);
  };
  if (fs.existsSync(destino)) {
    try {
      await conferir(destino);
      return destino;
    } catch (e) {
      console.warn('[Rollback] instalador salvo invalido (v' + v + '), baixando de novo: ' + ((e && e.message) || e));
      try { fs.unlinkSync(destino); } catch {}
    }
  }
  const url = `${GH_DOWNLOAD_BASE}/v${v}/${nomeInstalador(v)}`;
  const parcial = destino + '.part';
  try {
    await baixarArquivoInstalador(url, parcial);
    await conferir(parcial);
    fs.renameSync(parcial, destino);
    return destino;
  } catch (e) {
    try { fs.unlinkSync(parcial); } catch {}
    throw e;
  }
}

async function garantirRollbackCache(opts = {}) {
  if (!app.isPackaged || _rollbackBaixando) return listarRollback();
  /* No boot baixamos so a versao ANTERIOR (o rollback imediato) e bem depois de
     abrir: o instalador da versao atual pode esperar, para nao consumir rede
     disputando com as vendas/impressao da loja. */
  const somenteAnterior = opts.somenteAnterior === true;
  _rollbackBaixando = true;
  try {
    const atual = app.getVersion();
    const existentes = listarRollback().installers;
    const temAnterior = existentes.some(i => cmpVersao(i.version, atual) < 0);
    /* prioridade: a versao anterior (o rollback imediato). Se nao houver
       nenhuma, pergunta ao GitHub qual e a ultima release publicada abaixo da
       versao atual e baixa o instalador dela. */
    if (!temAnterior) {
      const anterior = await versaoAnteriorRemota().catch((e) => {
        console.warn('[Rollback] nao consegui listar releases: ' + ((e && e.message) || e));
        return '';
      });
      if (anterior) {
        try { await baixarInstalador(anterior); }
        catch (e) { console.warn('[Rollback] falha ao baixar v' + anterior + ': ' + ((e && e.message) || e)); }
      }
    }
    /* guarda tambem o instalador da versao atual, para que a proxima
       atualizacao ja tenha de onde voltar. */
    if (!somenteAnterior && !fs.existsSync(path.join(rollbackDirSeguro(), nomeInstalador(atual)))) {
      try { await baixarInstalador(atual); }
      catch (e) { console.warn('[Rollback] falha ao baixar a versao atual: ' + ((e && e.message) || e)); }
    }
    podarRollback();
  } finally {
    _rollbackBaixando = false;
  }
  return listarRollback();
}

function descreverRollback() {
  return {
    ...listarRollback(),
    blockedVersion: versaoBloqueada(),
    downloading: _rollbackBaixando,
  };
}

ipcMain.handle('natal:rollbackList', () => descreverRollback());

ipcMain.handle('natal:rollbackSeed', async () => {
  try {
    await garantirRollbackCache();
    const anterior = listarRollback().installers.some(i => i.previous);
    return {
      success: true,
      savedPrevious: anterior,
      ...descreverRollback(),
    };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Falha ao salvar instalador', ...descreverRollback() };
  }
});

ipcMain.handle('natal:rollbackInstall', async (_event, version) => {
  try {
    const v = String(version || '').replace(/^v/i, '').trim();
    const alvo = listarRollback().installers.find(i => i.version === v);
    if (!alvo) return { success: false, error: 'Instalador da versao v' + v + ' nao encontrado' };
    if (cmpVersao(v, app.getVersion()) >= 0) {
      return { success: false, error: 'So da para voltar para uma versao anterior a atual' };
    }
    // Instalador adulterado/corrompido não roda. Confere o hash antes.
    try {
      await verificarInstaladorRollback(v, alvo.path);
    } catch (e) {
      return { success: false, error: 'Instalador invalido: ' + ((e && e.message) || e) };
    }
    salvarEstadoRollback({
      blockedVersion: app.getVersion(),
      rolledBackTo: v,
      rolledBackAt: new Date().toISOString(),
    });
    const child = spawn(alvo.path, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    // app.exit() pula o will-quit e deixa sidecar/Java/importador vivos (o
    // sidecar continuaria escrevendo os JSONs enquanto o NSIS troca arquivos).
    // quit() fecha tudo e o will-quit mata a árvore de processos.
    setTimeout(() => { try { app.quit(); } catch { app.exit(0); } }, 1500);
    return { success: true, installing: true, version: v };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Falha ao reinstalar versao anterior' };
  }
});

ipcMain.handle('natal:rollbackUnblock', () => {
  const estado = salvarEstadoRollback({ blockedVersion: '', unblockedAt: new Date().toISOString() });
  return { success: true, blockedVersion: String(estado.blockedVersion || '') };
});

ipcMain.handle('natal:rollbackShortcut', async () => {
  try {
    const prev = listarRollback().installers.find(i => i.previous);
    if (!prev) return { success: false, error: 'Salve um instalador de versao anterior primeiro' };
    const destino = path.join(app.getPath('desktop'), `Restaurar Maxx Foto (v${prev.version}).cmd`);
    const conteudo = `@echo off\r\n"${prev.path}" /S --force-run\r\nexit /b 0\r\n`;
    fs.writeFileSync(destino, conteudo, 'utf-8');
    return { success: true, path: destino, version: prev.version };
  } catch (e) {
    return { success: false, error: (e && e.message) || 'Falha ao criar atalho' };
  }
});

// ─── 7. Lifecycle ───────────────────────────────────────────
app.whenReady().then(() => {
  aplicarPastaDeFotosPadrao();
  startSidecar();
  startJavaSidecar();
  createWindow();
  setTimeout(startImporter, 4000);
  startImporterWatchdog();

  /* Camera no cabo "100% direto": NAO abre sozinha no boot. O operador liga
     pelo botao do painel (ou pela aba Sistema). O watchdog abaixo so age
     enquanto o modo estiver desejado (`digiCamDesejado`). */
  startDigiCamWatchdog();

  /* Verifica no boot e continua procurando sozinho em qualquer tela (intervalo
     curto; performAutoUpdate aplica o throttle de 1 min). */
  setTimeout(() => performAutoUpdate(true), 10000);
  setInterval(() => performAutoUpdate(true), UPDATE_CHECK_MS);

  /* Guarda o instalador da versao atual/anterior para o rollback em segundos.
     Roda em segundo plano, so no app empacotado, e nao bloqueia o boot. */
  setTimeout(() => { garantirRollbackCache({ somenteAnterior: true }).catch(() => {}); }, 300000);

  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});



ipcMain.handle('natal:printBematech', async (_event, payload = {}) => {
  try {
    const printerName = String(payload.printerName || config.thermalPrinterName || '').trim();
    if (!printerName) {
      return { success: false, error: 'IMPRESSORA_TERMICA_NAO_CONFIGURADA' };
    }
    const result = await printBematech({ ...payload, printerName });
    try {
      logMain('[ImpressaoBematech] ' + (result && result.success ? 'ok' : 'falha')
        + ' printer=' + printerName
        + ' doc=' + ((result && result.documentName) || '')
        + (result && result.error ? ' erro=' + result.error : ''));
    } catch (e) {}
    return result;
  } catch (e) {
    try { logMain('[ImpressaoBematech] exc: ' + e.message); } catch (e2) {}
    return { success: false, error: e.message };
  }
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

app.on('will-quit', () => {
  stopImporter();
  if (digiCamWatchdogTimer) clearInterval(digiCamWatchdogTimer);
  for (const [name, proc] of [['Sidecar', sidecarProcess], ['Java', javaProcess]]) {
    if (!proc || !proc.pid) continue;
    console.log(`[${name}] Finalizando...`);
    // proc.kill() no Windows nem sempre mata o node/java filho (que continuaria
    // com a porta e escrevendo os JSONs durante a troca de arquivos do update).
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true });
      else proc.kill();
    } catch { try { proc.kill(); } catch {} }
  }
});
