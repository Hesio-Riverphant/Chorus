'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('quit waits for all runs to stop, then flushes before exiting', async () => {
  const app = new EventEmitter();
  const steps = [];
  let release;
  let releaseProbe;
  let prevented = 0;
  app.requestSingleInstanceLock = () => true;
  app.setName = () => {};
  app.setPath = () => {};
  app.getPath = () => process.cwd();
  app.setAppUserModelId = () => {};
  app.whenReady = () => new Promise(() => {});
  app.quit = () => steps.push('quit');
  const original = Module._load;
  Module._load = function (name, ...args) {
    if (name === 'electron') return { app, dialog: { showErrorBox: () => steps.push('error') } };
    if (name === './store/persistence') return { flushSync: () => steps.push('flush') };
    if (name === './ipc') return {};
    if (name === './connectionTest') return {
      cancel: () => { steps.push('cancel-probe'); return new Promise((resolve) => { releaseProbe = resolve; }); },
    };
    if (name === './orchestrator/orchestrator') return {
      stopAll: () => { steps.push('stop'); return new Promise((resolve) => { release = resolve; }); },
    };
    return original.call(this, name, ...args);
  };
  try { require('../src/main/main'); } finally { Module._load = original; }
  const event = { preventDefault: () => { prevented++; } };
  app.emit('before-quit', event);
  app.emit('before-quit', event);
  assert.deepEqual(steps, ['stop', 'cancel-probe']);
  assert.equal(prevented, 2);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ['stop', 'cancel-probe']);
  releaseProbe();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steps, ['stop', 'cancel-probe', 'flush', 'quit']);
  app.emit('before-quit', event);
  assert.equal(prevented, 2);
});

for (const failing of [false, true]) test(`quit ${failing ? 'reports terminal teardown failure and stays open' : 'waits for terminal teardown before exiting'}`, async () => {
  const app = new EventEmitter(), steps = [];
  let start, releaseTerminal, rejectTerminal;
  Object.assign(app, { requestSingleInstanceLock: () => true, getPath: () => process.cwd(),
    whenReady: () => ({ then(callback) { start = callback; return { catch() {} }; } }), quit: () => steps.push('quit') });
  class Window {
    constructor() { this.webContents = new EventEmitter(); Object.assign(this.webContents, { setWindowOpenHandler() {}, executeJavaScript: async () => '{}' }); }
    setMenuBarVisibility() {} async loadFile() {} center() {} show() {} focus() {}
  }
  const filename = path.resolve(__dirname, '../src/main/main.js');
  const dependencies = {
    '../shared/i18n': { t: value => value }, electron: { app, BrowserWindow: Window, dialog: { showErrorBox: (_title, message) => steps.push(message) } },
    './appPaths': { configureAppPaths() {} }, './store/storeLease': { acquireStoreLease: () => ({ release() {} }) },
    './store/persistence': { init: async () => {}, flushSync: () => steps.push('flush') }, './ipc': { registerIpc() {} },
    './connectionTest': { cancel: async () => {} }, './orchestrator/orchestrator': { stopAll: async () => {} },
    './workbench': { registerWorkbench: () => ({ dispose: () => { steps.push('dispose'); return new Promise((resolve, reject) => { releaseTerminal = resolve; rejectTerminal = reject; }); } }) },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { require: name => dependencies[name] || require(name), __dirname: path.dirname(filename), console: { log() {}, error() {} } }, { filename });
  await start();
  const event = { preventDefault() {} }; app.emit('before-quit', event); app.emit('before-quit', event);
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(steps, ['dispose']);
  if (failing) rejectTerminal(new Error('terminal teardown failed')); else releaseTerminal();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(steps, failing ? ['dispose', 'terminal teardown failed'] : ['dispose', 'flush', 'quit']);
});
