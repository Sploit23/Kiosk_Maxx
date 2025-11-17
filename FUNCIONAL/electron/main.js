const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const https = require('https');

// Global variables
let mainWindow;
let serverProcess;
const isDev = process.argv.includes('--dev');
const SERVER_PORT = 5000;
const enableAutoUpdate = process.env.KIOSK_AUTOUPDATE === '1';

// Auto-updater configuration
if (!isDev && enableAutoUpdate) {
    autoUpdater.setFeedURL({
        provider: 'github',
        owner: 'Sploit23',
        repo: 'kiosk-updates'
    });
    
    // Verificar atualizações após 5 segundos do app iniciar
    setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify();
    }, 5000);
}

// Auto-updater setup
function setupAutoUpdater() {
    if (isDev || !enableAutoUpdate) {
        console.log('Auto-updater desabilitado em modo desenvolvimento');
        return;
    }

    autoUpdater.on('checking-for-update', () => {
        console.log('🔍 Verificando atualizações...');
    });

    autoUpdater.on('update-available', (info) => {
        console.log('✅ Atualização disponível:', info.version);
        if (mainWindow) {
            mainWindow.webContents.send('update-available', info);
        }
    });

    autoUpdater.on('update-not-available', (info) => {
        console.log('ℹ️ Sistema atualizado - versão atual:', info.version);
    });

    autoUpdater.on('error', (err) => {
        console.error('❌ Erro no auto-updater:', err.message);
        if (mainWindow) {
            mainWindow.webContents.send('update-error', err.message);
        }
    });

    autoUpdater.on('download-progress', (progressObj) => {
        const percent = Math.round(progressObj.percent);
        const speed = Math.round(progressObj.bytesPerSecond / 1024);
        console.log(`📥 Download: ${percent}% - ${speed} KB/s`);
        
        if (mainWindow) {
            mainWindow.webContents.send('download-progress', progressObj);
        }
    });

    autoUpdater.on('update-downloaded', (info) => {
        console.log('✅ Atualização baixada e pronta para instalar');
        if (mainWindow) {
            mainWindow.webContents.send('update-downloaded', info);
        }
        
        // Mostrar diálogo para reiniciar
        dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Atualização Pronta',
            message: 'A atualização foi baixada. O aplicativo será reiniciado para aplicar as mudanças.',
            buttons: ['Reiniciar Agora', 'Mais Tarde']
        }).then((result) => {
            if (result.response === 0) {
                autoUpdater.quitAndInstall();
            }
        });
    });
}

// Portable updater (manual for portable builds)
function fetchLatestRelease(owner, repo) {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      headers: { 'User-Agent': 'kiosk-updater' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function downloadPortableZip(assetUrl, destZip) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destZip);
    https.get(assetUrl, { headers: { 'User-Agent': 'kiosk-updater' } }, (res) => {
      if (res.statusCode !== 302 && res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const finalUrl = res.headers.location || assetUrl;
      const getStream = (urlToGet) => {
        https.get(urlToGet, { headers: { 'User-Agent': 'kiosk-updater' } }, (rs) => {
          rs.pipe(file);
          rs.on('error', reject);
          file.on('finish', () => file.close(() => resolve(destZip)));
        }).on('error', reject);
      };
      if (res.headers.location) {
        getStream(res.headers.location);
      } else {
        res.pipe(file);
        res.on('error', reject);
        file.on('finish', () => file.close(() => resolve(destZip)));
      }
    }).on('error', reject);
  });
}

function expandZipWithPowerShell(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
    const child = spawn(cmd, { shell: true });
    child.on('exit', (code) => code === 0 ? resolve(destDir) : reject(new Error(`Expand-Archive failed ${code}`)));
    child.on('error', reject);
  });
}

function findExeRecursive(rootDir) {
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.exe')) return p;
    }
  }
  return null;
}

function findZipInDirectory(rootDir) {
  const stack = [rootDir];
  let candidate = null;
  while (stack.length) {
    const dir = stack.pop();
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.zip')) {
        const stat = fs.statSync(p);
        if (!candidate || stat.mtimeMs > candidate.mtimeMs) {
          candidate = { path: p, mtimeMs: stat.mtimeMs };
        }
      }
    }
  }
  return candidate ? candidate.path : null;
}

