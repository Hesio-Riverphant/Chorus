'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PARSERS, SPECS } = require('../src/main/adapters/cliSpecs');
const { normalizeActivity } = require('../src/main/adapters/activities');
const { createClaudeGoal } = require('../src/main/adapters/claudeGoal');
const { normalizeExecutionMode } = require('../src/shared/reasoning');
const { runCodexNative } = require('../src/main/adapters/codexPlanAdapter');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

function parser(cli) {
  const acc = {}, events = [];
  return { acc, events, send: value => PARSERS[cli](JSON.stringify(value), (type, payload) => events.push({ type, payload }), acc),
    children: () => (acc.activities || []).filter(activity => activity.kind === 'subagent'),
    text: () => events.filter(event => event.type === 'text').map(event => event.payload).join('') };
}
function dispatch(id = 'dispatch-1', parent = null) {
  return { type: 'assistant', parent_tool_use_id: parent, message: { id: 'parent-message-' + id, content: [
    { type: 'tool_use', id, name: 'Agent', input: { description: 'Review fixture', subagent_type: 'general-purpose', prompt: 'Inspect synthetic fixture', model: 'haiku' } },
  ] } };
}
test('Claude forwards child output without leaking it into the parent answer or parent usage', () => {
  const f = parser('claude'); f.send(dispatch());
  f.send({ type: 'system', subtype: 'task_started', task_type: 'local_agent', tool_use_id: 'dispatch-1', task_id: 'child-1', description: 'Review fixture' });
  f.send({ type: 'assistant', parent_tool_use_id: 'dispatch-1', message: { id: 'child-message', model: 'child-model', usage: { input_tokens: 99 },
    content: [{ type: 'text', text: 'Child output @OtherMember' }] } });
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'child-1', status: 'completed', summary: 'Completed' });
  f.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Parent answer' } } });
  assert.equal(f.text(), 'Parent answer');
  assert.equal(f.children().length, 1);
  assert.equal(f.children()[0].status, 'done');
  assert.equal(f.children()[0].subagent.agentId, 'child-1');
  assert.equal(f.children()[0].subagent.output, 'Child output @OtherMember');
  assert.equal(f.children()[0].subagent.model, 'child-model');
  assert.equal(f.acc.cum, undefined);
});

test('Claude deduplicates child stream deltas and snapshots and preserves nested dispatcher identity', () => {
  const f = parser('claude'); f.send(dispatch()); f.send(dispatch('dispatch-2', 'dispatch-1'));
  const send = event => f.send({ type: 'stream_event', parent_tool_use_id: 'dispatch-2', event });
  send({ type: 'message_start', message: { id: 'm2', model: 'nested-model' } });
  send({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } });
  send({ type: 'content_block_delta', delta: { type: 'text_delta', text: ' child' } });
  f.send({ type: 'assistant', parent_tool_use_id: 'dispatch-2', message: { id: 'm2', content: [{ type: 'text', text: 'Hello child' }] } });
  const child = f.children().find(activity => activity.subagent.agentId === 'dispatch-2');
  assert.equal(child.subagent.output, 'Hello child');
  assert.equal(child.subagent.parentAgentId, 'dispatch-1');
  assert.equal(f.text(), '');
});

test('Claude task results supply actual output when forwarding is unavailable and preserve native failure', () => {
  const f = parser('claude'); f.send(dispatch());
  f.send({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'dispatch-1', is_error: true,
    content: [{ type: 'text', text: 'Failed fixture' }] }] } });
  assert.equal(f.children()[0].status, 'error');
  assert.equal(f.children()[0].subagent.output, 'Failed fixture');
  assert.equal(f.acc.activities.length, 1);
});

test('Claude background shell tasks are not advertised as child agents', () => {
  const f = parser('claude');
  f.send({ type: 'system', subtype: 'task_started', task_type: 'local_bash', task_id: 'bash-task', description: 'Build' });
  f.send({ type: 'system', subtype: 'task_notification', task_id: 'bash-task', status: 'completed', summary: 'Done' });
  assert.equal(f.children().length, 0);
});

test('subagent count, task, output, identifiers and credential fields are bounded before persistence', () => {
  const f = parser('claude');
  for (let i = 0; i < 150; i++) f.send(dispatch('d' + i));
  assert.equal(f.children().length, 100); assert.equal(f.acc.subagents.agents.size, 100);
  const activity = normalizeActivity({ id: 'sub-1', kind: 'subagent', status: 'running',
    subagent: { cliType: 'claude', task: 'x'.repeat(8000), output: 'token=fixture-secret\n' + 'x'.repeat(20000),
      agentId: 'i'.repeat(500), password: 'not-allowlisted' } });
  assert.equal(activity.subagent.outputTruncated, true);
  assert.ok(activity.subagent.task.length <= 4000 && activity.subagent.output.length <= 16384 && activity.subagent.agentId.length <= 160);
  assert.ok(!JSON.stringify(activity).includes('fixture-secret'));
  assert.equal(activity.subagent.password, undefined);
});

