'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const fixtureDir = process.env.AR_ROOM_UI_DATA_DIR;
if (!fixtureDir || path.dirname(fixtureDir) !== os.tmpdir() || !path.basename(fixtureDir).startsWith('convoke-pane-ui-')) throw new Error('Run with node scripts/run-room-ui.js');
process.env.AR_DATA_DIR = fixtureDir;
app.setPath('userData', path.join(fixtureDir, 'electron'));
require('../src/main/modelCatalog').discoverModels = () => ({ models: [], notice: '' });
require('../src/main/adapters/cliAdapter').runBot = () => { throw new Error('Fixture forbids CLI processes'); };
require('../src/main/skills/skillDiscovery').scan = async () => ({ skills: [], roots: [], warnings: [] });
const persistence = require('../src/main/store/persistence');
const { registerIpc } = require('../src/main/ipc');
const results = [];
const watchdog = setTimeout(() => app.exit(2), 30000);
process.on('exit', () => {
  clearTimeout(watchdog); clearInterval(persistence.timer);
});
app.whenReady().then(async () => {
  await persistence.init(app);
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: {
    preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } });
  registerIpc(win, persistence);
  require('../src/main/workbench').registerWorkbench(win, persistence);
  await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await win.webContents.executeJavaScript(`window.fixtureErrors=[]; window.addEventListener('error',e=>fixtureErrors.push(e.message)); window.addEventListener('unhandledrejection',e=>fixtureErrors.push(String(e.reason)));`);
  await require('./room-checks.cjs')({ win, persistence, check: (name, ok) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); } });
  await require('./navigation-checks.cjs')({ win, persistence, check: (name, ok) => { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); } });
  const errors = await win.webContents.executeJavaScript('fixtureErrors');
  if (errors.length) console.log(JSON.stringify(errors));
  console.log(`${results.filter((item) => item.ok).length}/${results.length} room checks, ${errors.length} renderer errors`);
  app.exit(results.every((item) => item.ok) && !errors.length ? 0 : 1);
}).catch((error) => { console.error(error); app.exit(2); });
