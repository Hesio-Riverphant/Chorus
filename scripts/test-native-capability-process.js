'use strict';

// Exercise the public discovery boundary with synthetic processes only.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const discovery = require('../src/main/cliDiscovery');
const modulePath = require.resolve('../src/main/nativeCapabilities');

function fixture() {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.killCalls = 0; child.kill = () => { child.killCalls++; return true; };
  const killer = new EventEmitter();
  killer.killCalls = 0; killer.kill = () => { killer.killCalls++; return true; };
  const spawns = [];
  const originalSpawn = childProcess.spawn, originalLocate = discovery.locateCliExecutable;
  childProcess.spawn = (command, args) => { spawns.push({ command, args }); return command === 'taskkill' ? killer : child; };
  discovery.locateCliExecutable = () => 'claude';
  delete require.cache[modulePath];
  let api;
  try { api = require(modulePath); }
  finally { childProcess.spawn = originalSpawn; discovery.locateCliExecutable = originalLocate; delete require.cache[modulePath]; }
  const controller = new AbortController();
  let settled = false, settlements = 0;
  // Attach rejection observation immediately; tests must not leak rejections.
  const result = api.discover('claude', process.cwd(), { refresh: true, signal: controller.signal }).then(
    value => { settled = true; settlements++; return { value }; },
    error => { settled = true; settlements++; return { error }; },
  );
  return { child, killer, spawns, controller, result, get settled() { return settled; }, get settlements() { return settlements; } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Claude scan cancellation waits for process-tree cleanup and cannot become success on launcher close', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  f.controller.abort();
  f.child.stdout.write('[]');
  f.child.emit('close', 0);
  await tick();
  assert.equal(f.settled, false);
  assert.equal(f.spawns.filter(call => call.command === 'taskkill').length, 1);
  f.killer.emit('close', 0);
  assert.match((await f.result).error.message, /已取消/);
  f.killer.emit('error', new Error('late cleanup error'));
  f.child.emit('error', new Error('late process error'));
  f.child.emit('close', 0);
  await tick();
  assert.equal(f.settlements, 1);
  assert.equal(f.spawns.length, 2);
});

test('Claude scan output limit wins over later cancellation and finishes after cleanup error', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  f.child.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));
  f.controller.abort();
  f.child.stdout.write('ignored');
  f.child.emit('close', 0);
  await tick();
  assert.equal(f.settled, false);
  assert.equal(f.spawns.length, 2);
  f.killer.emit('error', new Error('cleanup unavailable'));
  assert.match((await f.result).error.message, /超过大小上限/);
  assert.equal(f.child.killCalls, 1);
  f.killer.emit('close', 1);
  await tick();
  assert.equal(f.settlements, 1);
});

test('Claude scan timeout waits for a bounded cleanup deadline without repeated termination', { skip: process.platform !== 'win32' }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  t.mock.timers.tick(25000);
  f.controller.abort();
  f.child.emit('close', 0);
  await tick();
  assert.equal(f.settled, false);
  assert.equal(f.spawns.length, 2);
  t.mock.timers.tick(4999);
  await tick();
  assert.equal(f.settled, false);
  t.mock.timers.tick(1);
  assert.match((await f.result).error.message, /扫描超时/);
  assert.equal(f.killer.killCalls, 1);
  assert.equal(f.child.killCalls, 1);
  f.killer.emit('close', 1);
  f.child.emit('close', 0);
  await tick();
  assert.equal(f.settlements, 1);
});

test('Claude scan stdin failure is handled and waits for process cleanup', { skip: process.platform !== 'win32' }, async () => {
  const f = fixture();
  f.child.stdin.emit('error', new Error('synthetic pipe failure'));
  f.child.emit('error', new Error('secondary process failure'));
  f.controller.abort();
  await tick();
  assert.equal(f.settled, false);
  assert.equal(f.spawns.length, 2);
  f.killer.emit('close', 0);
  assert.match((await f.result).error.message, /无法完成/);
  assert.equal(f.settlements, 1);
});
