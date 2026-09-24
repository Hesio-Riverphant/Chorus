'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { projectPath, roomDirectory } = require('../src/main/workbench/paths');
const { listFiles, readFile, changes, diff } = require('../src/main/workbench/files');
const { TerminalService } = require('../src/main/workbench/terminals');
const { browserUrl, viewBounds, BrowserService } = require('../src/main/workbench/browsers');
const { normalizeLayout, registerWorkbench } = require('../src/main/workbench');

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-workbench-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  // Production IPC obtains this canonical root through roomDirectory. Windows
  // runners may expose TEMP with an 8.3 alias, unlike realpath/Git output.
  return fs.realpathSync(directory);
}
function git(cwd, args) { return execFileSync('git', args, { cwd, windowsHide: true, encoding: 'utf8' }); }

test('project file browsing blocks traversal, absolute escape and junction escape', async t => {
  const directory = fixture(t), root = path.join(directory, 'project'), outside = path.join(directory, 'outside');
  fs.mkdirSync(root); fs.mkdirSync(outside); fs.writeFileSync(path.join(root, 'notes.txt'), 'Convoke fixture');
  fs.writeFileSync(path.join(outside, 'private.txt'), 'synthetic outside');
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await projectPath(root, 'notes.txt'), path.join(root, 'notes.txt'));
  await assert.rejects(projectPath(root, '../outside/private.txt'), /项目目录/);
  await assert.rejects(projectPath(root, path.join(outside, 'private.txt')), /项目目录/);
  await assert.rejects(projectPath(root, 'linked/private.txt'), /目录外/);
  await assert.rejects(projectPath(root, 'linked/deleted.txt', { allowMissing: true }), /目录外/);
  const list = await listFiles(root); assert.equal(list.entries.length, 2);
  assert.equal((await readFile(root, 'notes.txt')).text, 'Convoke fixture');
});

test('file preview limits binary/oversized inputs and resolves room defaults', async t => {
  const root = fixture(t); fs.writeFileSync(path.join(root, 'binary.dat'), Buffer.from([1, 0, 3]));
  fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
  fs.writeFileSync(path.join(root, 'wide.txt'), Buffer.concat([Buffer.from([255, 254]), Buffer.from('中文', 'utf16le')]));
  await assert.rejects(readFile(root, 'binary.dat'), /二进制/);
  await assert.rejects(readFile(root, 'large.txt'), /2 MB/);
  assert.equal((await readFile(root, 'wide.txt')).text, '中文');
  const persistence = { listRooms: () => [{ id: 'r' }], getSettings: () => ({ defaultCwd: root }) };
  assert.equal(await roomDirectory(persistence, 'r', 'unused'), fs.realpathSync(root));
  await assert.rejects(roomDirectory(persistence, 'missing', root), /房间/);
});

test('Git review includes staged, unstaged, deleted and untracked content without mutating worktree', async t => {
  const root = fixture(t); git(root, ['init', '-q']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'before\n'); fs.writeFileSync(path.join(root, 'deleted.txt'), 'old\n');
  git(root, ['add', '--', '.']); git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'staged\n'); git(root, ['add', '--', 'tracked.txt']);
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'after\n'); fs.unlinkSync(path.join(root, 'deleted.txt'));
  fs.writeFileSync(path.join(root, '[untracked].txt'), 'new\n');
  const before = git(root, ['status', '--porcelain=v1']);
  assert.equal((await changes(root)).entries.length, 3);
  assert.match((await diff(root, 'tracked.txt')).text, /-before[\s\S]*\+after/);
  assert.match((await diff(root, 'deleted.txt')).text, /-old/);
  assert.match((await diff(root, '[untracked].txt')).text, /\+new/);
  assert.equal(git(root, ['status', '--porcelain=v1']), before);
});

test('Git review supports a new repository before its first commit', async t => {
  const root = fixture(t); git(root, ['init', '-q']); fs.writeFileSync(path.join(root, 'first.txt'), 'first\n');
  git(root, ['add', '--', '.']); assert.match((await diff(root, 'first.txt')).text, /\+first/);
});

