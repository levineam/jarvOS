'use strict';

// Thin desktop shell: boots the local server in-process, then opens a window on it.
const { app, BrowserWindow, shell, safeStorage, session } = require('electron');
const path = require('path');

const PORT = process.env.PORT || require('../config.json').port;

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 640,
    title: 'jarvOS Desktop',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#0c0e12',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(`http://127.0.0.1:${PORT}`);
  // External links open in the system browser, not the shell window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  process.env.JARVOS_ELECTRON_USER_DATA_DIR = app.getPath('userData');
  require(path.join(__dirname, '..', 'server', 'agent', 'credentials')).setElectronRuntime({
    safeStorage,
    userDataPath: app.getPath('userData'),
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const url = webContents.getURL();
    const local = url.startsWith(`http://127.0.0.1:${PORT}`) || url.startsWith(`http://localhost:${PORT}`);
    callback(permission === 'media' && local);
  });
  require(path.join(__dirname, '..', 'server', 'index.js'));
  // Give the listener a beat before pointing the window at it.
  setTimeout(createWindow, 300);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
