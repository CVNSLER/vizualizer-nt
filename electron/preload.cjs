const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  chooseSavePath: (defaultName, title) => ipcRenderer.invoke('save:choose', { defaultName, title }),
  writeChunk: (chunk) => ipcRenderer.invoke('save:chunk', chunk),
  finishSave: (reveal) => ipcRenderer.invoke('save:finish', { reveal }),
  writeAt: (chunk, position) => ipcRenderer.invoke('save:writeAt', { chunk, position }),
  abortSave: () => ipcRenderer.invoke('save:abort'),
});