function fakePty() {
  const processes = [];
  return { processes, spawn(executable, args, options) {
    const emitter = new EventEmitter();
    const item = { pid: 42, options, executable, args, data: value => emitter.emit('data', value), exit: value => emitter.emit('exit', value),
      onData(callback) { emitter.on('data', callback); return { dispose: () => emitter.off('data', callback) }; },
      onExit(callback) { emitter.on('exit', callback); return { dispose: () => emitter.off('exit', callback) }; },
      pause() { this.paused = true; }, resume() { this.paused = false; }, kill() { this.killed = true; },
      write(value) { this.input = value; }, resize(cols, rows) { this.size = [cols, rows]; } };
    processes.push(item); return item;
  } };
}

test('interactive terminal buffers initial output, streams input/resizes and kills on tab close', () => {
  const emitted = [], pty = fakePty(); const service = new TerminalService({ emit: item => emitted.push(item), ptyModule: pty });
  service.create({ id: 'term1', roomId: 'room', cwd: process.cwd(), cols: 90, rows: 28 });
  pty.processes[0].data('prompt>'); assert.equal(emitted.length, 0);
  service.ready('term1'); assert.equal(emitted[0].data, 'prompt>');
  service.write('term1', 'dir\r'); assert.equal(pty.processes[0].input, 'dir\r');
  service.resize('term1', { cols: 112, rows: 32 }); assert.deepEqual(pty.processes[0].size, [112, 32]);
  service.close('term1'); assert.equal(pty.processes[0].killed, true);
  assert.throws(() => service.write('term1', 'x'), /已关闭/);
});

test('terminal backpressure pauses and resumes output and sessions are bounded', () => {
  const emitted = [], pty = fakePty(); const service = new TerminalService({ emit: item => emitted.push(item), ptyModule: pty });
  service.create({ id: 'term1', cwd: process.cwd() }); service.ready('term1');
  pty.processes[0].data('x'.repeat(300000)); assert.equal(pty.processes[0].paused, true);
  for (const event of emitted) service.acknowledge('term1', event.data.length);
  assert.equal(pty.processes[0].paused, false);
  for (let index = 2; index <= 8; index++) service.create({ id: `term${index}`, cwd: process.cwd() });
  assert.throws(() => service.create({ id: 'term9', cwd: process.cwd() }), /8/);
  service.dispose(); assert.equal(service.sessions.size, 0); assert.ok(pty.processes.every(item => item.killed));
});

test('browser rejects executable/local/credential URLs and clamps native view bounds', () => {
  for (const url of ['file:///c:/private', 'javascript:alert(1)', 'data:text/html,hi', 'https://user:pass@example.com']) assert.throws(() => browserUrl(url));
  assert.equal(browserUrl('https://example.com'), 'https://example.com/');
  assert.deepEqual(viewBounds({ x: -20, y: 50, width: 2000, height: 1000 }, { width: 800, height: 600 }), { x: 0, y: 50, width: 800, height: 550 });
});

