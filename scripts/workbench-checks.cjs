'use strict';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const http = require('node:http');
const { app, BrowserWindow } = require('electron');
const directory = process.env.AR_WORKBENCH_UI_DATA_DIR;
if (!directory || path.dirname(directory) !== os.tmpdir() || !path.basename(directory).startsWith('convoke-workbench-ui-')) throw new Error('Run with node scripts/run-workbench-ui.js');
process.env.AR_DATA_DIR = directory; app.setPath('userData', path.join(directory, 'electron'));
const project = path.join(directory, 'project'); fs.mkdirSync(project); fs.writeFileSync(path.join(project, 'fixture.txt'), 'Visible synthetic project file\n');
require('../src/main/cliDiscovery').discoverClis = async () => [];
require('../src/main/modelCatalog').discoverModels = async () => ({ models: [], notice: '' });
require('../src/main/skills/skillDiscovery').scan = async () => ({ skills: [], roots: [], warnings: [] });
const persistence = require('../src/main/store/persistence');
const { registerIpc } = require('../src/main/ipc');
const { registerWorkbench } = require('../src/main/workbench');
let workbench, server;
const results = [], rendererErrors = [];
const check = (name, ok) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
const watchdog = setTimeout(() => { console.error('FAIL workbench UI timed out'); app.exit(2); }, 60000);
process.on('exit', () => { clearTimeout(watchdog); clearInterval(persistence.timer); workbench?.dispose(); server?.close(); });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 7000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await predicate()) return true; await delay(50); } return false; }
app.whenReady().then(async () => {
  await persistence.init(app); persistence.saveSettings({ defaultCwd: project, enabledCliIds: [] });
  persistence.saveRoom({ ...persistence.listRooms()[0], cwd: project });
  const win = new BrowserWindow({ width: 1280, height: 850, show: false, webPreferences: {
    preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } });
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  const events = [], send = win.webContents.send.bind(win.webContents);
  win.webContents.send = (channel, value) => { if (channel === 'workbench:event') events.push(value); send(channel, value); };
  registerIpc(win, persistence);
  const nativePty = require('node-pty');
  // Preserve the actual ConPTY/xterm transport while avoiding user shell profile
  // scripts in this isolated synthetic test.
  workbench = registerWorkbench(win, persistence, { ptyModule: { spawn(executable, args, options) {
    return nativePty.spawn(executable, process.platform === 'win32' ? ['-NoProfile', ...args] : args, options);
  } } });
  await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  const evaluate = fn => win.webContents.executeJavaScript(`(${fn.toString()})()`);
  const invoke = (method, argument) => win.webContents.executeJavaScript(`window.WorkbenchUI[${JSON.stringify(method)}](${JSON.stringify(argument)})`);
  const savedLayout = () => JSON.parse(fs.readFileSync(path.join(persistence.getDataPath(), 'settings.json'), 'utf8')).workbenchLayout;
  const dragSplitter = async (key, delta) => {
    win.focus();
    await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const point = await win.webContents.executeJavaScript(`(() => {
      const element = document.querySelector('[data-size="${key}"]');
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    const horizontal = key === 'bottomHeight';
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point });
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point });
    await delay(30);
    for (let step = 1; step <= 4; step++) {
      win.webContents.sendInputEvent({ type: 'mouseMove', modifiers: ['leftButtonDown'], x: point.x + (horizontal ? 0 : Math.round(delta * step / 4)),
        y: point.y + (horizontal ? Math.round(delta * step / 4) : 0) });
      await delay(25);
    }
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1,
      x: point.x + (horizontal ? 0 : delta), y: point.y + (horizontal ? delta : 0) });
    await until(() => evaluate(() => !document.body.classList.contains('wb-resizing')), 1000);
  };
  check('workbench initializes alongside existing chat', await until(() => evaluate(() => !!document.getElementById('workbenchDock'))));
  win.show(); win.focus();
  await evaluate(() => document.getElementById('workbenchSidebarToggle').click());
  check('sidebar toggle collapses and restores sidebar', await evaluate(() => {
    const collapsed = document.getElementById('sidebar').getBoundingClientRect().width === 0;
    document.getElementById('workbenchSidebarToggle').click(); return collapsed && document.getElementById('sidebar').getBoundingClientRect().width > 0;
  }));
  await evaluate(() => { const handle = document.querySelector('[data-size="sidebarWidth"]'); handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); });
  await delay(250); check('splitter changes persisted layout using keyboard', persistence.getSettings().workbenchLayout.sidebarWidth > 236);
  await evaluate(async () => { await SideChatUI.create(state.currentRoomId); });
  check('side chat opens in dock tab', await evaluate(() => document.getElementById('workbenchDock').dataset.kind === 'chat' && !!document.querySelector('#workbenchTabs .wb-tab.active')));
  const sidebarBeforeDrag = savedLayout().sidebarWidth;
  await dragSplitter('sidebarWidth', 32);
  check('actual pointer drag resizes sidebar and writes layout to disk', await until(() => savedLayout().sidebarWidth === sidebarBeforeDrag + 32));
  const dockBeforeDrag = savedLayout().dockWidth;
  await dragSplitter('dockWidth', -44);
  const dockDragged = await until(() => savedLayout().dockWidth === dockBeforeDrag + 44);
  check('actual pointer drag resizes dock and writes layout to disk', dockDragged);
  const afterDockDrag = await evaluate(() => ({ mainWidth: document.getElementById('main').getBoundingClientRect().width,
    dockWidth: document.getElementById('workbenchDock').getBoundingClientRect().width, resizing: document.body.classList.contains('wb-resizing'),
    viewportWidth: innerWidth, sidebarWidth: document.getElementById('sidebar').getBoundingClientRect().width }));
  check('side pane dragging preserves usable main width and releases pointer capture', afterDockDrag.mainWidth >= 260 && !afterDockDrag.resizing);
  if (!dockDragged || afterDockDrag.mainWidth < 260 || afterDockDrag.resizing) console.error('Dock drag evidence:', JSON.stringify({ before: dockBeforeDrag, persisted: savedLayout(), ...afterDockDrag }));
  await evaluate(() => document.getElementById('workbenchMaximize').click());
  check('maximized dock keeps sidebar and exposes main preview', await evaluate(() => {
    const app = document.getElementById('app'); return app.classList.contains('wb-dock-maximized') && document.getElementById('sidebar').getBoundingClientRect().width > 0 && document.getElementById('workbenchMainPreview').getBoundingClientRect().height > 0;
  }));
  await evaluate(() => document.querySelector('#workbenchMainPreview button').click());
  check('main chat preview expands inside maximized dock', await evaluate(() => document.getElementById('main').classList.contains('wb-preview-open')));
  await evaluate(() => { document.getElementById('workbenchPreviewClose').click(); document.getElementById('workbenchMaximize').click(); });
  const fileId = await invoke('openFiles', false);
  await evaluate(() => [...document.querySelectorAll('.wb-file-entry')].find(item => item.textContent === 'fixture.txt').click());
  check('project file preview reads actual synthetic file', await until(() => evaluate(() => [...document.querySelectorAll('.wb-code')].some(item => item.textContent.includes('Visible synthetic project file')))));
  const terminalId = await invoke('openTerminal', 'bottom');
  const terminalCommand = process.platform === 'win32' ? 'Write-Output ("CONVOKE" + "_PTY_UI_OK")\r' : "printf '%s%s\\n' CONVOKE _PTY_UI_OK\n";
  await win.webContents.executeJavaScript(`window.api.workbench({ operation: 'terminal:write', id: document.querySelector('#workbenchBottom .wb-content').dataset.tabId, data: ${JSON.stringify(terminalCommand)} })`);
  const executed = await until(() => events.filter(item => item.kind === 'terminal-data' && item.id === terminalId).map(item => item.data).join('').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').includes('CONVOKE_PTY_UI_OK'), 12000);
  check('actual interactive terminal executes shell input from terminal tab', executed);
  if (!executed) console.error('Synthetic terminal evidence:', JSON.stringify(events.filter(item => item.kind.startsWith('terminal') && item.id === terminalId)));
  check('xterm receives and renders terminal output', await evaluate(() => !!document.querySelector('#workbenchBottom .xterm-screen')));
  const bottomBeforeDrag = savedLayout().bottomHeight;
  await dragSplitter('bottomHeight', -36);
  check('actual pointer drag resizes bottom terminal and writes layout to disk', await until(() => savedLayout().bottomHeight === bottomBeforeDrag + 36));
  await evaluate(() => SideChatUI.open(state.rooms.find(room => room.parentRoomId === state.currentRoomId).id));
  win.setContentSize(880, 600);
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const compact = await evaluate(() => {
    const reach = id => {
      const element = document.getElementById(id), rect = element.getBoundingClientRect();
      const center = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
      const hit = document.elementFromPoint(center.x, center.y);
      return { id, width: rect.width, height: rect.height, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        reachable: rect.width > 0 && rect.height > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight && !!hit && element.contains(hit) };
    };
    return { viewport: [innerWidth, innerHeight], mainWidth: document.getElementById('main').getBoundingClientRect().width,
      documentWidth: document.documentElement.scrollWidth, dockRight: document.getElementById('workbenchDock').getBoundingClientRect().right,
      controls: ['workbenchSidebarToggle', 'workbenchDockToggle', 'workbenchTerminalToggle', 'workbenchMaximize', 'input', 'actionBtn', 'sideChatInput', 'sideChatSend'].map(reach) };
  });
  const compactWidthOk = compact.mainWidth >= 260 && compact.documentWidth <= compact.viewport[0] && compact.dockRight <= compact.viewport[0];
  check('880x600 layout preserves main width and avoids horizontal overflow', compactWidthOk);
  const compactReachable = compact.controls.every(item => item.reachable);
  check('880x600 layout keeps pane controls and both chat composers reachable', compactReachable);
  if (!compactWidthOk || !compactReachable) console.error('Compact layout evidence:', JSON.stringify(compact));
  win.setContentSize(1280, 850);
  await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await invoke('closeTab', terminalId); check('closing terminal disposes actual owned PTY', !workbench.terminals.sessions.has(terminalId));
  server = http.createServer((_req, response) => { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>Convoke browser fixture</title><h1>Convoke browser fixture</h1>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const url = `http://127.0.0.1:${server.address().port}/`;
  const browserId = await invoke('openBrowser');
  await win.webContents.executeJavaScript(`(() => { const input = document.querySelector('.wb-browser-address'); input.value = ${JSON.stringify(url)}; input.form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); })()`);
  check('native embedded browser loads real local HTTP fixture', await until(() => events.some(item => item.kind === 'browser-state' && item.title === 'Convoke browser fixture')));
  const view = workbench.browsers.views.get(browserId).view;
  check('embedded web content has no application or Node bridge', await view.webContents.executeJavaScript('typeof window.api === "undefined" && typeof require === "undefined" && typeof process === "undefined"'));
  check('embedded browser permissions and sandbox configured', view.webContents.getLastWebPreferences().sandbox && !view.webContents.getLastWebPreferences().nodeIntegration);
  await evaluate(() => showModal('settingsModal'));
  check('browser native view hides while app modal is open', await until(() => !workbench.browsers.views.get(browserId).visible));
  await evaluate(() => hideModal('settingsModal'));
  check('browser native view returns after modal closes', await until(() => workbench.browsers.views.get(browserId).visible));
  const webContents = view.webContents;
  const oldSession = webContents.session;
  await oldSession.cookies.set({ url, name: 'convoke_synthetic_identity', value: 'fixture-only' });
  await invoke('closeTab', browserId); check('closing browser releases WebContents', !workbench.browsers.views.has(browserId) && webContents.isDestroyed());
  const reusedBrowserId = await invoke('openBrowser');
  const reusedSession = workbench.browsers.views.get(reusedBrowserId).session;
  check('browser reuses bounded session slots after clearing previous identity', oldSession === reusedSession && (await reusedSession.cookies.get({ name: 'convoke_synthetic_identity' })).length === 0);
  await invoke('closeTab', reusedBrowserId);
  await evaluate(() => {
    const row = bubbleEl({ id: 'edited-file-link-fixture', roomId: state.currentRoomId, authorType: 'bot', status: 'done', createdAt: Date.now(), text: 'Synthetic final',
      activities: [{ id: 'edit-fixture', kind: 'tool', name: 'Write', status: 'done', files: ['fixture.txt'] }] });
    document.getElementById('messages').append(row);
    row.querySelector('details').open = true; row.querySelector('.activity-file').click();
  });
  check('edited file activity opens its real project file in side workbench', await until(() => evaluate(() => {
    const pane = document.querySelector('#workbenchBody .wb-files:not([hidden])');
    return pane?.querySelector('.wb-code')?.textContent === 'Visible synthetic project file\n';
  })));
  const activityFileId = await evaluate(() => document.querySelector('#workbenchBody .wb-files:not([hidden])')?.dataset.tabId);
  await invoke('closeTab', activityFileId);
  await evaluate(() => document.querySelector('[data-msg-id="edited-file-link-fixture"]').remove());

  await evaluate(() => WorkbenchUI.openAgentDetail({ roomId: state.currentRoomId, messageId: 'synthetic_message', botName: 'Fixture parent', activity: {
    id: 'codex:subagent:fixture', kind: 'subagent', name: 'Fixture review', status: 'done', subagent: { agentId: 'fixture', parentAgentId: 'fixture-parent', task: 'Inspect synthetic file', output: 'Synthetic review complete', model: 'fixture-model' },
  } }));
  check('subagent detail shows parent, task and returned output', await evaluate(() => {
    const text = document.querySelector('.wb-agent').textContent; return document.getElementById('workbenchDock').dataset.kind === 'agent' && text.includes('Fixture parent') && text.includes('Inspect synthetic file') && text.includes('Synthetic review complete');
  }));
  await invoke('closeTab', fileId);
  const staleFileId = await invoke('openFiles', false);
  await evaluate(() => [...document.querySelectorAll('.wb-file-entry')].find(item => item.textContent === 'fixture.txt').click());
  check('directory change regression begins with old project preview', await until(() => evaluate(() => [...document.querySelectorAll('.wb-code')].some(item => item.textContent.includes('Visible synthetic project file')))));
  const staleTerminalId = await invoke('openTerminal', 'bottom');
  const staleBrowserId = await invoke('openBrowser');
  const otherProject = path.join(directory, 'other-project'); fs.mkdirSync(otherProject); fs.writeFileSync(path.join(otherProject, 'fixture.txt'), 'Different project file\n');
  const currentRoomId = await evaluate(() => state.currentRoomId);
  persistence.saveRoom({ ...persistence.listRooms().find(room => room.id === currentRoomId), cwd: otherProject });
  await evaluate(async () => reloadFromMain());
  check('changing project directory closes old file preview and owned terminal/browser tabs', await until(async () =>
    !workbench.terminals.sessions.has(staleTerminalId) && !workbench.browsers.views.has(staleBrowserId) &&
    await win.webContents.executeJavaScript(`!document.querySelector('[data-tab-id="${staleFileId}"]')`)));
  const freshFileId = await invoke('openFiles', false);
  await evaluate(() => [...document.querySelectorAll('.wb-file-entry')].find(item => item.textContent === 'fixture.txt').click());
  check('new file tab reads same-named file from the new project', await until(() => evaluate(() => [...document.querySelectorAll('.wb-code')].some(item => item.textContent.includes('Different project file')))));
  await invoke('closeTab', freshFileId);
  await require('./production-ui-checks.cjs')(win, check);
  if (process.env.AR_UI_CAPTURE_DIR) {
    const capture = path.resolve(process.env.AR_UI_CAPTURE_DIR); fs.mkdirSync(capture, { recursive: true });
    win.showInactive();
    await evaluate(() => { WorkbenchUI.toggleBottom(false); AppearanceUI.setSaved({ mode: 'light', preset: 'graphite' }); });
    await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await delay(180); fs.writeFileSync(path.join(capture, 'workbench-light.png'), (await win.webContents.capturePage()).toPNG());
    await evaluate(() => { AppearanceUI.setSaved({ mode: 'dark', preset: 'graphite' }); });
    await delay(180); fs.writeFileSync(path.join(capture, 'workbench-dark.png'), (await win.webContents.capturePage()).toPNG());
  }
  if (rendererErrors.length) console.error(rendererErrors);
  console.log(`${results.filter(item => item.ok).length}/${results.length} workbench checks, ${rendererErrors.length} renderer errors`);
  workbench.dispose(); server.close(); app.exit(results.every(item => item.ok) && !rendererErrors.length ? 0 : 1);
}).catch(error => { console.error(error); workbench?.dispose(); server?.close(); app.exit(2); });
