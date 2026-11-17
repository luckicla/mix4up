'use strict';
// Lo que la página de Mix4Up puede pedirle a la app de escritorio
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('Mix4UpShell', {
  info: () => ipcRenderer.invoke('shell', 'info'),
  check: () => ipcRenderer.invoke('shell', 'check'),
  install: () => ipcRenderer.invoke('shell', 'install'),
  state: () => ipcRenderer.invoke('shell', 'state'),
  login: () => ipcRenderer.invoke('shell', 'login'),
  logout: () => ipcRenderer.invoke('shell', 'logout'),
  pickFolder: () => ipcRenderer.invoke('shell', 'pickFolder'),
  quit: () => ipcRenderer.invoke('shell', 'quit'),
  // la ventana: 'min' | 'max' (cambia) | 'close' | '' (solo cómo está) → { max, full }
  win: what => ipcRenderer.invoke('shell', 'win', what || ''),
  onWin: cb => { const f = (_e, s) => cb(s); ipcRenderer.on('shell-win', f); return () => ipcRenderer.removeListener('shell-win', f); },
  onUpdate: cb => { const f = (_e, s) => cb(s); ipcRenderer.on('shell-update', f); return () => ipcRenderer.removeListener('shell-update', f); },
});