test('browser uses isolated sandbox sessions and disposes native views', async () => {
  const instances = [], childViews = [], events = [];
  class View {
    constructor(options) {
      this.options = options; instances.push(this);
      const contents = new EventEmitter(); contents.session = new EventEmitter();
      Object.assign(contents.session, { setPermissionRequestHandler: callback => { this.permission = callback; }, setPermissionCheckHandler: callback => { this.permissionCheck = callback; },
        clearStorageData: async () => { this.storageCleared = true; }, clearCache: async () => {}, clearAuthCache: async () => {}, closeAllConnections: async () => {} });
      Object.assign(contents, { navigationHistory: { canGoBack: () => false, canGoForward: () => false }, isDestroyed: () => !!this.closed,
        setWindowOpenHandler: callback => { this.popup = callback; }, loadURL: async url => { this.url = url; }, close: () => { this.closed = true; contents.emit('destroyed'); } });
      this.webContents = contents;
    }
    setVisible(value) { this.visible = value; }
    setBounds(value) { this.bounds = value; }
  }
  const win = { contentView: { addChildView: item => childViews.push(item), removeChildView: item => childViews.splice(childViews.indexOf(item), 1) }, getContentBounds: () => ({ width: 800, height: 600 }) };
  const service = new BrowserService({ win, WebContentsView: View, emit: item => events.push(item) });
  await service.create('web1'); await service.create('web2');
  assert.equal(instances[0].options.webPreferences.sandbox, true); assert.equal(instances[0].options.webPreferences.nodeIntegration, false);
  assert.notEqual(instances[0].options.webPreferences.partition, instances[1].options.webPreferences.partition);
  assert.equal(instances[0].options.webPreferences.partition.startsWith('persist:'), false);
  assert.deepEqual(instances[0].popup(), { action: 'deny' });
  let prevented = false; instances[0].webContents.emit('will-navigate', { preventDefault() { prevented = true; } }, 'file:///c:/private'); assert.equal(prevented, true);
  await service.navigate('web1', 'https://example.com'); assert.equal(instances[0].url, 'https://example.com/');
  service.bounds('web1', { x: 200, y: 100, width: 500, height: 400, visible: true }); assert.equal(instances[0].visible, true);
  await service.close('web1'); assert.equal(instances[0].webContents.session.listenerCount('will-download'), 0); assert.equal(instances[0].storageCleared, true);
  await service.create('web3'); assert.equal(instances[2].options.webPreferences.partition, instances[0].options.webPreferences.partition);
  await service.dispose(); assert.equal(childViews.length, 0); assert.ok(instances.every(item => item.closed));
});

test('disposing workbench rejects delayed terminal creation before any process is spawned', async t => {
  const root = fixture(t), handlers = new Map(), pty = fakePty();
  const win = new EventEmitter(); win.webContents = new EventEmitter(); win.webContents.mainFrame = {};
  win.webContents.send = () => {}; win.webContents.isDestroyed = () => false; win.isDestroyed = () => false;
  const persistence = { listRooms: () => [{ id: 'room', cwd: root }], getSettings: () => ({}) };
  const service = registerWorkbench(win, persistence, { ptyModule: pty, electron: {
    ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler() {} }, WebContentsView: class {},
  } });
  const creating = handlers.get('workbench:request')({ sender: win.webContents }, { operation: 'terminal:create', roomId: 'room', id: 'late' });
  await service.dispose();
  await assert.rejects(creating, /已重置/); assert.equal(pty.processes.length, 0); assert.equal(service.terminals.sessions.size, 0);
});

test('browser sessions are bounded and a slot waits for identity cleanup before reuse', async () => {
  let finishStorage;
  const storage = new Promise(resolve => { finishStorage = resolve; });
  const instances = [], partitions = [];
  class View {
    constructor(options) {
      const session = new EventEmitter(); instances.push(this); partitions.push(options.webPreferences.partition);
      Object.assign(session, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, clearStorageData: () => storage,
        clearCache: async () => {}, clearAuthCache: async () => {}, closeAllConnections: async () => {} });
      const contents = new EventEmitter(); Object.assign(contents, { session, navigationHistory: { canGoBack: () => false, canGoForward: () => false },
        setWindowOpenHandler() {}, isDestroyed: () => !!this.closed, close: () => { this.closed = true; contents.emit('destroyed'); } }); this.webContents = contents;
    }
    setVisible() {}
  }
  const win = { contentView: { addChildView() {}, removeChildView() {} } };
  const service = new BrowserService({ win, WebContentsView: View, emit() {} });
  for (let index = 0; index < 6; index++) await service.create(`web${index}`);
  await assert.rejects(service.create('seventh'), /6/);
  const closing = service.close('web0'); let created = false;
  const creating = service.create('replacement').then(() => { created = true; });
  await Promise.resolve(); assert.equal(created, false); assert.equal(instances.length, 6);
  assert.equal(instances[0].webContents.session.listenerCount('will-download'), 0);
  finishStorage(); await closing; await creating;
  assert.equal(created, true); assert.equal(new Set(partitions).size, 6);
  await service.dispose();
});

