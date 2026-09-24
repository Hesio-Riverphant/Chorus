'use strict';
const I18n = require('../shared/i18n');

const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const persistence = require('./store/persistence');
const { registerIpc } = require('./ipc');
const orchestrator = require('./orchestrator/orchestrator');
const connectionTest = require('./connectionTest');

let mainWindow = null;
let gotLock = false;
let storeLease;
let workbench;
require('./appPaths').configureAppPaths(app);

// Only one instance may run: a second instance with a stale in-memory room
// table could overwrite the active instance's data on flush.
gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(createWindow).catch((err) => {
    console.error('Failed to start:', err);
    dialog.showErrorBox(I18n.t('Chorus 启动失败'), err.message || String(err));
    app.quit();
  });
}

app.on('window-all-closed', () => {
  app.quit();
});

async function createWindow() {
  storeLease = require('./store/storeLease').acquireStoreLease(app.getPath('userData'), { recoverStale: true });
  await persistence.init(app);

  mainWindow = new BrowserWindow({
    width: 1180,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    backgroundColor: '#f4f5f7',
    title: 'Chorus',
    icon: path.join(__dirname, '../renderer/assets/convoke.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());

  registerIpc(mainWindow, persistence);
  workbench = require('./workbench').registerWorkbench(mainWindow, persistence);

  // Diagnostics: surface renderer load failures and console errors in the main log.
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[did-fail-load] ${code} ${desc} ${url}`);
  });
  mainWindow.webContents.on('console-message', (event) => {
    if (['warning', 'error'].includes(event.level)) console.log(`[renderer] ${event.message}`);
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[render-process-gone]', details);
  });

  await mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.center();
  mainWindow.show();
  mainWindow.focus();

  // Deterministic check that the renderer actually rendered content.
  try {
    const report = await mainWindow.webContents.executeJavaScript(
      'JSON.stringify({' +
      ' rooms: document.querySelectorAll("#roomList .side-item").length,' +
      ' bots: document.querySelectorAll("#botList .side-item").length,' +
      ' msgs: document.querySelectorAll("[data-msg-id]").length,' +
      ' hasComposer: !!document.getElementById("input")' +
      '})'
    );
    console.log('[render-ok]', report);
  } catch (err) {
    console.error('[render-check-failed]', err);
  }
}

let closing = false;
let readyToQuit = false;
app.on('will-quit', () => { storeLease?.release(); storeLease = null; });
app.on('before-quit', (event) => {
  if (readyToQuit || !gotLock) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  workbench?.dispose();
  Promise.all([orchestrator.stopAll(), connectionTest.cancel()]).then(() => {
    persistence.flushSync();
    readyToQuit = true;
    app.quit();
  }).catch((err) => {
    closing = false;
    dialog.showErrorBox(I18n.t('Chorus 未能安全退出'), err.message || String(err));
  });
});