test('Codex completed spawn is still running until the child reports its own terminal state', () => {
  const f = parser('codex');
  f.send({ type: 'item.completed', item: { id: 'spawn', type: 'collab_tool_call', tool: 'spawn_agent', status: 'completed',
    sender_thread_id: 'parent', receiver_thread_ids: ['child'], prompt: 'Synthetic child task', model: 'native-model', agents_states: { child: { status: 'running' } } } });
  assert.equal(f.children()[0].status, 'running');
  f.send({ type: 'item.completed', item: { id: 'wait', type: 'collab_tool_call', tool: 'wait', status: 'completed', sender_thread_id: 'parent',
    receiver_thread_ids: ['child'], agents_states: { child: { status: 'completed', message: 'Actual native output' } } } });
  assert.equal(f.children().length, 1); assert.equal(f.children()[0].status, 'done');
  assert.equal(f.children()[0].subagent.task, 'Synthetic child task');
  assert.equal(f.children()[0].subagent.output, 'Actual native output');
  assert.equal(f.text(), '');
});

test('Codex RPC accepts child text only for threads dispatched by this invocation', async () => {
  let listener; const events = [];
  const rpc = { onMessage(fn) { listener = fn; }, initialize: async () => {}, close: async () => {},
    request: async method => method === 'thread/start' ? { thread: { id: 'root', ephemeral: true }, model: 'model' } : { turn: { id: 'turn' } } };
  const h = runCodexNative({ bot: { cliType: 'codex', executionMode: 'chat' }, prompt: 'test', workspace: process.cwd(), rpcFactory: () => rpc });
  h.onEvent((type, payload) => events.push({ type, payload }));
  await new Promise(resolve => setImmediate(resolve));
  listener({ method: 'item/agentMessage/delta', params: { threadId: 'unrelated', itemId: 'bad', delta: 'MUST_NOT_APPEAR' } });
  listener({ method: 'item/completed', params: { threadId: 'root', item: { id: 'spawn', type: 'collabAgentToolCall', tool: 'spawnAgent',
    senderThreadId: 'root', receiverThreadIds: ['owned'], agentsStates: { owned: { status: 'running' } }, prompt: 'child task' } } });
  listener({ method: 'item/agentMessage/delta', params: { threadId: 'owned', itemId: 'm1', delta: 'Child text' } });
  listener({ method: 'turn/completed', params: { threadId: 'owned', turn: { status: 'completed' } } });
  listener({ method: 'turn/completed', params: { threadId: 'root', turn: { status: 'completed' } } });
  const result = await h.promise;
  assert.equal(result.text, ''); assert.equal(result.error, null);
  assert.ok(!JSON.stringify(events).includes('MUST_NOT_APPEAR'));
  assert.equal(events.filter(event => event.type === 'activity').at(-1).payload.subagent.output, 'Child text');
  assert.equal(events.filter(event => event.type === 'activity').at(-1).payload.status, 'done');
});

function goalFixture(objective = 'Complete fixture') {
  const written = [], events = []; let ended = false;
  const protocol = createClaudeGoal({ prompt: 'Room context '.repeat(500), objective,
    write: data => written.push(JSON.parse(data)), end: () => { ended = true; }, emit: (type, payload) => events.push({ type, payload }) });
  const initialize = commands => protocol.consume({ type: 'control_response', response: { request_id: 'convoke-goal-initialize', subtype: 'success', response: { commands } } });
  const local = text => protocol.consume({ type: 'assistant', local_command_run: { command: 'goal' },
    message: { model: '<synthetic>', content: [{ type: 'text', text }] } });
  return { protocol, written, events, initialize, local, get ended() { return ended; } };
}

test('Claude goal is advertised only for supported agents and asks native initialization before dispatch', () => {
  assert.equal(normalizeExecutionMode('claude', 'goal'), 'goal');
  assert.throws(() => normalizeExecutionMode('pi', 'goal'), /不支持/);
  assert.ok(SPECS.claude.args({ executionMode: 'goal' }).includes('--forward-subagent-text'));
  const f = goalFixture(); f.protocol.start();
  assert.equal(f.written.length, 1); assert.equal(f.written[0].request.subtype, 'initialize');
  assert.ok(f.written[0].request.appendSystemPrompt.length > 4000);
  f.initialize([{ name: 'goal', builtin: true }]);
  assert.equal(f.written[1].message.content, '/goal Complete fixture');
});