test('browser creation waiting for a clearing slot is cancelled when workbench resets', async () => {
  let finishStorage; const storage = new Promise(resolve => { finishStorage = resolve; });
  class View {
    constructor() {
      const session = new EventEmitter(); Object.assign(session, { setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
        clearStorageData: () => storage, clearCache: async () => {}, clearAuthCache: async () => {}, closeAllConnections: async () => {} });
      const contents = new EventEmitter(); Object.assign(contents, { session, setWindowOpenHandler() {}, isDestroyed: () => false, close() { contents.emit('destroyed'); } }); this.webContents = contents;
    }
    setVisible() {}
  }
  const service = new BrowserService({ win: { contentView: { addChildView() {}, removeChildView() {} } }, WebContentsView: View, emit() {} });
  for (let index = 0; index < 6; index++) await service.create(`web${index}`);
  service.close('web0'); const creating = service.create('late'); const disposed = service.dispose();
  finishStorage(); await disposed; await assert.rejects(creating, /已重置/); assert.equal(service.views.size, 0);
});

test('browser slot clears identity only after renderer destruction while permission denial remains active', async () => {
  let clearCount = 0, requestPermission, destroyed;
  class View {
    constructor() {
      const session = new EventEmitter(); Object.assign(session, { setPermissionRequestHandler: handler => { requestPermission = handler; }, setPermissionCheckHandler() {},
        clearStorageData: async () => { clearCount++; }, clearCache: async () => {}, clearAuthCache: async () => {}, closeAllConnections: async () => {} });
      const contents = new EventEmitter(); Object.assign(contents, { session, setWindowOpenHandler() {}, isDestroyed: () => false, close() {} }); this.webContents = contents;
      destroyed = () => contents.emit('destroyed');
    }
    setVisible() {}
  }
  const service = new BrowserService({ win: { contentView: { addChildView() {}, removeChildView() {} } }, WebContentsView: View, emit() {} });
  await service.create('web'); const closing = service.close('web'); await Promise.resolve();
  assert.equal(clearCount, 0); let allowed;
  requestPermission(null, 'notifications', value => { allowed = value; }); assert.equal(allowed, false);
  destroyed(); await closing; assert.equal(clearCount, 1); assert.equal(service.slots[0].state, 'free');
});

test('workbench IPC rejects other windows/frames and persists only bounded layout state', async () => {
  const handlers = new Map(); const win = new EventEmitter(); win.webContents = new EventEmitter(); win.webContents.mainFrame = {};
  win.webContents.send = () => {}; win.webContents.isDestroyed = () => false; win.isDestroyed = () => false;
  const settings = { other: 'kept' };
  const persistence = { getSettings: () => settings, saveSettings: value => Object.assign(settings, value) };
  registerWorkbench(win, persistence, { electron: { ipcMain: { handle: (name, fn) => handlers.set(name, fn), removeHandler: name => handlers.delete(name) }, WebContentsView: class {} } });
  const invoke = handlers.get('workbench:request');
  assert.throws(() => invoke({ sender: {} }, { operation: 'layout:get' }), /来源/);
  assert.throws(() => invoke({ sender: win.webContents, senderFrame: {} }, { operation: 'layout:get' }), /来源/);
  assert.throws(() => invoke({ sender: win.webContents }, { operation: 'unknown' }), /无效/);
  invoke({ sender: win.webContents }, { operation: 'layout:save', layout: { sidebarWidth: 9999, bottomHeight: -4, dockOpen: true, secret: 'not persisted' } });
  assert.equal(settings.other, 'kept'); assert.equal(settings.workbenchLayout.sidebarWidth, 480); assert.equal(settings.workbenchLayout.bottomHeight, 120);
  assert.equal(settings.workbenchLayout.dockOpen, true); assert.equal('secret' in settings.workbenchLayout, false);
  assert.equal(normalizeLayout({ dockWidth: NaN }).dockWidth, 430);
  win.emit('closed'); assert.equal(handlers.size, 0);
});
