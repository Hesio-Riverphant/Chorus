'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { runCodexNative } = require('../src/main/adapters/codexPlanAdapter');
const { CodexRpc } = require('../src/main/adapters/codexRpc');
const { normalizeActivity } = require('../src/main/adapters/activities');

function fixture(options = {}, behavior = {}) {
  let listener;
  const calls = [], responses = [], events = [];
  let closed = false;
  const rpc = {
    onMessage(fn) { listener = fn; },
    async initialize() { if (behavior.initializeError) throw new Error(behavior.initializeError); },
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-1', ephemeral: true, path: null, ...behavior.thread }, model: 'model-native', reasoningEffort: 'medium' };
      if (behavior.request) { const result = await behavior.request(method, params); if (result) return result; }
      if (method === 'thread/goal/set') return { goal: { status: params.status, tokensUsed: 0, timeUsedSeconds: 0 } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      return {};
    },
    respond(id, result) { responses.push({ id, result }); },
    reject(id, message) { responses.push({ id, error: message }); },
    async close() { closed = true; },
  };
  const handle = runCodexNative({ bot: { cliType: 'codex', executionMode: 'plan', permissionMode: 'workspace' },
    prompt: 'Synthetic plan test', workspace: process.cwd(), noBytesTimeoutMs: 500, rpcFactory: () => rpc, ...options });
  handle.onEvent((type, payload) => events.push({ type, payload }));
  const send = (method, params = {}, id) => listener({ method, params: { threadId: 'thread-1', turnId: 'turn-1', ...params }, ...(id == null ? {} : { id }) });
  const ready = () => new Promise(resolve => setImmediate(resolve));
  const complete = () => send('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  return { handle, calls, responses, events, send, ready, complete, get closed() { return closed; } };
}

test('native commentary stays in activities while the final answer streams once', async () => {
  const f = fixture(); await f.ready();
  f.send('item/agentMessage/delta', { itemId: 'progress', delta: 'Checking the files.' });
  assert.equal(f.events.some(event => event.type === 'text_delta'), false);
  f.send('item/completed', { item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: 'Checking the files.' } });
  f.send('item/started', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '' } });
  f.send('item/agentMessage/delta', { itemId: 'answer', delta: 'Fixed.' });
  assert.equal(f.events.filter(event => event.type === 'text_delta').map(event => event.payload).join(''), 'Fixed.');
  for (let n = 0; n < 2; n++) f.send('item/completed', { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: 'Fixed.' } });
  f.complete();
  assert.equal((await f.handle.promise).text, 'Fixed.');
  const progress = f.events.filter(event => event.type === 'activity').at(-1).payload;
  assert.equal(progress.phase, 'commentary');
  assert.equal(progress.detail, 'Checking the files.');
  assert.equal(progress.status, 'done');
});

test('unknown phases preserve ordered multi-item text without snapshot duplication', async () => {
  const f = fixture(); await f.ready();
  f.send('item/agentMessage/delta', { itemId: 'first', delta: 'First' });
  f.send('item/agentMessage/delta', { itemId: 'second', delta: 'Second' });
  f.send('item/completed', { item: { type: 'agentMessage', id: 'second', phase: 'future_phase', text: 'Second reply' } });
  f.send('item/completed', { item: { type: 'agentMessage', id: 'first', text: 'First reply' } });
  f.send('item/completed', { item: { type: 'agentMessage', id: 'second', text: 'Second reply' } });
  f.complete();
  assert.equal((await f.handle.promise).text, 'First reply\n\nSecond reply');
  assert.equal(f.events.filter(event => event.type === 'text_delta').map(event => event.payload).join(''), 'First reply\n\nSecond reply');
});

test('commentary-only completion, interruption and cancellation retain full diagnostics', async () => {
  const text = 'Progress detail. '.repeat(300);
  for (const ending of ['completed', 'interrupted', 'cancel', 'error']) {
    const f = fixture(); await f.ready();
    f.send('item/started', { item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: '' } });
    f.send('item/agentMessage/delta', { itemId: 'progress', delta: text });
    if (ending === 'cancel') await f.handle.cancel();
    else if (ending === 'error') f.send('error', { error: { message: 'Connection failed' } });
    else f.send('turn/completed', { turn: { status: ending } });
    const result = await f.handle.promise;
    assert.equal(result.text, text);
    assert.equal(result.aborted, ending === 'cancel' || ending === 'interrupted');
    assert.equal(!!result.error, ending === 'error');
    assert.equal(f.events.filter(event => event.type === 'activity').at(-1).payload.detail, text);
  }
});

