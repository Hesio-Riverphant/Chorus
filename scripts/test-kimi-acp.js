'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { runKimiAcp } = require('../src/main/adapters/kimiAcp');

function fixture({ levels = ['off', 'on'], mismatch = false, wait = false, failure = false, fullActivities = false } = {}) {
  const requests = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); };
  function send(value) { child.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); }
  const configuration = value => ({ configOptions: [{ id: 'thinking', currentValue: value, options: levels.map(value => ({ value })) }] });
  child.stdin = new Writable({ write(buffer, _encoding, callback) {
    const request = JSON.parse(buffer.toString()); requests.push(request); callback();
    queueMicrotask(() => {
      const result = request.method === 'initialize' ? { protocolVersion: 1 }
        : request.method === 'session/new' ? { sessionId: 'session', ...configuration('on') }
          : request.method === 'session/set_config_option' ? configuration(mismatch ? 'on' : request.params.value) : {};
      if (request.method === 'session/prompt') {
        if (wait) return;
        const update = update => send({ method: 'session/update', params: { sessionId: 'session', update } });
        if (fullActivities) for (let i = 0; i < 100; i += 1) update({ sessionUpdate: 'tool_call', toolCallId: `fill-${i}`, title: 'Read', status: 'completed' });
        update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Considering' } });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Checking' } });
        update({ sessionUpdate: 'tool_call', toolCallId: 'tool', title: 'Read', status: 'in_progress' });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'Data' } }] });
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Final answer' } });
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' });
        send({ id: request.id, result: { stopReason: failure ? 'max_tokens' : 'end_turn' } });
      } else if (request.id) send({ id: request.id, result });
    });
  } });
  let spawnOptions;
  return { requests, start(effort) {
    const handle = runKimiAcp({ bot: { model: 'provider/model', reasoningEffort: effort, permissionMode: 'full' },
      prompt: 'Question', workspace: '/fixture', executable: { command: 'fixture', argsPrefix: [] },
      spawnProcess(command, args, options) { spawnOptions = { command, args, options }; return child; } });
    return { handle, spawnOptions };
  } };
}

test('Kimi session reasoning override is acknowledged before prompting and process remains separate from final', async () => {
  const f = fixture(), { handle, spawnOptions } = f.start('off'), events = [];
  handle.onEvent((type, value) => events.push({ type, value }));
  const result = await handle.promise;
  assert.equal(result.error, null); assert.equal(result.text, 'Final answer');
  assert.deepEqual(spawnOptions.args, ['acp']); assert.equal(spawnOptions.options.shell, false);
  assert.equal(spawnOptions.options.windowsHide, true);
  const methodOrder = f.requests.map(item => [item.method, item.params.configId, item.params.value]);
  assert.deepEqual(methodOrder.slice(2, 5), [
    ['session/set_config_option', 'model', 'provider/model'],
    ['session/set_config_option', 'thinking', 'off'],
    ['session/set_config_option', 'mode', 'auto'],
  ]);
  assert.ok(events.some(item => item.type === 'activity' && item.value.phase === 'commentary' && item.value.detail === 'Checking'));
  assert.ok(events.some(item => item.type === 'activity' && item.value.id === 'tool' && item.value.status === 'done'));
  assert.ok(!events.some(item => item.type === 'usage'));
});

test('older Kimi rejects unsupported detailed effort before any prompt instead of silently disabling thinking', async () => {
  const f = fixture(); const { handle } = f.start('high');
  assert.match((await handle.promise).error, /未提供所选推理档位/);
  assert.ok(!f.requests.some(item => item.method === 'session/prompt'));
});

test('new Kimi effort values need an exact native acknowledgement', async () => {
  const f = fixture({ levels: ['low', 'high', 'max'] });
  assert.equal((await f.start('high').handle.promise).error, null);
  const mismatch = fixture({ mismatch: true });
  assert.match((await mismatch.start('off').handle.promise).error, /未应用/);
  assert.ok(!mismatch.requests.some(item => item.method === 'session/prompt'));
});

test('cancelling Kimi closes the protocol and cannot report a completed answer', async () => {
  const f = fixture({ wait: true }), { handle } = f.start('on');
  await new Promise(resolve => setImmediate(resolve)); await handle.cancel();
  const result = await handle.promise;
  assert.equal(result.aborted, true); assert.equal(result.error, null);
});

test('incomplete Kimi native stop reason remains a failed turn even with partial text', async () => {
  const f = fixture({ failure: true });
  assert.match((await f.start('on').handle.promise).error, /未完成/);
});

test('a full activity list preserves Kimi process prose in the body without discarding the conclusion', async () => {
  const f = fixture({ fullActivities: true });
  const result = await f.start('on').handle.promise;
  assert.equal(result.error, null);
  assert.equal(result.text, 'CheckingFinal answer');
});
