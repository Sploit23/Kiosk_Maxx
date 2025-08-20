const { app, BrowserWindow, Menu, dialog, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');

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

// Global variables
let mainWindow;
let serverProcess;
const isDev = process.argv.includes('--dev');
const SERVER_PORT = 5000;

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
    const serverPath = path.join(__dirname, '../server/server-simple.js');
    
    console.log('Iniciando servidor interno...');
    console.log('Caminho do servidor:', serverPath);
    
    serverProcess = spawn('node', [serverPath], {
        stdio: 'inherit',
        cwd: path.dirname(serverPath)
    });

    serverProcess.on('error', (error) => {
        console.error('Erro ao iniciar servidor:', error);
    });

    serverProcess.on('exit', (code) => {
        console.log(`Servidor encerrado com código: ${code}`);
    });
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
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: true
        },
        icon: path.join(__dirname, '../ui/static/images/icon.png'),
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