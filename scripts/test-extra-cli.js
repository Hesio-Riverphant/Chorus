'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EXTRA_SPECS, EXTRA_PARSERS, EXTRA_CONTRACTS } = require('../src/main/adapters/extraCliSpecs');

test('Pi always disables native session saving and never resumes a saved CLI session', () => {
  for (const id of [null, 'old-session']) {
    const args = EXTRA_SPECS.pi.args({ model: 'provider/model:high' }, id, 'hello');
    assert.deepEqual(args, ['--print', '--mode', 'text', '--no-session', '--no-extensions', '--tools', 'read,grep,find,ls', '--model', 'provider/model:high', '--', 'hello']);
    assert.ok(!args.includes('--session'));
    assert.ok(!args.includes('--resume'));
    assert.ok(!args.includes('old-session'));
  }
});

test('Pi sends arbitrary prompt text in one shell-free argument after the option delimiter', () => {
  const prompt = '--model injected\n中文 "quoted" & echo nope | %PATH% ^ !literal!';
  const args = EXTRA_SPECS.pi.args({}, null, prompt);
  assert.equal(EXTRA_SPECS.pi.requiresShellFree, true);
  assert.equal(EXTRA_SPECS.pi.promptVia, 'arg');
  assert.equal(args.at(-2), '--');
  assert.equal(args.at(-1), prompt);
  assert.ok(args.includes('--no-extensions'));
});

test('leading mentions cannot become Pi file arguments', () => {
  assert.equal(EXTRA_SPECS.pi.args({}, null, '@OtherBot please review').at(-1), '\n@OtherBot please review');
  assert.equal(EXTRA_SPECS.pi.args({}, null, 'Discuss with @OtherBot').at(-1), 'Discuss with @OtherBot');
});

test('Pi rejects missing, blank or NUL input before process construction', () => {
  for (const prompt of [undefined, null, {}, '', ' \n ', 'a\0b']) {
    assert.throws(() => EXTRA_SPECS.pi.args({}, null, prompt), /Pi 提示词/);
  }
});

test('Pi raw output preserves indentation, blank lines, JSON-looking prose and final newline', () => {
  const parts = ['```js\n  ', 'const x = 1;\n\n', '```\n{"type":"error","message":"example"}\n'];
  const events = [];
  for (const part of parts) EXTRA_PARSERS.pi(part, (type, payload) => events.push({ type, payload }), {});
  assert.equal(EXTRA_SPECS.pi.outputMode, 'text');
  assert.equal(events.map((event) => event.payload).join(''), parts.join(''));
  assert.ok(events.every((event) => event.type === 'text'));
});

test('Pi text parser never fabricates session, usage, tool activity or success signals', () => {
  const events = [];
  for (const value of ['', null, {}, 42, 'final text']) {
    EXTRA_PARSERS.pi(value, (type, payload) => events.push({ type, payload }), {});
  }
  assert.deepEqual(events, [{ type: 'text', payload: 'final text' }]);
});

test('OpenCode and Hermes launch native single-shot commands despite native history saving', () => {
  assert.deepEqual(EXTRA_SPECS.opencode.args({ model: 'provider/model' }), ['run', '--format', 'json', '--model', 'provider/model']);
  assert.deepEqual(EXTRA_SPECS.hermes.args({ permissionMode: 'read_only' }, null, 'hello'), ['-z', 'hello', '--toolsets', 'clarify']);
  assert.throws(() => EXTRA_SPECS.hermes.args({ permissionMode: 'workspace' }, null, 'hello'), /工作区/);
  for (const type of ['opencode', 'hermes']) assert.equal(typeof EXTRA_PARSERS[type], 'function');
  const overlay = JSON.parse(EXTRA_SPECS.opencode.env({ permissionMode: 'read_only' }).OPENCODE_CONFIG_CONTENT);
  assert.equal(overlay.share, 'disabled');
  assert.equal(overlay.permission['*'], 'deny');
  assert.equal(overlay.permission.read, 'allow');
});

test('OpenCode normalizes actual JSON stream messages, tool failure and cache usage', () => {
  const events = [], acc = {};
  const emit = (type, payload) => events.push({ type, payload });
  for (const item of [
    { type: 'text', part: { text: 'Reply' } },
    { type: 'step_finish', part: { tokens: { input: 10, output: 5, cache: { read: 20, write: 2 } }, cost: 0.01 } },
    { type: 'error', error: { data: { message: 'failed' } } },
  ]) EXTRA_PARSERS.opencode(JSON.stringify(item), emit, acc);
  assert.equal(events[0].payload, 'Reply');
  assert.equal(events[1].payload.inputTokens, 32);
  assert.equal(events[1].payload.cachedInputTokens, 20);
  assert.deepEqual(events[2], { type: 'error', payload: 'failed' });
});

test('OpenCode preserves unknown usage fields instead of fabricating zero counters', () => {
  const events = [], acc = {};
  const emit = (type, payload) => events.push({ type, payload });
  EXTRA_PARSERS.opencode(JSON.stringify({ type: 'step_finish', part: {} }), emit, acc);
  EXTRA_PARSERS.opencode(JSON.stringify({ type: 'step_finish', part: { tokens: { output: 4 } } }), emit, acc);
  EXTRA_PARSERS.opencode(JSON.stringify({ type: 'step_finish', part: { tokens: { input: 6 }, cost: 0 } }), emit, acc);
  assert.equal(events.length, 2);
  assert.deepEqual(events[0].payload, { outputTokens: 4, cumulative: true });
  assert.deepEqual(events[1].payload, { outputTokens: 4, inputTokens: 6, cliCost: 0, tokens: 10, cumulative: true });
});

test('contract evidence separates documented Pi no-session from unverified runtime and JSON details', () => {
  assert.equal(EXTRA_CONTRACTS.pi.noPersistenceFlag, '--no-session');
  assert.equal(EXTRA_CONTRACTS.pi.noPersistence, 'documented');
  assert.equal(EXTRA_CONTRACTS.pi.stdin, 'unverified');
  assert.match(EXTRA_CONTRACTS.pi.json, /schema unverified/);
  assert.ok(EXTRA_CONTRACTS.hermes.evidence.some((item) => item.includes('HERMES_YOLO_MODE')));
  for (const contract of Object.values(EXTRA_CONTRACTS)) assert.ok(contract.sources.length > 0);
});