test('unfinished unknown-phase deltas survive connection loss', async () => {
  const f = fixture(); await f.ready();
  f.send('item/agentMessage/delta', { itemId: 'partial', delta: 'Partial answer' });
  f.send('transport/closed');
  const result = await f.handle.promise;
  assert.equal(result.text, 'Partial answer');
  assert.match(result.error, /回复完成前结束/);
});

test('long commentary survives activity normalization and a full activity list preserves overflow text', async () => {
  const f = fixture(); await f.ready();
  const progress = 'A complete progress paragraph. '.repeat(100);
  f.send('item/completed', { item: { type: 'agentMessage', id: 'progress', phase: 'commentary', text: progress } });
  const activity = f.events.filter(event => event.type === 'activity').at(-1).payload;
  assert.equal(normalizeActivity(normalizeActivity(activity)).detail, progress);
  for (let index = 1; index < 100; index++) {
    f.send('item/completed', { item: { type: 'commandExecution', id: `command-${index}`, command: 'synthetic command' } });
  }
  f.send('item/completed', { item: { type: 'agentMessage', id: 'overflow', phase: 'commentary', text: 'Preserved overflow.' } });
  f.send('item/completed', { item: { type: 'agentMessage', id: 'final', phase: 'final_answer', text: 'The conclusion.' } });
  f.complete();
  assert.equal((await f.handle.promise).text, 'Preserved overflow.\n\nThe conclusion.');
});

test('interleaved final items retain ordered boundaries and late deltas cannot duplicate completed snapshots', async () => {
  const f = fixture(); await f.ready();
  for (const id of ['first', 'second']) {
    f.send('item/started', { item: { type: 'agentMessage', id, phase: 'final_answer', text: '' } });
    f.send('item/agentMessage/delta', { itemId: id, delta: id });
  }
  f.send('item/completed', { item: { type: 'agentMessage', id: 'second', text: 'second answer' } });
  f.send('item/completed', { item: { type: 'agentMessage', id: 'first', text: 'first answer' } });
  f.send('item/agentMessage/delta', { itemId: 'second', delta: 'second answer' });
  f.complete();
  assert.equal((await f.handle.promise).text, 'first answer\n\nsecond answer');
  assert.equal(f.events.filter(event => event.type === 'text_delta').map(event => event.payload).join(''), 'first answer\n\nsecond answer');
});

test('unknown-phase buffering enforces the existing aggregate response size limit', async () => {
  const f = fixture(); await f.ready();
  f.send('item/agentMessage/delta', { itemId: 'partial', delta: 'Preserved prefix' });
  f.send('item/agentMessage/delta', { itemId: 'oversized', delta: 'x'.repeat(4 * 1024 * 1024) });
  const result = await f.handle.promise;
  assert.match(result.error, /大小上限/);
  assert.equal(result.text, 'Preserved prefix');
});

test('native plan uses ephemeral thread, CLI model, reasoning and built-in plan instructions', async () => {
  const f = fixture({ bot: { cliType: 'codex', executionMode: 'plan', reasoningEffort: 'high', permissionMode: 'workspace' } });
  await f.ready();
  assert.deepEqual(f.calls[0].params, { cwd: process.cwd(), ephemeral: true, approvalPolicy: 'on-request', sandbox: 'workspace-write' });
  assert.deepEqual(f.calls[1].params.collaborationMode, { mode: 'plan', settings: { model: 'model-native', reasoning_effort: 'high', developer_instructions: null } });
  f.send('item/agentMessage/delta', { itemId: 'message-1', delta: 'Planning.' });
  f.send('item/completed', { item: { type: 'agentMessage', id: 'message-1', text: 'Planning.' } });
  f.send('item/plan/delta', { itemId: 'plan-1', delta: 'draft' });
  f.send('item/completed', { item: { type: 'plan', id: 'plan-1', text: '1. Verify\n2. Deliver' } });
  f.complete();
  const result = await f.handle.promise;
  assert.equal(result.text, 'Planning.\n\n1. Verify\n2. Deliver');
  assert.equal(result.sessionId, null);
  assert.equal(result.error, null);
  assert.equal(f.closed, true);
});

