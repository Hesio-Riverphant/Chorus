'use strict';
const path = require('node:path');
const os = require('node:os');
const { app, BrowserWindow } = require('electron');
const dir = process.env.AR_MATURITY_UI_DATA_DIR;
if (!dir || path.dirname(dir) !== os.tmpdir() || !path.basename(dir).startsWith('convoke-maturity-ui-')) throw new Error('Run with node scripts/run-maturity-ui.js');
process.env.AR_DATA_DIR = dir;
app.setPath('userData', path.join(dir, 'electron'));
const fixture = { calls: [], answers: [], preparations: [], discoveries: [], skillScans: [] };
require('../src/main/modelCatalog').discoverModels = () => ({ models: [
  { id: 'fixture-reasoner', label: 'Fixture Reasoner', reasoningLevels: ['low', 'high', 'ultra'] },
], notice: 'Synthetic model metadata' });
require('../src/main/cliDiscovery').discoverClis = async () => [];
require('../src/main/skills/skillDiscovery').scan = async options => { fixture.skillScans.push(options); return { skills: [], roots: [], warnings: [] }; };
const capabilities = require('../src/main/nativeCapabilities');
capabilities.discover = async (cli, cwd, options) => {
  fixture.discoveries.push({ cli, cwd, refresh: options?.refresh === true });
  return { items: [
    { id: 'fixture_mcp', name: 'Fixture MCP', kind: 'mcp', enabled: true, status: 'ready', toolCount: 2 },
    { id: 'fixture_plugin@fixture', name: 'Fixture Plugin', kind: 'plugin', enabled: false },
    { id: 'fixture_plugin_mcp', name: 'Plugin MCP', kind: 'mcp', enabled: false, pluginId: 'fixture_plugin@fixture', selectable: false },
  ], scannedAt: Date.now(), notice: 'Synthetic capability metadata' };
};
capabilities.prepare = async bot => {
  fixture.preparations.push(JSON.parse(JSON.stringify(bot.nativeCapabilities)));
  return { nativeArgs: [], nativeConfig: { fixture: true }, cleanup() {} };
};
require('../src/main/adapters/cliAdapter').runBot = options => {
  const call = { bot: JSON.parse(JSON.stringify(options.bot)), prompt: options.prompt };
  fixture.calls.push(call);
  let emit = () => {}, resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise,
    onEvent(listener) {
      emit = listener;
      queueMicrotask(() => emit('input_request', { requestId: 'fixture_question', questions: [
        { id: 'choice', question: 'Choose a synthetic answer', options: [
          { label: 'Option A', description: 'Synthetic option' }, { label: 'Option B' },
        ] },
      ] }));
    },
    respondInput(requestId, answers) {
      fixture.answers.push({ botId: call.bot.id, requestId, answers });
      emit('input_resolved', { requestId });
      emit('context_usage', { totalTokens: 987, contextWindow: 200000 });
      resolve({ text: 'Synthetic reply', usage: { inputTokens: 123, outputTokens: 45, tokens: 168 } });
      return true;
    },
    async cancel() { resolve({ text: '', aborted: true, usage: { inputTokens: 0, outputTokens: 0, tokens: 0 } }); },
  };
};
const persistence = require('../src/main/store/persistence');
const orchestrator = require('../src/main/orchestrator/orchestrator');
const { registerIpc } = require('../src/main/ipc');
const results = [];
const watchdog = setTimeout(() => { console.error('FAIL maturity UI timed out'); app.exit(2); }, 60000);
process.on('exit', () => { clearTimeout(watchdog); clearInterval(persistence.timer); });
app.whenReady().then(async () => {
  await persistence.init(app);
  persistence.saveSettings({ enabledCliIds: ['codex'] });
  const win = new BrowserWindow({ width: 1400, height: 900, show: false, webPreferences: {
    preload: path.resolve(__dirname, '../src/main/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false,
  } });
  const rendererErrors = [];
  win.webContents.on('console-message', event => { if (event.level === 'error') rendererErrors.push(event.message); });
  registerIpc(win, persistence);
  require('../src/main/workbench').registerWorkbench(win, persistence);
  await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
  await require('./maturity-checks.cjs')({ win, persistence, orchestrator, fixture,
    check(name, ok) { results.push({ name, ok: !!ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); },
  });
  if (process.env.AR_UI_CAPTURE_DIR) {
    const fs = require('node:fs');
    const output = path.resolve(process.env.AR_UI_CAPTURE_DIR);
    fs.mkdirSync(output, { recursive: true });
    const evaluate = fn => win.webContents.executeJavaScript(`(${fn.toString()})()`);
    const capture = async name => {
      await evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await evaluate(() => Promise.all(document.getAnimations().filter(animation => animation.effect.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))));
      fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG());
    };
    await evaluate(async () => {
      closeAllModals(); SideChatUI.close();
      AppearanceUI.setSaved({ mode: 'light', preset: 'graphite' });
      const host = await window.api.saveBot({ name: '主持人', cliType: 'codex', role: '主持人', permissionMode: 'read_only', enabled: true });
      const researcher = await window.api.saveBot({ name: '研究员', cliType: 'claude', role: '研究员', permissionMode: 'read_only', enabled: true });
      const room = await window.api.saveRoom({ name: '交互设计', cwd: state.defaultCwd, botIds: [host.id, researcher.id], moderatorBotId: host.id });
      await reloadFromMain(); switchRoom(room.id); ComposerModeUI.set(room.id, 'plan');
      composer.value = '一起检查桌面交互，整理可执行的改进计划。';
    });
    await capture('main-light.png');
    await evaluate(async () => { await SideChatUI.create(state.currentRoomId); ComposerModeUI.set(SideChatUI.getRoom().id, 'goal'); });
    await capture('split-light.png');
    await evaluate(() => AppearanceUI.setSaved({ mode: 'dark', preset: 'graphite' }));
    await capture('split-dark.png');
    await evaluate(async () => { AppearanceUI.setSaved({ mode: 'light', preset: 'graphite' }); openSettings('extensions'); await openNativeManagement(); });
    await capture('extensions-light.png');
    console.log('Synthetic visual captures: ' + output);
  }
  if (rendererErrors.length) console.error(rendererErrors);
  console.log(`${results.filter(item => item.ok).length}/${results.length} maturity checks, ${rendererErrors.length} renderer errors`);
  app.exit(results.every(item => item.ok) && !rendererErrors.length ? 0 : 1);
}).catch(error => { console.error(error); app.exit(2); });
