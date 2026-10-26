const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

let config = {};
try {
  const programDataPath = path.join('C:', 'ProgramData', 'MaxxNatal', 'electron-config.json');
  const localPath = path.join(__dirname, 'electron-config.json');
  const tplPath = path.join(__dirname, 'electron-config.template.json');
  const configPath = fs.existsSync(programDataPath) ? programDataPath
    : fs.existsSync(localPath) ? localPath
    : fs.existsSync(tplPath) ? tplPath
    : null;
  if (configPath) config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
} catch {}

contextBridge.exposeInMainWorld('natal', {
  ipcInvoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  ipcSend: (channel, ...args) => ipcRenderer.send(channel, ...args),
  on: (channel, handler) => {
    const wrapped = (_event, ...rest) => handler(...rest);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  // Apenas o que o React precisa. Secrets (se houver) ficam no main.
  getConfig: () => ({
    serverUrl: config.serverUrl,
    thermalPrinterName: config.thermalPrinterName,
    pdvNome: config.pdvNome,
    portalApiUrl: config.portalApiUrl,
    galeriaNatalUrl: config.galeriaNatalUrl || '',
    lojaId: config.lojaId,
    lojaNome: config.lojaNome || '',
    pairingCode: config.pairingCode || '',
    photosFolder: config.photosFolder || '',
    logoTexto: config.logoTexto || 'SHOPPING PALLADIUM',
  }),
  selectFolder: () => ipcRenderer.invoke('natal:selectFolder'),
  saveConfig: (partial) => ipcRenderer.invoke('natal:saveConfig', partial),
  printBematech: (texto) => ipcRenderer.invoke('natal:printBematech', { texto }),
  restartImporter: () => ipcRenderer.invoke('natal:restartImporter'),
  importerInfo: () => ipcRenderer.invoke('natal:importerInfo'),
  openImporterLog: () => ipcRenderer.invoke('natal:openImporterLog'),
  openPath: (target) => ipcRenderer.invoke('natal:openPath', target),
});
