'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const { test } = require('node:test');
const runs = [];
let finish;
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === './adapters/cliAdapter') return { runBot: (options) => {
    runs.push(options);
    let complete;
    return {
      promise: new Promise((resolve) => { finish = complete = resolve; options.finish = resolve; }),
      cancel: async () => complete({ aborted: true }),
    };
  } };
  return original.call(this, name, ...args);
};
let probe;
try { probe = require('../src/main/connectionTest'); } finally { Module._load = original; }

test('connection probe requires explicit request and validates command-bound fields', async () => {
  await assert.rejects(probe.test({ cliType: 'claude' }), /确认/);
  await assert.rejects(probe.test({ cliType: '__proto__', confirmed: true }), /有效/);
  await assert.rejects(probe.test({ cliType: 'codex', model: 'x&echo', confirmed: true }), /有效/);
  assert.equal(runs.length, 0);
});

test('ZCode unsupported probe reports its actual limitation without starting an agent', async () => {
  const count = runs.length;
  const result = await probe.test({ cliType: 'zcode', confirmed: true });
  assert.equal(result.ok, false);
  assert.match(result.detail, /ZCode.*无工具连接测试/);
  assert.equal(result.elapsedMs, 0);
  assert.equal(runs.length, count);
});

test('connection probe isolates workspaces, permits three parallel models and bounds duplicate requests', async () => {
  const pending = probe.test({ cliType: 'claude', confirmed: true, permissionMode: 'full', persona: 'ignored' });
  await assert.rejects(probe.test({ cliType: 'claude', confirmed: true }), /正在/);
  const run = runs.at(-1);
  const second = probe.test({ cliType: 'codex', confirmed: true });
  const secondRun = runs.at(-1);
  const third = probe.test({ cliType: 'claude', model: 'haiku', confirmed: true });
  const thirdRun = runs.at(-1);
  await assert.rejects(probe.test({ cliType: 'claude', model: 'sonnet', confirmed: true }), /3/);
  assert.equal(run.bot.permissionMode, 'read_only');
  assert.equal(run.bot.persona, undefined);
  assert.equal(run.priorSessionId, null);
  assert.equal(run.log, undefined);
  assert.equal(fs.existsSync(run.workspace), true);
  run.finish({ text: 'OK', error: null });
  secondRun.finish({ text: 'OK' }); thirdRun.finish({ text: 'OK' });
  assert.equal((await pending).ok, true);
  assert.equal((await second).ok, true); assert.equal((await third).ok, true);
  assert.equal(fs.existsSync(run.workspace), false);
});

test('probe requires model output, supports cancellation and never returns raw errors', async () => {
  let pending = probe.test({ cliType: 'codex', confirmed: true });
  finish({ text: '', error: null });
  assert.equal((await pending).ok, false);
  pending = probe.test({ cliType: 'codex', confirmed: true });
  finish({ error: 'synthetic-private-value', text: '' });
  assert.equal(JSON.stringify(await pending).includes('synthetic-private-value'), false);
  pending = probe.test({ cliType: 'codex', confirmed: true });
  await probe.cancel();
  assert.match((await pending).detail, /取消/);
});

test('temporary cleanup failure preserves connection result and returns a fixed notice', async () => {
  const pending = probe.test({ cliType: 'codex', confirmed: true });
  const directory = runs.at(-1).workspace;
  const remove = fs.rmSync;
  try {
    fs.rmSync = () => { throw new Error('synthetic-private-cleanup-detail'); };
    finish({ text: 'AGENT_ROOM_OK' });
    const result = await pending;
    assert.equal(result.ok, true);
    assert.match(result.detail, /未能清理/);
    assert.ok(!result.detail.includes('synthetic-private-cleanup-detail'));
  } finally { fs.rmSync = remove; remove(directory, { recursive: true, force: true }); }
});

test('connection test forwards chosen model and reasoning while allowing a not-yet-enabled provider probe', async () => {
  const pending = probe.test({ cliType: 'claude', model: 'sonnet', reasoningEffort: 'high', executionMode: 'plan', confirmed: true }, { enabledCliIds: [] });
  const run = runs.at(-1);
  assert.equal(run.bot.model, 'sonnet');
  assert.equal(run.bot.reasoningEffort, 'high');
  assert.equal(run.bot.executionMode, 'plan');
  finish({ text: 'AGENT_ROOM_OK' });
  assert.equal((await pending).ok, true);
  await assert.rejects(probe.test({ cliType: 'claude', model: 'haiku', reasoningEffort: 'high', confirmed: true }), /不支持/);
});

test('cancelling one connection leaves other models running', async () => {
  const first = probe.test({ cliType: 'claude', confirmed: true });
  const second = probe.test({ cliType: 'codex', confirmed: true });
  const secondRun = runs.at(-1);
  await probe.cancel({ cliType: 'claude', model: '' });
  assert.equal((await first).ok, false);
  secondRun.finish({ text: 'Reply from model' });
  assert.equal((await second).ok, true);
});

test('raw text CLI banner-only output is not a model connection success', async () => {
  const cliType = 'custom_' + 'c'.repeat(32);
  const settings = { cliProfiles: [{ id: cliType, label: 'AA', command: 'C:\\Tools\\aa.exe', args: [], promptMode: 'stdin', outputMode: 'text' }] };
  let pending = probe.test({ cliType, confirmed: true }, settings);
  finish({ text: 'AA version 1.0, ready' });
  assert.equal((await pending).ok, false);
  pending = probe.test({ cliType, confirmed: true }, settings);
  finish({ text: 'OK\n' });
  assert.equal((await pending).ok, true);
});
