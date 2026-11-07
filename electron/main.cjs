const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 650,
    backgroundColor: '#0d0f14',
    title: 'Vizualizator',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

// Save the finished video. Receives the file as chunks to keep IPC messages small.
let pending = null;
ipcMain.handle('save:choose', async (_e, { defaultName, title }) => {
  const res = await dialog.showSaveDialog({
    title,
    defaultPath: path.join(app.getPath('videos'), defaultName),
    filters: [{ name: 'MP4', extensions: ['mp4'] }],
  });
  if (res.canceled || !res.filePath) return null;
  pending = { file: res.filePath, fd: fs.openSync(res.filePath, 'w') };
  return res.filePath;
});
ipcMain.handle('save:chunk', async (_e, chunk) => {
  if (!pending) throw new Error('no file');
  fs.writeSync(pending.fd, Buffer.from(chunk));
  return true;
});
ipcMain.handle('save:finish', async (_e, { reveal }) => {
  if (!pending) return false;
  fs.closeSync(pending.fd);
  if (reveal) shell.showItemInFolder(pending.file);
  pending = null;
  return true;
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
