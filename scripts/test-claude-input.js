'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createClaudeInput } = require('../src/main/adapters/claudeInput');
const { createClaudeGoal } = require('../src/main/adapters/claudeGoal');
const { SPECS } = require('../src/main/adapters/cliSpecs');

const request = (id = 'native-1', tool = 'Bash', input = { command: 'pwd' }) => ({
  type: 'control_request', request_id: id, request: { subtype: 'can_use_tool', tool_name: tool, input },
});
const questions = { questions: [
  { header: 'Target', question: 'Which target?', options: [{ label: 'One', description: 'first' }, { label: 'Two', description: 'second' }] },
  { header: 'Checks', question: 'Which checks?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
] };
function fixture(t, options = {}) {
  const written = [], events = [], errors = []; let ended = false;
  const protocol = createClaudeInput({ prompt: 'User content', write: data => written.push(JSON.parse(data)),
    end: () => { ended = true; }, emit: (type, data) => events.push({ type, data }),
    onExpire: error => errors.push(error.message), onError: error => errors.push(error.message), ...options });
  t.after(() => protocol.stop());
  return { protocol, written, events, errors, get ended() { return ended; },
    get card() { return events.filter(event => event.type === 'input_request').at(-1)?.data; } };
}
test('Claude initializes before sending a stream-json prompt and closes stdin after the real result', t => {
  const f = fixture(t); f.protocol.start();
  assert.equal(f.written.length, 1); assert.equal(f.written[0].request.subtype, 'initialize');
  const ack = { type: 'control_response', response: { request_id: f.written[0].request_id, subtype: 'success' } };
  assert.equal(f.protocol.consume(ack), true); f.protocol.consume(ack);
  assert.equal(f.written.length, 2); assert.equal(f.written[1].message.content, 'User content');
  assert.equal(f.ended, false); assert.equal(f.protocol.resultVerified, false);
  assert.equal(f.protocol.consume({ type: 'result', is_error: false }), false);
  assert.equal(f.ended, true); assert.equal(f.protocol.resultVerified, true);
});
test('approval responses preserve exact tool inputs and session grants match only the same input', t => {
  const f = fixture(t), input = { command: 'pwd', description: 'Inspect current path' };
  f.protocol.consume(request('one', 'Bash', input));
  assert.match(f.card.detail, /pwd/); assert.equal(f.protocol.pending, true);
  f.protocol.respondInput(f.card.requestId, { decision: 'acceptForSession' });
  assert.deepEqual(f.written.at(-1).response.response, { behavior: 'allow', updatedInput: input });
  assert.equal(f.protocol.pending, false);
  f.protocol.consume(request('two', 'Bash', input));
  assert.equal(f.written.at(-1).response.request_id, 'two'); assert.equal(f.protocol.pending, false);
  f.protocol.consume(request('three', 'Bash', { command: 'rm x' }));
  assert.equal(f.protocol.pending, true); assert.equal(f.written.at(-1).response.request_id, 'two');
  f.protocol.respondInput(f.card.requestId, { decision: 'decline' });
  assert.equal(f.written.at(-1).response.response.behavior, 'deny');
  assert.ok(f.written.every(value => !value.response.response.updatedPermissions));
});
test('read-only keeps restricted native tools and denies excluded tools even if a native request arrives', t => {
  const f = fixture(t, { permissionMode: 'read_only' });
  for (const tool of ['Bash', 'Write', 'Edit', 'mcp__local__write']) {
    f.protocol.consume(request(tool, tool));
    assert.equal(f.written.at(-1).response.response.behavior, 'deny');
  }
  assert.equal(f.events.length, 0);
  f.protocol.consume(request('read', 'Read', { file_path: 'README.md' }));
  assert.equal(f.card.type, 'approval');
  const args = SPECS.claude.args({ permissionMode: 'read_only' });
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob,AskUserQuestion');
  assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__*');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'host');
});
test('AskUserQuestion maps selected and custom answers to the original native question keys', t => {
  const f = fixture(t); f.protocol.consume(request('ask', 'AskUserQuestion', questions));
  assert.equal(f.card.questions[1].multiSelect, true); assert.equal(f.card.questions[0].isOther, true);
  assert.throws(() => f.protocol.respondInput(f.card.requestId, { q0: { answers: ['One'] } }), /回答/);
  assert.equal(f.protocol.pending, true);
  f.protocol.respondInput(f.card.requestId, { q0: { answers: ['Custom answer'] }, q1: { answers: ['A', 'B'] } });
  assert.deepEqual(f.written.at(-1).response.response.updatedInput.answers,
    { 'Which target?': 'Custom answer', 'Which checks?': 'A, B' });
  assert.deepEqual(f.written.at(-1).response.response.updatedInput.questions, questions.questions);
  assert.throws(() => f.protocol.respondInput(f.card.requestId, {}), /已结束/);
});
test('native cancellation invalidates cards without replying to a request the CLI abandoned', t => {
  const f = fixture(t); f.protocol.consume(request()); const id = f.card.requestId;
  assert.equal(f.protocol.consume({ type: 'control_cancel_request', request_id: 'native-1' }), true);
  assert.equal(f.protocol.pending, false); assert.equal(f.written.length, 0);
  assert.equal(f.events.at(-1).data.reason, 'cancelled');
  assert.throws(() => f.protocol.respondInput(id, { decision: 'accept' }), /已结束/);
});
test('expired authorization is denied and resumes the invocation instead of granting permission', async t => {
  const f = fixture(t, { inputTimeoutMs: 10 }); f.protocol.consume(request());
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.written.at(-1).response.response.behavior, 'deny');
  assert.equal(f.protocol.pending, false); assert.equal(f.errors.length, 0);
  assert.equal(f.events.at(-1).data.reason, 'expired');
});
test('expired questions preserve all pending questions for explicit later continuation without fabricated answers', async t => {
  const f = fixture(t, { inputTimeoutMs: 10 });
  f.protocol.consume(request('one', 'AskUserQuestion', questions));
  f.protocol.consume(request('two', 'AskUserQuestion', questions));
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(f.protocol.deferredInputs.length, 2);
  assert.ok(f.protocol.deferredInputs.every(input => input.status === 'deferred' && input.questions.length === 2));
  assert.equal(f.written.length, 0); assert.equal(f.errors.length, 1); assert.equal(f.protocol.pending, false);
});
test('transport failure preserves questions while user cancellation discards pending cards', t => {
  const failed = fixture(t); failed.protocol.consume(request('one', 'AskUserQuestion', questions));
  failed.protocol.stop({ preserveQuestions: true }); assert.equal(failed.protocol.deferredInputs.length, 1);
  const cancelled = fixture(t); cancelled.protocol.consume(request('two', 'AskUserQuestion', questions));
  cancelled.protocol.stop(); assert.equal(cancelled.protocol.deferredInputs.length, 0);
});
test('malformed, oversized, unsupported and duplicate native requests cannot silently grant tools', t => {
  const f = fixture(t);
  f.protocol.consume(request('bad', 'AskUserQuestion', { questions: [{ question: 'Broken' }] }));
  assert.equal(f.written.at(-1).response.response.behavior, 'deny');
  f.protocol.consume(request('large', 'Bash', { command: 'x'.repeat(17000) }));
  assert.equal(f.written.at(-1).response.response.behavior, 'deny');
  f.protocol.consume({ type: 'control_request', request_id: 'unsupported', request: { subtype: 'hook_callback' } });
  assert.equal(f.written.at(-1).response.subtype, 'error');
  f.protocol.consume(request()); f.protocol.consume(request());
  assert.equal(f.events.filter(event => event.type === 'input_request').length, 1);
  assert.throws(() => f.protocol.respondInput(f.card.requestId, { decision: 'yes' }), /授权选项/);
});
test('displayed approval metadata redacts credentials while native allow responses retain the original input', t => {
  const f = fixture(t), input = { command: 'curl', token: 'sensitive-value-fixture' };
  f.protocol.consume(request('secret', 'Bash', input));
  assert.ok(!f.card.detail.includes('sensitive-value-fixture'));
  f.protocol.respondInput(f.card.requestId, { decision: 'accept' });
  assert.equal(f.written.at(-1).response.response.updatedInput.token, input.token);
});
test('goal initialization remains owned by the native goal helper while permission requests use the same stdin', t => {
  const f = fixture(t, { goal: true });
  const goal = createClaudeGoal({ prompt: 'Context', objective: 'Finish fixture', write: data => f.written.push(JSON.parse(data)),
    end() {}, emit() {} });
  f.protocol.start(); assert.equal(f.written.length, 0); goal.start();
  const ack = { type: 'control_response', response: { request_id: f.written[0].request_id, subtype: 'success', response: { commands: [{ name: 'goal', builtin: true }] } } };
  assert.equal(f.protocol.consume(ack), false); goal.consume(ack);
  assert.equal(f.written.at(-1).message.content, '/goal Finish fixture');
  f.protocol.consume(request('ask', 'AskUserQuestion', questions));
  f.protocol.respondInput(f.card.requestId, { q0: { answers: ['One'] }, q1: { answers: ['A'] } });
  assert.equal(f.written.at(-1).response.response.behavior, 'allow');
});

