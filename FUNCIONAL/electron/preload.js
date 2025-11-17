const { contextBridge, ipcRenderer } = require('electron');

console.log('🔧 Preload script iniciando...');
console.log('🔧 contextBridge disponível:', typeof contextBridge);
console.log('🔧 ipcRenderer disponível:', typeof ipcRenderer);

try {
    contextBridge.exposeInMainWorld('electronAPI', {
        // Existing updater functions
        checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
        getAppVersion: () => ipcRenderer.invoke('get-app-version'),
        onDownloadProgress: (callback) => ipcRenderer.on('download-progress', callback),
        onUpdateAvailable: (callback) => ipcRenderer.on('update-available', callback),
        onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', callback),
        
        // New functions for app control and folder selection
        selectDirectory: () => ipcRenderer.invoke('select-directory'),
        restartApp: () => ipcRenderer.invoke('restart-app'),
        quitApp: () => ipcRenderer.invoke('quit-app'),
        showUserDataPath: () => ipcRenderer.invoke('show-user-data-path'),
        toggleDevTools: () => ipcRenderer.invoke('toggle-dev-tools'),
        
        // Função para navegação
        navigateToHome: () => ipcRenderer.invoke('navigate-to-home'),
        toggleFullScreen: () => ipcRenderer.invoke('toggle-fullscreen'),
        exitFullScreen: () => ipcRenderer.invoke('exit-fullscreen'),
        getFullScreen: () => ipcRenderer.invoke('get-fullscreen'),
        checkPortableUpdate: () => ipcRenderer.invoke('check-portable-update'),
        downloadPortableUpdate: () => ipcRenderer.invoke('download-portable-update'),
        selectUpdateZip: () => ipcRenderer.invoke('select-update-zip'),
        applyUpdateZip: (zipPath) => ipcRenderer.invoke('apply-update-zip', zipPath)
    });
    
    console.log('✅ electronAPI exposto com sucesso!');
} catch (error) {
    console.error('❌ Erro ao expor electronAPI:', error);
}

// Log de inicialização do preload
console.log('Preload script carregado');
console.log('electronAPI exposto:', typeof window !== 'undefined' ? 'window existe' : 'window não existe');

// Verificar se a API foi exposta corretamente após um tempo
setTimeout(() => {
    if (typeof window !== 'undefined') {
        console.log('Verificação após timeout: electronAPI disponível:', typeof window.electronAPI !== 'undefined');
    }
}, 2000);