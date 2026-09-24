'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { runKimiAcp } = require('../src/main/adapters/kimiAcp');

function fixture({ levels = ['off', 'on'], mismatch = false, wait = false, failure = false, fullActivities = false, splitBom = false, finalTail = false, exitCode = 0, interaction, inputTimeoutMs } = {}) {
  const requests = [], child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit('close', 0)); };
  let first = true, promptId;
  function send(value) {
    const wire = Buffer.from((first && splitBom ? '\uFEFF' : '') + JSON.stringify({ jsonrpc: '2.0', ...value }) + (finalTail && value.result?.stopReason ? '' : '\n')); first = false;
    if (splitBom) for (const byte of wire) child.stdout.write(Buffer.from([byte])); else child.stdout.write(wire);
    if (finalTail && value.result?.stopReason) child.emit('close', exitCode);
  }
  const configuration = value => ({ configOptions: [{ id: 'thinking', currentValue: value, options: levels.map(value => ({ value })) }] });
  child.stdin = new Writable({ write(buffer, _encoding, callback) {
    const request = JSON.parse(buffer.toString()); requests.push(request); callback();
    queueMicrotask(() => {
      if (!request.method) {
        if (request.id === 'native-question' && promptId) {
          send({ method: 'session/update', params: { sessionId: 'session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Continued answer' } } } });
          send({ id: promptId, result: { stopReason: 'end_turn' } });
        }
        return;
      }
      const result = request.method === 'initialize' ? { protocolVersion: 1 }
        : request.method === 'session/new' ? { sessionId: 'session', ...configuration('on') }
          : request.method === 'session/set_config_option' ? configuration(mismatch ? 'on' : request.params.value) : {};
      if (request.method === 'session/prompt') {
        promptId = request.id;
        if (wait) return;
        const update = update => send({ method: 'session/update', params: { sessionId: 'session', update } });
        if (interaction) {
          update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Partial progress. ' } });
          send({ id: 'native-question', method: 'session/request_permission', params: { sessionId: 'session',
            toolCall: { title: 'AskUserQuestion', content: [{ type: 'content', content: { type: 'text', text: 'Choose a color' } }] },
            options: [{ optionId: 'q0_opt_0', name: 'Blue', kind: 'allow_once' }, { optionId: 'q0_opt_1', name: 'Green', kind: 'allow_once' }, { optionId: 'q0_skip', name: 'Skip', kind: 'reject_once' }], ...interaction } });
          return;
        }
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
  return { requests, send, child, start(effort) {
    const handle = runKimiAcp({ bot: { model: 'provider/model', reasoningEffort: effort, permissionMode: 'full' },
      prompt: 'Question', workspace: '/fixture', inputTimeoutMs, executable: { command: 'fixture', argsPrefix: [] },
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
    ['session/set_config_option', 'mode', 'yolo'],
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


test('Kimi accepts split UTF8 BOM and completed final response without newline', async () => {
  const f = fixture({ splitBom: true, finalTail: true });
  const result = await f.start('on').handle.promise;
  assert.equal(result.error, null); assert.equal(result.text, 'Final answer');
});


test('Kimi nonzero exit cannot turn a buffered final response into success', async () => {
  const f = fixture({ finalTail: true, exitCode: 1 });
  assert.ok((await f.start('on').handle.promise).error);
});

test('Kimi default reasoning stays native while yolo permits real question cards', async () => {
  const f = fixture({ interaction: {} }), { handle } = f.start(), events = [];
  handle.onEvent((type, value) => {
    events.push({ type, value });
    if (type === 'input_request') {
      assert.equal(value.questions[0].optionOnly, true);
      assert.deepEqual(value.questions[0].options.map(option => option.label), ['Blue', 'Green', 'Skip']);
      assert.throws(() => handle.respondInput(value.requestId, { q0: { answers: ['custom text'] } }));
      assert.throws(() => handle.respondInput(value.requestId, { q0: { answers: ['Blue', 'Green'] } }));
      assert.deepEqual(handle.respondInput(value.requestId, { q0: { answers: ['Green'] } }), { ok: true });
      assert.throws(() => handle.respondInput(value.requestId, { q0: { answers: ['Blue'] } }), /已结束/);
    }
  });
  const result = await handle.promise;
  assert.equal(result.error, null); assert.match(result.text, /Continued answer/);
  assert.ok(!f.requests.some(item => item.params?.configId === 'thinking'));
  assert.deepEqual(f.requests.find(item => item.id === 'native-question').result, { outcome: { outcome: 'selected', optionId: 'q0_opt_1' } });
  assert.ok(events.some(item => item.type === 'input_resolved' && !item.value.reason));
});

test('Kimi question timeout preserves the card and partial output and rejects a stale reply', async () => {
  const f = fixture({ interaction: {}, inputTimeoutMs: 15 }), { handle } = f.start();
  const result = await handle.promise;
  assert.equal(result.aborted, false); assert.match(result.error, /问题已保留/);
  assert.equal(result.text, 'Partial progress. ');
  assert.equal(result.deferredInputs[0].status, 'deferred');
  assert.equal(result.deferredInputs[0].questions[0].question, 'Choose a color');
  assert.throws(() => handle.respondInput(result.deferredInputs[0].requestId, { q0: { answers: ['Blue'] } }), /已结束/);
  assert.ok(!f.requests.some(item => item.id === 'native-question'));
});

test('Kimi cancellation dismisses the question without making a deferred continuation', async () => {
  const f = fixture({ interaction: {} }), { handle } = f.start();
  let card;
  handle.onEvent((type, value) => { if (type === 'input_request') card = value; });
  await new Promise(resolve => setImmediate(resolve));
  await handle.cancel();
  const result = await handle.promise;
  assert.equal(result.aborted, true); assert.equal(result.error, null); assert.equal(result.deferredInputs, undefined);
  assert.throws(() => handle.respondInput(card.requestId, { q0: { answers: ['Blue'] } }), /已结束/);
});

test('unexpected ordinary Kimi permission request remains denied', async () => {
  const f = fixture({ interaction: { toolCall: { title: 'Shell', content: [] } } }), { handle } = f.start();
  const events = []; handle.onEvent((type, value) => events.push({ type, value }));
  await handle.promise;
  assert.deepEqual(f.requests.find(item => item.id === 'native-question').result, { outcome: { outcome: 'cancelled' } });
  assert.ok(!events.some(item => item.type === 'input_request'));
});

test('malformed Kimi question choices cannot create an unanswerable card', async () => {
  for (const options of [[], [{ name: 'Missing id', kind: 'allow_once' }],
    [{ optionId: 'a', name: 'Same', kind: 'allow_once' }, { optionId: 'b', name: 'Same', kind: 'allow_once' }]]) {
    const f = fixture({ interaction: { options } }), { handle } = f.start(), events = [];
    handle.onEvent((type, value) => events.push({ type, value }));
    await handle.promise;
    assert.ok(!events.some(item => item.type === 'input_request'));
    assert.deepEqual(f.requests.find(item => item.id === 'native-question').result, { outcome: { outcome: 'cancelled' } });
  }
});

test('Kimi protocol failures retain bounded redacted native stderr', async () => {
  const f = fixture({ wait: true }), { handle } = f.start();
  const events = []; handle.onEvent((type, value) => events.push({ type, value }));
  await new Promise(resolve => setImmediate(resolve));
  f.child.stderr.write('HTTP 429 rate limited; api_key=synthetic-private-value\n');
  f.child.stdout.write('invalid protocol\n');
  const result = await handle.promise;
  assert.match(result.error, /HTTP 429/);
  assert.ok(!JSON.stringify([result, events]).includes('synthetic-private-value'));
});

test('Kimi default route forwards a real ACP question reply through the public runBot handle', async () => {
  const native = require('../src/main/kimiNative');
  const original = native.resolveKimiModel;
  native.resolveKimiModel = async () => 'provider/model';
  try {
    const f = fixture({ interaction: {} });
    const { runBot } = require('../src/main/adapters/cliAdapter');
    const handle = runBot({ bot: { cliType: 'kimi', permissionMode: 'full' }, cliSettings: { enabled: { kimi: true } },
      prompt: 'Question', workspace: '/fixture', executable: { command: 'fixture', argsPrefix: [] },
      spawnProcess: () => f.child });
    let card;
    handle.onEvent((type, value) => {
      if (type === 'input_request') { card = value; handle.respondInput(value.requestId, { q0: { answers: ['Blue'] } }); }
    });
    const result = await handle.promise;
    assert.equal(result.error, null); assert.ok(card); assert.match(result.text, /Continued answer/);
    assert.deepEqual(f.requests.find(item => item.id === 'native-question').result, { outcome: { outcome: 'selected', optionId: 'q0_opt_0' } });
  } finally { native.resolveKimiModel = original; }
});