test('native default runs capability overrides without writing native settings', async () => {
  const f = fixture({ bot: { cliType: 'codex', model: 'model-test', reasoningEffort: 'low', permissionMode: 'full' },
    nativeConfig: { mcp_servers: { sample: { enabled: false } }, plugins: { 'sample@test': { enabled: true } } } });
  await f.ready();
  assert.equal(f.calls[0].params.model, 'model-test');
  assert.equal(f.calls[0].params.allowProviderModelFallback, false);
  assert.equal(f.calls[0].params.sandbox, 'danger-full-access');
  assert.equal(f.calls[0].params.config.mcp_servers.sample.enabled, false);
  assert.equal(f.calls[1].params.effort, 'low');
  assert.equal(f.calls[1].params.collaborationMode, undefined);
  f.complete(); await f.handle.promise;
  assert.throws(() => fixture({ nativeConfig: { approval_policy: 'never' } }), /能力配置无效/);
});

test('native history uncertainty gives a truthful notice and still starts the requested mode', async () => {
  const f = fixture({}, { thread: { ephemeral: false, path: 'native-history' } });
  await f.ready();
  assert.equal(f.calls.some(call => call.method === 'turn/start'), true);
  assert.equal(f.events.some(event => event.type === 'history_notice'), true);
  f.complete(); assert.equal((await f.handle.promise).error, null);
});

test('native context usage is latest request, billed usage is invocation total', async () => {
  const f = fixture(); await f.ready();
  f.send('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 500, outputTokens: 20, totalTokens: 520 },
    total: { inputTokens: 1500, outputTokens: 80, totalTokens: 1580, cachedInputTokens: 1000, reasoningOutputTokens: 25 }, modelContextWindow: 200000 } });
  f.complete(); const result = await f.handle.promise;
  assert.equal(result.usage.tokens, 1580);
  assert.deepEqual(result.contextUsage, { inputTokens: 500, outputTokens: 20, totalTokens: 520, contextWindow: 200000, source: 'native' });
});

test('questions round trip, reject stale or incomplete answers, and pause output watchdog', async () => {
  const f = fixture({ noBytesTimeoutMs: 30 }); await f.ready();
  f.send('item/tool/requestUserInput', { isBlocking: true, itemId: 'question', questions: [{ id: 'color', header: 'Color', question: 'Choose a color', isOther: true,
    options: [{ label: 'Blue', description: 'Calm' }] }] }, 17);
  const request = f.events.find(event => event.type === 'input_request').payload;
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.equal(f.closed, false);
  assert.throws(() => f.handle.respondInput(request.requestId, {}), /回答所有问题/);
  assert.deepEqual(f.handle.respondInput(request.requestId, { color: { answers: ['Blue'] } }), { ok: true });
  assert.equal(f.responses[0].id, 17);
  assert.deepEqual(f.responses[0].result.answers.color, { answers: ['Blue'] });
  assert.throws(() => f.handle.respondInput(request.requestId, { color: { answers: ['Blue'] } }), /提问已结束/);
  f.complete(); assert.equal((await f.handle.promise).error, null);
});

test('questions time out cleanly and retain only unanswered questions for explicit continuation', async () => {
  const f = fixture({ inputTimeoutMs: 10 }); await f.ready();
  f.send('item/tool/requestUserInput', { isBlocking: true, questions: [{ id: 'x', question: 'Choose' }] }, 21);
  const result = await f.handle.promise;
  assert.match(result.error, /等待回复超时/);
  assert.equal('questions' in result, false);
  assert.equal('answers' in result, false);
  assert.equal(result.deferredInputs[0].questions[0].question, 'Choose');
  assert.equal(result.deferredInputs[0].status, 'deferred');
});

test('cancel interrupts the live native turn, clears its pending question and closes', async () => {
  const f = fixture(); await f.ready();
  f.send('item/tool/requestUserInput', { isBlocking: true, questions: [{ id: 'x', question: 'Choose' }] }, 22);
  const request = f.events.find(event => event.type === 'input_request').payload;
  await f.handle.cancel();
  assert.deepEqual(f.calls.at(-1), { method: 'turn/interrupt', params: { threadId: 'thread-1', turnId: 'turn-1' } });
  assert.equal((await f.handle.promise).aborted, true);
  assert.throws(() => f.handle.respondInput(request.requestId, { x: { answers: ['yes'] } }), /提问已结束/);
});

