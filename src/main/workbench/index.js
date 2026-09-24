'use strict';
const I18n = require('../../shared/i18n');

const path = require('node:path');
const { spawn } = require('node:child_process');
const { roomDirectory, projectPath } = require('./paths');
const files = require('./files');
const { TerminalService } = require('./terminals');
const { BrowserService, browserUrl } = require('./browsers');

const DEFAULT_LAYOUT = Object.freeze({ sidebarWidth: 236, dockWidth: 430, bottomHeight: 240,
  sidebarCollapsed: false, dockOpen: false, bottomOpen: false, dockMaximized: false });

function normalizeLayout(value) {
  const source = value && typeof value === 'object' ? value : {};
  const result = { ...DEFAULT_LAYOUT };
  for (const [key, min, max] of [['sidebarWidth', 160, 480], ['dockWidth', 280, 1400], ['bottomHeight', 120, 900]]) {
    if (Number.isFinite(source[key])) result[key] = Math.max(min, Math.min(max, Math.round(source[key])));
  }
  for (const key of ['sidebarCollapsed', 'dockOpen', 'bottomOpen', 'dockMaximized']) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  return result;
}

function registerWorkbench(win, persistence, options = {}) {
  const { ipcMain, shell, dialog, WebContentsView } = options.electron || require('electron');
  const projectRoot = options.projectRoot || path.resolve(__dirname, '..', '..', '..');
  const emit = payload => { if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('workbench:event', payload); };
  const terminals = new TerminalService({ emit, ptyModule: options.ptyModule });
  const browsers = new BrowserService({ win, WebContentsView, emit });
  let generation = 0;
  const directory = roomId => roomDirectory(persistence, roomId, projectRoot);
  const validSource = event => {
    if (event.sender !== win.webContents || (event.senderFrame && event.senderFrame !== win.webContents.mainFrame)) throw new Error(I18n.t('请求来源无效'));
  };
  const operations = {
    'layout:get': () => normalizeLayout(persistence.getSettings().workbenchLayout),
    'layout:save': payload => persistence.saveSettings({ workbenchLayout: normalizeLayout(payload.layout) }).workbenchLayout,
    'terminal:create': async payload => {
      const started = generation;
      const cwd = await directory(payload.roomId);
      if (started !== generation || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error(I18n.t('工作台已重置，请重新打开终端'));
      return terminals.create({ ...payload, cwd });
    },
    'terminal:ready': payload => terminals.ready(payload.id),
    'terminal:write': payload => terminals.write(payload.id, payload.data),
    'terminal:ack': payload => terminals.acknowledge(payload.id, payload.length),
    'terminal:resize': payload => terminals.resize(payload.id, payload),
    'terminal:close': payload => terminals.close(payload.id),
    'browser:create': payload => browsers.create(payload.id),
    'browser:navigate': payload => browsers.navigate(payload.id, payload.url),
    'browser:action': payload => browsers.action(payload.id, payload.action),
    'browser:bounds': payload => browsers.bounds(payload.id, payload),
    'browser:close': payload => browsers.close(payload.id),
    'browser:external': payload => shell.openExternal(browserUrl(payload.url)),
    'files:list': async payload => files.listFiles(await directory(payload.roomId), payload.path),
    'files:read': async payload => files.readFile(await directory(payload.roomId), payload.path),
    'files:changes': async payload => files.changes(await directory(payload.roomId)),
    'files:diff': async payload => files.diff(await directory(payload.roomId), payload.path),
    'files:pick': async payload => {
      const root = await directory(payload.roomId);
      const result = await dialog.showOpenDialog(win, { title: I18n.t('打开项目文件'), defaultPath: root, properties: ['openFile'] });
      if (result.canceled || !result.filePaths.length) return null;
      return { path: path.relative(root, await projectPath(root, result.filePaths[0])) };
    },
    'files:open': async payload => {
      const target = await projectPath(await directory(payload.roomId), payload.path);
      if (payload.action === 'reveal') { shell.showItemInFolder(target); return; }
      if (payload.action === 'choose') {
        const result = await dialog.showOpenDialog(win, { title: I18n.t('选择用于打开此文件的应用'), properties: ['openFile'],
          ...(process.platform === 'win32' ? { filters: [{ name: I18n.t('应用程序'), extensions: ['exe'] }] } : {}) });
        if (result.canceled || !result.filePaths.length) return;
        const executable = result.filePaths[0];
        if (process.platform === 'win32' && path.extname(executable).toLowerCase() !== '.exe') throw new Error(I18n.t('请选择可执行应用程序'));
        await new Promise((resolve, reject) => {
          const child = spawn(executable, [target], { detached: true, windowsHide: false, stdio: 'ignore', shell: false });
          child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
        });
        return;
      }
      if (payload.action !== 'default') throw new Error(I18n.t('打开方式无效'));
      const error = await shell.openPath(target); if (error) throw new Error(error);
    },
  };
  ipcMain.handle('workbench:request', (event, payload) => {
    validSource(event);
    if (!payload || typeof payload !== 'object' || !Object.hasOwn(operations, payload.operation)) throw new Error(I18n.t('工作台操作无效'));
    return operations[payload.operation](payload);
  });
  const dispose = () => { generation++; terminals.dispose(); return browsers.dispose(); };
  win.webContents.on('render-process-gone', dispose);
  win.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) dispose(); });
  win.once('closed', () => { dispose(); ipcMain.removeHandler('workbench:request'); });
  return { dispose, terminals, browsers };
}

module.exports = { registerWorkbench, normalizeLayout, DEFAULT_LAYOUT };
