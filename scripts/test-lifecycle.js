'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');

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