test('native protocol failures redact credential-like data and stop the runtime', async () => {
  const f = fixture(); await f.ready();
  f.send('error', { error: { message: 'bad api_key=do-not-expose' }, willRetry: false });
  const result = await f.handle.promise;
  assert.ok(result.error.includes('[已隐藏]'));
  assert.ok(!JSON.stringify(f.events).includes('do-not-expose'));
});

test('server loss and silent runtime have explicit failure results', async () => {
  const f = fixture(); await f.ready();
  f.send('transport/closed', {});
  assert.match((await f.handle.promise).error, /回复完成前结束/);
  const silent = fixture({ noBytesTimeoutMs: 10 });
  assert.match((await silent.handle.promise).error, /长时间无输出/);
});

test('native command approvals round trip with session scope and secret input is not surfaced', async () => {
  const f = fixture(); await f.ready();
  f.send('item/commandExecution/requestApproval', { command: 'write to disk' }, 31);
  const request = f.events.find(event => event.type === 'input_request').payload;
  assert.equal(request.type, 'approval');
  assert.match(request.detail, /write to disk/);
  assert.equal(f.responses.length, 0);
  assert.throws(() => f.handle.respondInput(request.requestId, { decision: 'arbitrary' }), /授权选项无效/);
  f.handle.respondInput(request.requestId, { decision: 'acceptForSession' });
  assert.deepEqual(f.responses[0], { id: 31, result: { decision: 'acceptForSession' } });
  f.send('item/tool/requestUserInput', { questions: [{ id: 'secret', question: 'Password', isSecret: true }] }, 32);
  assert.match((await f.handle.promise).error, /提问格式不受支持/);
  assert.equal(f.events.filter(event => event.type === 'input_request').length, 1);
});

test('approval expiration denies and keeps the native turn running; available decisions are enforced', async () => {
  const f = fixture({ inputTimeoutMs: 15 }); await f.ready();
  f.send('item/commandExecution/requestApproval', { command: 'sensitive', availableDecisions: ['accept', 'decline'] }, 41);
  const request = f.events.find(event => event.type === 'input_request').payload;
  assert.throws(() => f.handle.respondInput(request.requestId, { decision: 'acceptForSession' }), /授权选项无效/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.deepEqual(f.responses[0], { id: 41, result: { decision: 'decline' } });
  assert.equal(f.closed, false);
  f.complete(); assert.equal((await f.handle.promise).error, null);
});

test('nonblocking questions remain answerable after the native turn has completed', async () => {
  const f = fixture(); await f.ready();
  f.send('item/tool/requestUserInput', { isBlocking: false, questions: [{ id: 'q', question: 'Next step?' }] }, 20);
  f.complete(); const result = await f.handle.promise;
  assert.equal(result.error, null); assert.equal(result.deferredInputs[0].questions[0].id, 'q');
});

test('process-tree cleanup reports OS refusal without rejecting cancellation', async () => {
  const { terminateTree } = require('../src/main/adapters/processTree');
  const result = await terminateTree(123, { platform: 'win32',
    spawnProcess() { const child = new EventEmitter(); queueMicrotask(() => child.emit('close', 5)); return child; },
    killProcess() { throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); } });
  assert.deepEqual(result, { scope: 'unconfirmed', code: 'EPERM' });
});

test('permission grant replies preserve exact requested scope and probes never prompt', async () => {
  const f = fixture(); await f.ready();
  const permissions = { network: { enabled: true }, fileSystem: { write: ['/tmp/project'] } };
  f.send('item/permissions/requestApproval', { permissions }, 51);
  f.handle.respondInput(f.events.find(event => event.type === 'input_request').payload.requestId, { decision: 'accept' });
  assert.deepEqual(f.responses[0].result, { permissions, scope: 'turn' });
  f.complete(); await f.handle.promise;
  const probe = fixture({ probe: true }); await probe.ready();
  probe.send('item/fileChange/requestApproval', {}, 52);
  assert.deepEqual(probe.responses[0].result, { decision: 'decline' });
  assert.equal(probe.events.some(event => event.type === 'input_request'), false);
  probe.complete(); await probe.handle.promise;
});

