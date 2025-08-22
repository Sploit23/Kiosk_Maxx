const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Global variables
let mainWindow;
let serverProcess;
const isDev = process.argv.includes('--dev');
const SERVER_PORT = 5000;

// Auto-updater configuration
if (!isDev) {
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
    if (isDev) {
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
        
        // Fallback: tentar com spawn se require falhar
        console.log('🔄 Tentando método alternativo...');
        
        let nodeExecutable;
        if (isPackaged) {
            nodeExecutable = process.execPath.replace('Photo Kiosk Desktop.exe', 'node.exe');
        } else {
            nodeExecutable = 'node';
        }
        
        serverProcess = spawn(nodeExecutable, [serverPath], {
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
ipcMain.handle('compile-java-scripts', async () => {
    return new Promise((resolve, reject) => {
        const javaDir = path.join(__dirname, '../printer/impressora/ask300');
        exec('javac *.java', { cwd: javaDir }, (error, stdout, stderr) => {
            if (error) {
                console.error('Erro ao compilar Java:', error);
                reject(error);
            } else {
                console.log('Scripts Java compilados com sucesso');
                resolve({ success: true, output: stdout });
            }
        });
    });
});

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
    
    // Create the browser window
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
            sandbox: false // Desabilitar sandbox para garantir que o preload funcione
        },
        icon: iconPath,
        show: false,
        titleBarStyle: 'default',
        autoHideMenuBar: !isDev
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
    setupAutoUpdater();
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