async function applyUpdateZipPath(zipPath) {
  if (!zipPath || !fs.existsSync(zipPath)) throw new Error('Arquivo .zip inválido');
  const userDataPath = app.getPath('userData');
  const stamp = String(Date.now());
  const baseName = path.basename(zipPath, path.extname(zipPath));
  const updatesDir = path.join(userDataPath, 'updates', `${baseName}-${stamp}`);
  fs.mkdirSync(updatesDir, { recursive: true });
  await expandZipWithPowerShell(zipPath, updatesDir);
  const exePath = findExeRecursive(updatesDir);
  if (!exePath) throw new Error('Executável não encontrado após extração');
  spawn(exePath, { detached: true, cwd: path.dirname(exePath), stdio: 'ignore' }).unref();
  app.quit();
  return exePath;
}

ipcMain.handle('check-portable-update', async () => {
  try {
    const info = await fetchLatestRelease('Sploit23', 'kiosk-updates');
    const assets = info.assets || [];
    const portableZip = assets.find(a => /portable|win-unpacked/i.test(a.name) && /\.zip$/i.test(a.name));
    return { tag: info.tag_name, name: info.name, asset: portableZip ? { name: portableZip.name, url: portableZip.browser_download_url } : null };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('download-portable-update', async () => {
  try {
    const latest = await fetchLatestRelease('Sploit23', 'kiosk-updates');
    const assets = latest.assets || [];
    const asset = assets.find(a => /portable|win-unpacked/i.test(a.name) && /\.zip$/i.test(a.name));
    if (!asset) return { success: false, error: 'Nenhum pacote portátil (.zip) encontrado' };
    const userDataPath = app.getPath('userData');
    const updatesDir = path.join(userDataPath, 'updates', latest.tag_name || String(Date.now()));
    fs.mkdirSync(updatesDir, { recursive: true });
    const zipPath = path.join(updatesDir, asset.name);
    await downloadPortableZip(asset.browser_download_url, zipPath);
    await expandZipWithPowerShell(zipPath, updatesDir);
    const exePath = findExeRecursive(updatesDir);
    if (!exePath) return { success: false, error: 'Executável não encontrado após extração' };
    spawn(exePath, { detached: true, cwd: path.dirname(exePath), stdio: 'ignore' }).unref();
    app.quit();
    return { success: true, launched: exePath };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('select-update-zip', async () => {
  const desktop = app.getPath('desktop');
  const downloads = app.getPath('downloads');
  const defaultPath = fs.existsSync(desktop) ? desktop : (fs.existsSync(downloads) ? downloads : undefined);
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile', 'openDirectory'],
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
    title: 'Selecionar pacote de atualização (.zip)',
    defaultPath
  });
  if (result.canceled || !result.filePaths || !result.filePaths.length) {
    return { canceled: true };
  }
  const sel = result.filePaths[0];
  try {
    const stat = fs.statSync(sel);
    if (stat.isDirectory()) {
      const found = findZipInDirectory(sel);
      if (found) return { path: found };
      return { error: 'Nenhum .zip encontrado na pasta selecionada' };
    }
    return { path: sel };
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('apply-update-zip', async (event, zipPath) => {
  try {
    const launched = await applyUpdateZipPath(zipPath);
    return { success: true, launched };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Adicionar após as importações
function initializeUserData() {
    const userDataPath = app.getPath('userData');
    const configDir = path.join(userDataPath, 'config');
    const themesDir = path.join(configDir, 'temas');

    // Se a pasta de configuração já existe, não faz nada
    if (fs.existsSync(configDir)) {
        console.log(`✅ Pasta de configuração já existe em: ${configDir}`);
        
        // Garantir que a subpasta de temas também exista
        if (!fs.existsSync(themesDir)) {
            console.log(`🔧 Criando subpasta de temas em: ${themesDir}`);
            fs.mkdirSync(themesDir, { recursive: true });
            
            // Copiar apenas o header_themes.json se a pasta principal já existir
            const sourceThemesFile = path.join(__dirname, '../../config/temas/header_themes.json');
            const destThemesFile = path.join(themesDir, 'header_themes.json');
            if (fs.existsSync(sourceThemesFile) && !fs.existsSync(destThemesFile)) {
                fs.copyFileSync(sourceThemesFile, destThemesFile);
                console.log('✅ Arquivo de temas copiado para userData.');
            }
        }
        
        return;
    }

    console.log(`🚀 Primeira execução detectada. Inicializando configurações em: ${userDataPath}`);

    // Criar as pastas de configuração
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(themesDir, { recursive: true });

    // Definir caminho de origem dos arquivos de configuração
    const sourceConfigDir = isDev 
        ? path.join(__dirname, '../../config') 
        : path.join(process.resourcesPath, 'config');

    if (!fs.existsSync(sourceConfigDir)) {
        console.error(`❌ ERRO CRÍTICO: Pasta de configuração de origem não encontrada em: ${sourceConfigDir}`);
        // Tentar um caminho alternativo para pacotes asar
        const fallbackSource = path.join(process.resourcesPath, 'app.asar', 'config');
        if (fs.existsSync(fallbackSource)) {
            console.log('🔄 Usando caminho alternativo para asar:', fallbackSource);
            sourceConfigDir = fallbackSource;
        } else {
            return; // Não pode continuar se os arquivos de origem não existem
        }
    }
    
    console.log(`📂 Copiando de: ${sourceConfigDir}`);
    console.log(`📂 Para: ${configDir}`);

    try {
        // Listar e copiar arquivos da raiz de /config
        const rootConfigFiles = fs.readdirSync(sourceConfigDir).filter(file => 
            fs.lstatSync(path.join(sourceConfigDir, file)).isFile()
        );

        for (const file of rootConfigFiles) {
            const sourceFile = path.join(sourceConfigDir, file);
            const destFile = path.join(configDir, file);
            fs.copyFileSync(sourceFile, destFile);
            console.log(`  - Copiado: ${file}`);
        }

        // Listar e copiar arquivos de /config/temas
        const sourceThemesDir = path.join(sourceConfigDir, 'temas');
        if (fs.existsSync(sourceThemesDir)) {
            const themeFiles = fs.readdirSync(sourceThemesDir);
            for (const file of themeFiles) {
                const sourceFile = path.join(sourceThemesDir, file);
                const destFile = path.join(themesDir, file);
                fs.copyFileSync(sourceFile, destFile);
                console.log(`  - Copiado: temas/${file}`);
            }
        }
        
        console.log('✅ Configurações iniciais copiadas com sucesso!');

    } catch (error) {
        console.error('❌ Erro ao copiar arquivos de configuração:', error);
        dialog.showErrorBox('Erro na Inicialização', 'Não foi possível copiar os arquivos de configuração necessários. O aplicativo pode não funcionar corretamente.');
    }
}

// Start internal server
function startServer() {
    // Detectar se o app está empacotado
    const isPackaged = app.isPackaged;
    let serverPath;
    
    if (isPackaged) {
        // Em produção, o servidor está dentro do app.asar
        serverPath = path.join(process.resourcesPath, 'app.asar', 'src', 'server', 'server-simple.js');
    } else {
        // Em desenvolvimento, usar caminho relativo
        serverPath = path.join(__dirname, '../server/server-simple.js');
    }
    
    console.log('Iniciando servidor interno...');
    console.log('App empacotado:', isPackaged);
    console.log('Caminho do servidor:', serverPath);
    
    try {
        // Importar e executar o servidor diretamente no processo principal
        require(serverPath);
        console.log('✅ Servidor iniciado com sucesso!');
    } catch (error) {
        console.error('❌ Erro ao iniciar servidor:', error);
        console.error('Detalhes do erro:', error.message);
        
        // Em aplicações empacotadas, o Node.js está embutido no Electron
        // Não precisamos de fallback com spawn, apenas reportar o erro
        if (isPackaged) {
            console.error('❌ Falha crítica: Servidor não pode ser iniciado no executável');
            console.error('Verifique se todos os arquivos necessários estão incluídos no build');
        } else {
            // Fallback apenas para desenvolvimento
            console.log('🔄 Tentando método alternativo...');
            
            serverProcess = spawn('node', [serverPath], {
                stdio: 'inherit',
                cwd: path.dirname(serverPath)
            });

            serverProcess.on('error', (error) => {
                console.error('Erro no fallback:', error);
            });

            serverProcess.on('exit', (code) => {
                console.log(`Servidor encerrado com código: ${code}`);
            });
        }
    }
}

// Create main window
// Adicionar após as importações existentes
const { exec } = require('child_process');

// Adicionar nova função após setupAutoUpdater()
function setupKioskMode() {
    // Opção para modo kiosk nativo do Electron
    if (process.argv.includes('--kiosk-mode')) {
        mainWindow.setKiosk(true);
        console.log('Modo kiosk ativado');
    }
}

// Adicionar IPC handler para modo kiosk
ipcMain.handle('toggle-kiosk-mode', () => {
    if (mainWindow) {
        const isKiosk = mainWindow.isKiosk();
        mainWindow.setKiosk(!isKiosk);
        return !isKiosk;
    }
    return false;
});

// Adicionar IPC handler para compilar Java
// Handler IPC compile-java-scripts removido - dependia de scripts Java ausentes

function createWindow() {
    // Detectar se o app está empacotado
    const isPackaged = app.isPackaged;
    let preloadPath, iconPath;
    
    if (isPackaged) {
        preloadPath = path.join(process.resourcesPath, 'app.asar', 'src', 'electron', 'preload.js');
        iconPath = path.join(process.resourcesPath, 'app.asar', 'src', 'ui', 'static', 'images', 'icon.png');
        
        // Verificar se o arquivo preload.js existe
        const fs = require('fs');
        if (fs.existsSync(preloadPath)) {
            console.log('✅ Arquivo preload.js encontrado:', preloadPath);
        } else {
            console.error('❌ Arquivo preload.js NÃO encontrado:', preloadPath);
            
            // Tentar encontrar o arquivo em caminhos alternativos
            const alternativePaths = [
                path.join(process.resourcesPath, 'app', 'src', 'electron', 'preload.js'),
                path.join(app.getAppPath(), 'src', 'electron', 'preload.js'),
                path.join(__dirname, 'preload.js')
            ];
            
            for (const altPath of alternativePaths) {
                if (fs.existsSync(altPath)) {
                    console.log('✅ Arquivo preload.js encontrado em caminho alternativo:', altPath);
                    preloadPath = altPath;
                    break;
                }
            }
        }
    } else {
        preloadPath = path.join(__dirname, 'preload.js');
        iconPath = path.join(__dirname, '../ui/static/images/icon.png');
    }
    
    // Verificar e logar o caminho do preload
    console.log('Caminho final do preload:', preloadPath);
    console.log('Arquivo preload existe?', fs.existsSync(preloadPath));
    
    if (!fs.existsSync(preloadPath)) {
        console.error('❌ ERRO CRÍTICO: Arquivo preload.js não encontrado!');
        console.log('Tentando caminhos alternativos...');
        
        const emergencyPaths = [
            path.join(__dirname, 'preload.js'),
            path.join(process.cwd(), 'src', 'electron', 'preload.js'),
            path.join(app.getAppPath(), 'preload.js')
        ];
        
        for (const emergencyPath of emergencyPaths) {
            console.log('Testando caminho de emergência:', emergencyPath);
            if (fs.existsSync(emergencyPath)) {
                console.log('✅ Encontrado em caminho de emergência!');
                preloadPath = emergencyPath;
                break;
            }
        }
    }
    
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 800,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            enableRemoteModule: false,
            preload: preloadPath,
            webSecurity: true,
            sandbox: false
        },
        icon: iconPath,
        show: false,
        titleBarStyle: 'default',
        autoHideMenuBar: !isDev,
        fullscreen: true
    });

    // Load the app
    mainWindow.loadURL(`http://localhost:${SERVER_PORT}`);

    // Show window when ready
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
        
        if (isDev) {
            mainWindow.webContents.openDevTools();
        }
        
        setupKioskMode();
    });

    // Handle window closed
    mainWindow.on('closed', () => {
        mainWindow = null;
    });

    // Handle external links
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        shell.openExternal(url);
        return { action: 'deny' };
    });

    // Remove menu in production
    if (!isDev) {
        Menu.setApplicationMenu(null);
    }

    console.log('Janela principal criada');
}

// IPC Handlers
ipcMain.handle('check-for-updates', async () => {
    try {
        return await autoUpdater.checkForUpdatesAndNotify();
    } catch (error) {
        console.error('Erro ao verificar atualizações:', error);
        throw error;
    }
});

ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('toggle-fullscreen', () => {
    if (mainWindow) {
        const current = mainWindow.isFullScreen();
        mainWindow.setFullScreen(!current);
        return !current;
    }
    return false;
});

ipcMain.handle('exit-fullscreen', () => {
    if (mainWindow) {
        mainWindow.setFullScreen(false);
        return true;
    }
    return false;
});

ipcMain.handle('get-fullscreen', () => {
    if (mainWindow) {
        return mainWindow.isFullScreen();
    }
    return false;
});

// New IPC handlers for folder selection and app control
ipcMain.handle('select-directory', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openDirectory'],
            title: 'Selecionar pasta de imagens'
        });
        return result;
    } catch (error) {
        console.error('Erro ao selecionar diretório:', error);
        throw error;
    }
});