test('Codex transport preserves split UTF-8 and rejects pending requests on process error', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true;
  const rpc = new CodexRpc({ spawnProcess: () => child, timeoutMs: 500 });
  const messages = []; rpc.onMessage(message => messages.push(message));
  const pending = rpc.request('sample');
  const wire = Buffer.from(JSON.stringify({ method: 'notify', params: { value: '中文' } }) + '\n');
  const split = wire.indexOf(Buffer.from('中')) + 1;
  child.stdout.write(wire.subarray(0, split)); child.stdout.write(wire.subarray(split));
  assert.equal(messages[0].params.value, '中文');
  child.emit('error', new Error('api_key=private-value'));
  await assert.rejects(pending, /\[已隐藏\]/);
  assert.equal(messages[1].method, 'transport/error');
  assert.ok(!JSON.stringify(messages).includes('private-value'));
  child.emit('close', 1); await rpc.close();
});

test('Windows shutdown captures the process tree before ending native stdin', { skip: process.platform !== 'win32' }, async () => {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
  child.kill = () => true;
  const killer = new EventEmitter(); killer.kill = () => true;
  const calls = [];
  const rpc = new CodexRpc({ spawnProcess(command, args) {
    calls.push({ command, args, stdinEnded: child.stdin.writableEnded });
    return command === 'taskkill' ? killer : child;
  } });
  const closing = rpc.close();
  assert.deepEqual(calls[1], { command: 'taskkill', args: ['/pid', '12345', '/T', '/F'], stdinEnded: false });
  let resolved = false; closing.then(() => { resolved = true; });
  child.emit('close', 0);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(resolved, false, 'launcher exit alone must not finish descendant cleanup');
  killer.emit('close', 0); await closing;
  assert.equal(child.stdin.destroyed, true);
});


test('native goal starts persistent continuation, waits across active turns and returns terminal status', async () => {
  const f = fixture({ bot: { cliType: 'codex', executionMode: 'goal', reasoningEffort: 'low' } }, { thread: { ephemeral: false, path: 'native-history' } });
  await f.ready();
  assert.equal(f.calls[0].params.ephemeral, false);
  assert.equal(f.calls[0].params.config.model_reasoning_effort, 'low');
  assert.equal(f.calls[1].method, 'thread/goal/set');
  assert.equal(f.calls[1].params.objective, 'Synthetic plan test');
  assert.equal(f.calls.some(call => call.method === 'turn/start'), false);
  f.complete(); await f.ready(); assert.equal(f.closed, false);
  f.send('turn/started', { turnId: 'turn-2', turn: { id: 'turn-2' } });
  f.send('thread/goal/updated', { turnId: 'turn-2', goal: { status: 'complete', tokensUsed: 42, timeUsedSeconds: 2 } });
  assert.equal(f.closed, false);
  f.send('item/agentMessage/delta', { turnId: 'turn-2', itemId: 'final', delta: 'Goal done' });
  f.send('turn/completed', { turnId: 'turn-2', turn: { id: 'turn-2', status: 'completed' } });
  const result = await f.handle.promise;
  assert.equal(result.text, 'Goal done'); assert.equal(result.goal.status, 'complete');
  assert.equal(result.sessionId, null);
});

test('goal cancellation interrupts then pauses its owned native goal before bounded close', async () => {
  const f = fixture({ bot: { cliType: 'codex', executionMode: 'goal' } }, { thread: { ephemeral: false } });
  await f.ready(); f.send('turn/started', { turn: { id: 'turn-1' } });
  await f.handle.cancel();
  assert.equal(f.calls.some(call => call.method === 'thread/goal/set' && call.params.status === 'paused'), true);
  assert.equal(f.calls.some(call => call.method === 'turn/interrupt'), true);
  const result = await f.handle.promise;
  assert.equal(result.aborted, true);
  assert.equal(result.goal.status, 'paused');
  assert.equal(f.closed, true);
});


