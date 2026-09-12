'use strict';

// Thin desktop shell: boots the local server in-process, then opens a window on it.
const { app, BrowserWindow, shell, safeStorage, session } = require('electron');
const path = require('path');
const fs = require('fs');

if (process.env.JARVOS_ELECTRON_USER_DATA_DIR) {
  const userData = path.resolve(process.env.JARVOS_ELECTRON_USER_DATA_DIR);
  fs.mkdirSync(userData, { recursive: true, mode: 0o700 });
  app.setPath('userData', userData);
}

const { loadConfig } = require('../server/config');
const PORT = loadConfig().port;

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
    let local = false;
    try {
      const u = new URL(webContents.getURL());
      local =
        (u.hostname === '127.0.0.1' || u.hostname === 'localhost') &&
        u.port === String(PORT) &&
        (u.protocol === 'http:' || u.protocol === 'https:');
    } catch {
      /* malformed URL -> not local */
    }
    callback(permission === 'media' && local);
  });
  const { server } = require(path.join(__dirname, '..', 'server', 'index.js'));
  server.once('error', () => app.exit(1));
  server.once('listening', createWindow);
  app.on('activate', () => {
    if (server.listening && BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
