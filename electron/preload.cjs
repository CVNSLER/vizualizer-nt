const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  chooseSavePath: (defaultName, title) => ipcRenderer.invoke('save:choose', { defaultName, title }),
  writeChunk: (chunk) => ipcRenderer.invoke('save:chunk', chunk),
  finishSave: (reveal) => ipcRenderer.invoke('save:finish', { reveal }),
});