test('goal status arriving after turn completion still settles with its truthful native state', async () => {
  for (const status of ['complete', 'blocked', 'paused', 'usageLimited', 'budgetLimited']) {
    const f = fixture({ bot: { cliType: 'codex', executionMode: 'goal' } }, { thread: { ephemeral: false } });
    await f.ready(); f.send('turn/started', { turn: { id: 'turn-1' } }); f.complete();
    f.send('thread/goal/updated', { goal: { status } });
    const result = await f.handle.promise;
    assert.equal(result.goal.status, status);
    assert.equal(!!result.error, status !== 'complete');
  }
});

test('late goal activation response never overwrites a newer native terminal notification', async () => {
  let respond;
  const f = fixture({ bot: { cliType: 'codex', executionMode: 'goal' } }, {
    thread: { ephemeral: false }, request: (method) => method === 'thread/goal/set' ? new Promise(resolve => { respond = resolve; }) : undefined,
  });
  await f.ready();
  f.send('turn/started', { turn: { id: 'turn-1' } });
  f.send('thread/goal/updated', { goal: { status: 'complete' } });
  respond({ goal: { status: 'active' } }); await f.ready(); f.complete();
  assert.equal((await f.handle.promise).goal.status, 'complete');
});

test('native usage without cached token fields never invents a zero cache hit rate', async () => {
  const f = fixture(); await f.ready();
  f.send('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 50, outputTokens: 5, totalTokens: 55 } } });
  f.complete();
  assert.equal(Object.hasOwn((await f.handle.promise).usage, 'cachedInputTokens'), false);
});


test('goal pause rejection preserves its last confirmed status while cancellation still closes', async () => {
  const f = fixture({ bot: { cliType: 'codex', executionMode: 'goal' } }, {
    thread: { ephemeral: false }, request: (method, params) => {
      if (method === 'thread/goal/set' && params.status === 'paused') throw new Error('pause unavailable');
    },
  });
  await f.ready(); await f.handle.cancel();
  const result = await f.handle.promise;
  assert.equal(result.aborted, true); assert.equal(result.goal.status, 'active');
  assert.equal(f.closed, true);
});


test('native command output streams before completion and edited paths keep native order', async () => {
  const f = fixture(); await f.ready();
  f.send('item/agentMessage/delta', { itemId: 'early', delta: 'Checking.' });
  f.send('item/started', { item: { type: 'commandExecution', id: 'command', command: 'node --check demo.js' } });
  f.send('item/commandExecution/outputDelta', { itemId: 'command', delta: 'first\n' });
  f.send('item/commandExecution/outputDelta', { itemId: 'command', delta: 'second' });
  const running = f.events.filter(event => event.type === 'activity' && event.payload.id === 'command').at(-1).payload;
  assert.equal(running.status, 'running'); assert.equal(running.detail, 'node --check demo.js\nfirst\nsecond');
  f.send('item/completed', { item: { type: 'agentMessage', id: 'early', phase: 'commentary', text: 'Checking.' } });
  f.send('item/completed', { item: { type: 'fileChange', id: 'edit', changes: [{ path: 'src/demo.js' }] } });
  const progress = f.events.find(event => event.type === 'activity' && event.payload.id === 'early').payload;
  const edit = f.events.find(event => event.type === 'activity' && event.payload.id === 'edit').payload;
  assert.ok(progress.order < running.order); assert.ok(running.order < edit.order);
  assert.deepEqual(normalizeActivity(edit).files, ['src/demo.js']);
  f.complete(); await f.handle.promise;
});


test('Linux Codex launch paths containing spaces are passed literally without shell quoting', async () => {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const filename = require.resolve('../src/main/adapters/codexRpc');
  const exported = { exports: {} }, calls = [];
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module: exported, process: { platform: 'linux', env: {} }, Buffer, setTimeout, clearTimeout,
    require: name => name === '../cliDiscovery' ? { locateCliExecutable: () => '/home/test user/.local/bin/codex' }
      : name.startsWith('.') ? require(path.resolve(path.dirname(filename), name)) : require(name),
  });
  const rpc = new exported.exports.CodexRpc({ spawnProcess: (command, args, options) => { calls.push({ command, options }); return child; } });
  assert.equal(calls[0].command, '/home/test user/.local/bin/codex'); assert.equal(calls[0].options.shell, false);
  await rpc.close();
});


