const { contextBridge, ipcRenderer } = require('electron');

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
    navigateToHome: () => ipcRenderer.invoke('navigate-to-home')
});

// Log de inicialização do preload
console.log('Preload script carregado');