test('Claude native goal verifies local command acknowledgement and queries native state without a second model prompt', () => {
  const f = goalFixture(); f.protocol.start(); f.initialize([{ name: 'goal', builtin: true }]);
  f.local('Goal set: Complete fixture');
  assert.equal(f.protocol.goal.status, 'active');
  assert.equal(f.protocol.consume({ type: 'result', subtype: 'success', usage: { input_tokens: 10 } }), false);
  assert.equal(f.written.at(-1).message.content, '/goal');
  f.local('No goal set. Usage: `/goal <condition>`');
  assert.equal(f.protocol.goal.status, 'ended');
  assert.equal(f.protocol.consume({ type: 'result', subtype: 'success', usage: { input_tokens: 0 } }), true);
  assert.equal(f.ended, true);
});

test('missing Claude native capability, restricted hooks, unmet goals and invalid objectives fail explicitly', () => {
  const missing = goalFixture(); missing.initialize([]);
  assert.equal(missing.ended, true); assert.equal(missing.protocol.goal.status, 'blocked');
  assert.ok(missing.events.some(event => event.type === 'error'));
  const restricted = goalFixture(); restricted.initialize([{ name: 'goal', builtin: true }]);
  restricted.local('/goal cannot run while hooks are restricted');
  assert.equal(restricted.protocol.goal.status, 'blocked');
  const unfinished = goalFixture(); unfinished.initialize([{ name: 'goal', builtin: true }]);
  unfinished.local('Goal set: Complete fixture'); unfinished.protocol.consume({ type: 'result', is_error: false });
  unfinished.local('Goal active: Complete fixture (not yet evaluated)');
  assert.equal(unfinished.protocol.goal.status, 'blocked');
  assert.throws(() => goalFixture('x'.repeat(4001)), /4000/);
  assert.throws(() => goalFixture('clear'), /具体目标/);
});

test('Claude cancellation preserves the confirmed goal state without claiming completion', () => {
  const f = goalFixture(); f.initialize([{ name: 'goal', builtin: true }]); f.local('Goal set: Complete fixture');
  f.protocol.stop(); assert.equal(f.protocol.goal.status, 'paused');
});

function processFixture() {
  const calls = [], stdin = [], events = [];
  const child = new EventEmitter();
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 0;
  child.stdin.on('data', data => stdin.push(data.toString()));
  const filename = require.resolve('../src/main/adapters/cliAdapter');
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, process, setTimeout, clearTimeout, queueMicrotask,
    require(name) {
      if (name === 'child_process') return { spawn(command, args, options) { calls.push({ command, args, options }); return child; } };
      if (name === '../cliDiscovery') return { locateCliExecutable: () => process.execPath };
      return name.startsWith('.') ? require(path.resolve(path.dirname(filename), name)) : require(name);
    } });
  const h = module.exports.runBot({ bot: { cliType: 'claude', executionMode: 'goal' }, probe: true,
    prompt: 'Synthetic context '.repeat(500), goalObjective: 'Complete fixture', workspace: process.cwd(), noBytesTimeoutMs: 1000 });
  h.onEvent((type, payload) => events.push({ type, payload }));
  const send = o => child.stdout.write(JSON.stringify(o) + '\n');
  const acknowledge = () => {
    send({ type: 'control_response', response: { request_id: 'convoke-goal-initialize', subtype: 'success', response: { commands: [{ name: 'goal', builtin: true }] } } });
    send({ type: 'assistant', local_command_run: { command: 'goal' }, message: { content: [{ type: 'text', text: 'Goal set: Complete fixture' }] } });
  };
  return { calls, stdin, events, child, h, send, acknowledge };
}

test('Claude goal process uses stdin, preserves model usage across the zero-token status query and returns verified state', async () => {
  const f = processFixture(); f.acknowledge();
  assert.ok(f.calls[0].args.includes('--input-format') && f.calls[0].args.includes('--no-session-persistence'));
  assert.ok(!f.calls[0].args.includes('Complete fixture'));
  f.send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done' } } });
  f.send({ type: 'result', subtype: 'success', is_error: false, usage: { input_tokens: 20, output_tokens: 3 }, total_cost_usd: 0.01 });
  f.send({ type: 'assistant', local_command_run: { command: 'goal' }, message: { content: [{ type: 'text', text: 'No goal set. Usage: `/goal <condition>`' }] } });
  f.send({ type: 'result', subtype: 'success', usage: { input_tokens: 0, output_tokens: 0 } });
  f.child.emit('close', 0);
  const result = await f.h.promise;
  assert.equal(result.goal.status, 'ended'); assert.equal(result.text, 'Done');
  assert.equal(result.usage.tokens, 23); assert.equal(result.usage.cliCost, 0.01);
  assert.equal(result.error, null);
});

test('Claude early zero exit and cancellation never become a completed native goal', async () => {
  const early = processFixture(); early.child.emit('close', 0);
  assert.match((await early.h.promise).error, /未确认/);
  const cancelled = processFixture(); cancelled.acknowledge(); await cancelled.h.cancel();
  const result = await cancelled.h.promise;
  assert.equal(result.aborted, true); assert.equal(result.goal.status, 'paused');
});