test('RPC consumes BOM and final split UTF8 response without newline exactly once', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
  const rpc = new CodexRpc({ spawnProcess: () => child });
  const events = []; rpc.onMessage(event => events.push(event));
  const pending = rpc.request('sample');
  const wire = Buffer.from('\uFEFF' + JSON.stringify({ id: 1, result: { text: '中文 😀' } }));
  for (const byte of wire) child.stdout.write(Buffer.from([byte]));
  child.emit('close', 0); child.emit('close', 0);
  assert.deepEqual(await pending, { text: '中文 😀' });
  assert.equal(events.filter(event => event.method === 'transport/closed').length, 1);
  assert.equal(rpc.pending.size, 0); await rpc.close(); assert.equal(child.stdin.destroyed, true);
});

test('RPC closed before response rejects pending work and ignores late terminal bytes', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
  const rpc = new CodexRpc({ spawnProcess: () => child });
  const rejected = assert.rejects(rpc.request('sample'), /关闭/);
  await rpc.close(); child.stdout.write(JSON.stringify({ id: 1, result: 'late' })); child.emit('close', 0);
  await rejected; assert.equal(rpc.pending.size, 0);
});


test('Codex transport owns and terminates real synthetic child and grandchild processes', { timeout: 15000 }, async () => {
  const { spawn } = require('node:child_process');
  const { terminateTree } = require('../src/main/adapters/processTree');
  const grandchild = 'setInterval(() => {}, 1000)';
  const childCode = `const {spawn}=require('node:child_process'); const g=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore',windowsHide:true});
    process.stdout.write(JSON.stringify({method:'fixture/ready',params:{pids:[process.ppid,process.pid,g.pid]}})+'\\n'); setInterval(()=>{},1000);`;
  const parentCode = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','ignore'],windowsHide:true});c.stdout.pipe(process.stdout);setInterval(()=>{},1000);`;
  let pids = [], native;
  const rpc = new CodexRpc({ spawnProcess(command, args, options) {
    if (command === 'taskkill') return spawn(command, args, options);
    native = spawn(process.execPath, ['-e', parentCode], { ...options, shell: false }); return native;
  } });
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  try {
    await Promise.race([
      new Promise(resolve => rpc.onMessage(message => { if (message.method === 'fixture/ready') { pids = message.params.pids; resolve(); } })),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Fixture process readiness timeout')), 5000); timer.unref(); }),
    ]);
    assert.equal(pids.length, 3); assert.ok(pids.every(alive));
    await Promise.all([rpc.close(), rpc.close()]);
    const deadline = Date.now() + 5000;
    while (pids.some(alive) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(pids.every(pid => !alive(pid)), `Owned processes survived: ${pids.filter(alive)}`);
  } finally {
    await rpc.close();
    for (const pid of [native?.pid, ...pids].filter(Number.isInteger)) if (alive(pid)) await terminateTree(pid);
  }
});

test('process tree cleanup handles taskkill error, failure and timeout exactly once with root fallback', async () => {
  const { terminateTree } = require('../src/main/adapters/processTree');
  for (const mode of ['throw', 'error', 'failed', 'timeout']) {
    const calls = [], killer = new EventEmitter(); killer.kill = () => {};
    await terminateTree(123, { platform: 'win32', timeoutMs: 5,
      killProcess: (pid, signal) => calls.push([pid, signal]),
      spawnProcess() { if (mode === 'throw') throw new Error('spawn failed');
        queueMicrotask(() => { if (mode === 'error') killer.emit('error', new Error('taskkill failed'));
          else if (mode === 'failed') killer.emit('close', 1); }); return killer; },
    });
    killer.emit('close', 1);
    assert.deepEqual(calls, [[123, 'SIGKILL']]);
  }
  const calls = [];
  await terminateTree(456, { platform: 'linux', killProcess: (pid, signal) => calls.push([pid, signal]) });
  assert.deepEqual(calls, [[-456, 'SIGKILL']]);
});


test('RPC nonzero exit rejects a buffered response rather than accepting success', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => true;
  const rpc = new CodexRpc({ spawnProcess: () => child });
  const rejected = assert.rejects(rpc.request('sample'), /结束/);
  child.stdout.write(JSON.stringify({ id: 1, result: 'late success' })); child.emit('close', 1);
  await rejected; await rpc.close();
});