function processFixture(options = {}) {
  const child = new EventEmitter(), stdin = [], events = [], calls = [];
  child.pid = 0; child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.stdin.on('data', data => stdin.push(JSON.parse(data.toString())));
  const filename = require.resolve('../src/main/adapters/cliAdapter'), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, process, setTimeout, clearTimeout, queueMicrotask,
    require(name) {
      if (name === 'child_process') return { spawn(command, args) { calls.push({ command, args }); return child; } };
      if (name === '../cliDiscovery') return { locateCliExecutable: () => process.execPath };
      return name.startsWith('.') ? require(path.resolve(path.dirname(filename), name)) : require(name);
    } });
  const handle = module.exports.runCliBot({ bot: { cliType: 'claude', permissionMode: 'workspace' }, prompt: 'Read the file',
    workspace: process.cwd(), noBytesTimeoutMs: 20, inputTimeoutMs: 200, ...options });
  handle.onEvent((type, data) => events.push({ type, data }));
  const send = value => child.stdout.write(JSON.stringify(value) + '\n');
  send({ type: 'control_response', response: { request_id: stdin[0].request_id, subtype: 'success' } });
  return { child, handle, stdin, events, calls, send };
}
test('process adapter keeps stdin open and suspends inactivity timeout only while a human input is pending', async t => {
  const f = processFixture(); t.after(() => f.handle.cancel());
  assert.equal(f.calls[0].args[f.calls[0].args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.equal(f.stdin[1].message.content, 'Read the file'); assert.equal(f.child.stdin.writableEnded, false);
  f.send(request('permission', 'Bash', { command: 'pwd' }));
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.ok(!f.events.some(event => event.type === 'error'));
  const card = f.events.find(event => event.type === 'input_request').data;
  assert.deepEqual(f.handle.respondInput(card.requestId, { decision: 'accept' }), { ok: true });
  assert.equal(f.stdin.at(-1).response.response.behavior, 'allow');
  f.send({ type: 'assistant', message: { id: 'answer', stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done' }] } });
  f.send({ type: 'result', subtype: 'success', is_error: false, result: 'Done', usage: { input_tokens: 10, output_tokens: 2 } });
  assert.equal(f.child.stdin.writableEnded, true); f.child.emit('close', 0);
  const result = await f.handle.promise;
  assert.equal(result.error, null); assert.equal(result.text, 'Done'); assert.equal(result.usage.inputTokens, 10);
});
test('process adapter returns deferred questions on expiry and rejects late answers', async t => {
  const f = processFixture({ inputTimeoutMs: 10 }); t.after(() => f.handle.cancel());
  f.send(request('ask', 'AskUserQuestion', questions));
  const card = f.events.find(event => event.type === 'input_request').data;
  const result = await f.handle.promise;
  assert.match(result.error, /等待回复超时/); assert.equal(result.deferredInputs.length, 1);
  assert.equal(result.deferredInputs[0].requestId, card.requestId);
  assert.throws(() => f.handle.respondInput(card.requestId, {}), /已结束/);
});