ipcMain.handle('restart-app', () => {
    app.relaunch();
    app.exit();
});

ipcMain.handle('quit-app', () => {
    app.quit();
});

ipcMain.handle('show-user-data-path', () => {
    const userDataPath = app.getPath('userData');
    shell.showItemInFolder(userDataPath);
    return userDataPath;
});

ipcMain.handle('toggle-dev-tools', () => {
    if (mainWindow) {
        if (mainWindow.webContents.isDevToolsOpened()) {
            mainWindow.webContents.closeDevTools();
        } else {
            mainWindow.webContents.openDevTools();
        }
    }
});

// App event handlers
app.whenReady().then(() => {
    initializeUserData();
    if (enableAutoUpdate) {
        setupAutoUpdater();
    }
    const zipArg = process.argv.find(a => a.startsWith('--update-zip'));
    if (zipArg) {
        let zipPath = null;
        if (zipArg.includes('=')) {
            zipPath = zipArg.split('=')[1];
        } else {
            const idx = process.argv.indexOf(zipArg);
            if (idx >= 0 && process.argv[idx + 1]) zipPath = process.argv[idx + 1];
        }
        if (zipPath) {
            applyUpdateZipPath(path.resolve(zipPath)).catch(err => {
                dialog.showErrorBox('Atualização', `Falha ao aplicar atualização: ${err.message}`);
            });
            return; // Não iniciar servidor/janela; o app será encerrado após iniciar o novo exe
        }
    }
    startServer();
    
    // Wait for server to start before creating window
    setTimeout(() => {
        createWindow();
    }, 3000);
});

app.on('window-all-closed', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
    
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', () => {
    if (serverProcess) {
        serverProcess.kill();
    }
});

// Security: Prevent new window creation
app.on('web-contents-created', (event, contents) => {
    contents.on('new-window', (navigationEvent, navigationURL) => {
        navigationEvent.preventDefault();
        shell.openExternal(navigationURL);
    });

    contents.on('will-navigate', (navigationEvent, navigationURL) => {
        const parsedUrl = new URL(navigationURL);
        if (parsedUrl.origin !== `http://localhost:${SERVER_PORT}`) {
            navigationEvent.preventDefault();
        }
    });
});

console.log('Photo Kiosk Desktop iniciado');
console.log('Versão:', app.getVersion());
console.log('Modo desenvolvimento:', isDev);

// Adicionar após as outras funções IPC
ipcMain.handle('navigate-to-home', async () => {
    try {
        if (mainWindow) {
            await mainWindow.loadURL(`http://localhost:${SERVER_PORT}/`);
            return { success: true };
        }
        return { success: false, error: 'Janela principal não encontrada' };
    } catch (error) {
        console.error('Erro na navegação:', error);
        return { success: false, error: error.message };
    }
});