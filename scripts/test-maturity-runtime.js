'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { discover, prepare } = require('../src/main/nativeCapabilities');

test('cancelled capability discovery never constructs an external transport', async () => {
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  for (const cliType of ['codex', 'claude']) {
    await assert.rejects(discover(cliType, process.cwd(), { refresh: true, signal: controller.signal,
      rpcFactory: () => { calls++; throw new Error('unexpected transport'); },
      readClaude: () => { calls++; throw new Error('unexpected metadata command'); },
    }), { name: 'AbortError' });
  }
  assert.equal(calls, 0);
});

test('cancelling a pending Codex metadata request closes its transport and rejects discovery', { timeout: 1500 }, async () => {
  const controller = new AbortController();
  let started, rejectRequest, closes = 0;
  const pending = new Promise(resolve => { started = resolve; });
  const operation = discover('codex', process.cwd(), { refresh: true, signal: controller.signal, rpcFactory: () => ({
    initialize: async () => {},
    request: () => new Promise((_resolve, reject) => { rejectRequest = reject; started(); }),
    close: async () => { closes++; if (rejectRequest) rejectRequest(new Error('fixture transport closed')); },
  }) });
  await pending;
  controller.abort();
  await assert.rejects(operation, /closed|abort/i);
  assert.ok(closes >= 1);
});

test('Claude metadata cancellation propagates its signal and stops before the next command', { timeout: 1500 }, async () => {
  const controller = new AbortController();
  let started, calls = 0, received;
  const pending = new Promise(resolve => { started = resolve; });
  const operation = discover('claude', process.cwd(), { refresh: true, signal: controller.signal,
    readClaude: (_args, _cwd, signal) => new Promise((_resolve, reject) => {
      calls++; received = signal;
      signal.addEventListener('abort', () => reject(new Error('fixture metadata cancelled')), { once: true });
      started();
    }),
  });
  await pending;
  controller.abort();
  await assert.rejects(operation, /cancelled/);
  assert.equal(received, controller.signal);
  assert.equal(calls, 1);
});

test('late inventory after cancellation cannot create invocation settings', async () => {
  const controller = new AbortController();
  let finish, received;
  const operation = prepare({ cliType: 'claude', nativeCapabilities: { mode: 'selected', mcp: [], plugins: [] } }, process.cwd(),
    { signal: controller.signal, discovery: (_type, _cwd, options) => {
      received = options.signal;
      return new Promise(resolve => { finish = resolve; });
    } });
  controller.abort();
  finish({ items: [] });
  await assert.rejects(operation, { name: 'AbortError' });
  assert.equal(received, controller.signal);
});
