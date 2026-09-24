'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAINSTREAM_SPECS: specs, MAINSTREAM_PARSERS: parsers } = require('../src/main/adapters/mainstreamCliSpecs');
const Reasoning = require('../src/shared/reasoning');
const { metadata, compatibleReasoning } = require('../src/main/kimiNative');

test('Gemini, Qwen and Copilot use documented noninteractive commands and explicit permissions', () => {
  const { listProfiles } = require('../src/main/cliRegistry');
  for (const id of ['gemini', 'qwen', 'copilot']) assert.ok(listProfiles().some(item => item.id === id));
  assert.deepEqual(specs.gemini.args({ permissionMode: 'full', model: 'flash' }), ['--output-format', 'stream-json', '--approval-mode', 'yolo', '--model', 'flash']);
  assert.equal(specs.gemini.promptVia, 'stdin');
  assert.equal(specs.gemini.args({ permissionMode: 'read_only' }).at(-1), 'plan');
  assert.equal(specs.qwen.args({ permissionMode: 'workspace' }, null, 'hi & literal').at(-1), 'auto-edit');
  assert.equal(specs.qwen.args({}, null, 'hi & literal')[1], 'hi & literal');
  assert.ok(specs.copilot.args({ permissionMode: 'full' }, null, 'hi').includes('--allow-all'));
  const readonly = specs.copilot.args({ permissionMode: 'read_only' }, null, 'hi');
  assert.equal(readonly[readonly.indexOf('--available-tools') + 1], 'view');
  assert.throws(() => specs.copilot.args({ permissionMode: 'workspace' }, null, 'hi'), /工作区/);
});

test('Gemini stream separates process prose, tools, final text and actual cache counts', () => {
  const events = [], acc = {}, emit = (type, value) => events.push({ type, value });
  for (const item of [
    { type: 'message', role: 'user', content: 'not output' },
    { type: 'message', role: 'assistant', content: 'Checking.' },
    { type: 'tool_use', tool_name: 'read_file', tool_id: 't' },
    { type: 'tool_result', tool_id: 't', status: 'success', output: 'contents' },
    { type: 'message', role: 'assistant', content: 'Final.' },
    { type: 'result', status: 'success', stats: { input_tokens: 100, output_tokens: 7, cached: 80 } },
  ]) parsers.gemini(JSON.stringify(item), emit, acc);
  assert.ok(events.some(item => item.type === 'activity' && item.value.phase === 'commentary' && item.value.detail === 'Checking.'));
  assert.ok(events.some(item => item.type === 'activity' && item.value.id === 't' && item.value.status === 'done'));
  assert.deepEqual(events.find(item => item.type === 'usage').value, { inputTokens: 100, outputTokens: 7, tokens: 107, cachedInputTokens: 80, cumulative: true });
  assert.ok(!events.some(item => item.value === 'not output'));
});

test('Qwen final result replaces prior text and preserves structured failures without invented token counts', () => {
  const events = [], emit = (type, value) => events.push({ type, value }), acc = {};
  for (const item of [
    { type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 'Checking' }, { type: 'tool_use', id: 't', name: 'read_file' }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'contents' }] } },
    { type: 'result', is_error: false, result: 'Answer' },
    { type: 'result', is_error: true, error: { message: 'Failure' } },
  ]) parsers.qwen(JSON.stringify(item), emit, acc);
  assert.ok(events.some(item => item.type === 'text_replace' && item.value === 'Answer'));
  assert.ok(events.some(item => item.type === 'error' && item.value === 'Failure'));
  assert.equal(events.filter(item => item.type === 'usage').length, 0);
});

test('Kimi reasoning choices follow native metadata including locked-on effort models', () => {
  const models = metadata({ models: {
    k2: { model: 'kimi-k2.6', capabilities: ['thinking'] },
    k3: { model: 'kimi-k3', capabilities: ['thinking', 'always_thinking'], supportEfforts: ['low', 'high', 'max', 'invalid'] },
  } });
  assert.deepEqual(Reasoning.levelsFor('kimi', 'k2', models), ['off', 'on']);
  assert.deepEqual(Reasoning.levelsFor('kimi', 'k3', models), ['low', 'high', 'max']);
  assert.equal(Reasoning.normalizeEffort('kimi', 'high', 'provider/arbitrary-alias'), 'high');
  assert.throws(() => Reasoning.normalizeEffort('kimi', 'high;exit'), /无效/);
  const old = compatibleReasoning(models, '0.28.1');
  assert.deepEqual(old[0].reasoningLevels, ['off', 'on']);
  assert.deepEqual(old[1].reasoningLevels, ['on']);
  assert.deepEqual(compatibleReasoning(models, '2.1.1')[1].reasoningLevels, ['low', 'high', 'max']);
  assert.deepEqual(compatibleReasoning(models, '')[1].reasoningLevels, ['on']);
});

test('Gemini full activity history retains prose when the process record cannot be saved', () => {
  const acc = { activities: Array.from({ length: 100 }, (_, i) => ({ id: String(i), kind: 'tool' })) }, events = [];
  const emit = (type, value) => events.push({ type, value });
  parsers.gemini(JSON.stringify({ type: 'message', role: 'assistant', content: 'Keep this' }), emit, acc);
  parsers.gemini(JSON.stringify({ type: 'tool_use', tool_id: 'new', tool_name: 'Read' }), emit, acc);
  assert.equal(acc.pendingText, 'Keep this');
  assert.ok(!events.some(item => item.type === 'text_replace'));
});

test('Qwen reports actual native cumulative usage including cache hits on completed and failed turns', () => {
  for (const is_error of [false, true]) {
    const events = [];
    parsers.qwen(JSON.stringify({ type: 'result', is_error, result: 'answer', usage: { input_tokens: 123, output_tokens: 45, cache_read_input_tokens: 100 } }),
      (type, value) => events.push({ type, value }), {});
    assert.deepEqual(events.find(item => item.type === 'usage').value, { inputTokens: 123, outputTokens: 45, tokens: 168, cachedInputTokens: 100, cumulative: true });
  }
  const events = [];
  parsers.qwen(JSON.stringify({ type: 'result', usage: { input_tokens: 123 } }), (type, value) => events.push({ type, value }), {});
  assert.ok(!events.some(item => item.type === 'usage'));
});

test('Qwen authoritative final does not discard process prose when activity storage is full', () => {
  const acc = { activities: Array.from({ length: 100 }, (_, i) => ({ id: String(i), kind: 'tool' })) }, events = [];
  const emit = (type, value) => events.push({ type, value });
  parsers.qwen(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Keep this' }, { type: 'tool_use', id: 'new', name: 'Read' }] } }), emit, acc);
  parsers.qwen(JSON.stringify({ type: 'result', result: 'Answer' }), emit, acc);
  assert.equal(events.findLast(item => item.type === 'text_replace').value, 'Keep this\nAnswer');
});

test('Cursor and Droid apply documented permissions and preserve native model identifiers', () => {
  const cursor = specs.cursor.args({ permissionMode: 'full', model: 'model-id' });
  assert.deepEqual(cursor, ['--print', '--output-format', 'stream-json', '--model', 'model-id', '--force']);
  assert.deepEqual(specs.cursor.args({ permissionMode: 'read_only' }).slice(-2), ['--mode', 'ask']);
  assert.throws(() => specs.cursor.args({ permissionMode: 'workspace' }), /工作区/);
  assert.deepEqual(specs.droid.args({ permissionMode: 'read_only' }), ['exec', '--output-format', 'json']);
  assert.deepEqual(specs.droid.args({ permissionMode: 'workspace' }).slice(-2), ['--auto', 'low']);
  assert.ok(specs.droid.args({ permissionMode: 'full', model: 'custom:model-0' }).includes('--skip-permissions-unsafe'));
  assert.equal(specs.cursor.promptVia, 'stdin'); assert.equal(specs.droid.promptVia, 'stdin');
});

test('Cursor native complete-message stream keeps process separate without duplicating terminal result', () => {
  const acc = {}, events = [], emit = (type, value) => events.push({ type, value });
  for (const item of [
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking.' }] } },
    { type: 'tool_call', subtype: 'started', call_id: 'read', tool_call: { readToolCall: { args: { path: 'README.md' } } } },
    { type: 'tool_call', subtype: 'completed', call_id: 'read', tool_call: { readToolCall: { result: { success: { content: 'Readme' } } } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Answer.' }] } },
    { type: 'result', subtype: 'success', is_error: false, result: 'Checking.Answer.' },
  ]) parsers.cursor(JSON.stringify(item), emit, acc);
  assert.deepEqual(events.filter(item => item.type === 'text').map(item => item.value), ['Checking.', 'Answer.']);
  assert.ok(events.some(item => item.type === 'activity' && item.value.phase === 'commentary' && item.value.detail === 'Checking.'));
  assert.ok(events.some(item => item.type === 'activity' && item.value.id === 'read' && item.value.status === 'done'));
  assert.equal(events.filter(item => item.type === 'usage').length, 0);
});

test('Droid accepts chunked pretty JSON final results and never exposes wrappers as model text', () => {
  const source = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Actual answer', session_id: 'private-session-id' }, null, 2);
  const events = [], acc = {}, emit = (type, value) => events.push({ type, value });
  for (let i = 0; i < source.length; i += 7) parsers.droid(source.slice(i, i + 7), emit, acc);
  assert.deepEqual(events, [{ type: 'text', value: 'Actual answer' }, { type: 'final_answer', value: true }]);
  assert.ok(!JSON.stringify(events).includes('private-session-id'));
  const failed = [];
  parsers.droid(JSON.stringify({ type: 'result', is_error: true, error: { message: 'Failed' } }), (type, value) => failed.push({ type, value }), {});
  assert.deepEqual(failed, [{ type: 'error', value: 'Failed' }]);
  parsers.droid('x'.repeat(4 * 1024 * 1024 + 1), (type, value) => failed.push({ type, value }), {});
  assert.match(failed.at(-1).value, /上限/);
});


test('ZCode uses official prompt streaming without pretending to support model or permission overrides', () => {
  const { listProfiles } = require('../src/main/cliRegistry');
  const { listModels } = require('../src/main/modelCatalog');
  const { normalizeBotProfile, normalizeAvatar } = require('../src/shared/botProfile');
  const { sourceScope } = require('../src/main/skills/skillScanner');
  assert.ok(listProfiles().some(item => item.id === 'zcode'));
  assert.deepEqual(specs.zcode.args({ permissionMode: 'full' }, null, 'literal & 中文'),
    ['--prompt', 'literal & 中文', '--output-format', 'stream-json', '--mode', 'yolo', '--no-browser']);
  assert.throws(() => specs.zcode.args({ permissionMode: 'full', model: 'unsupported' }), /原生默认模型/);
  for (const permissionMode of ['read_only', 'workspace', undefined]) assert.throws(() => specs.zcode.args({ permissionMode }), /权限/);
  assert.throws(() => normalizeBotProfile({ cliType: 'zcode', model: 'unsupported' }), /原生默认模型/);
  assert.equal(listModels('zcode').customAllowed, false);
  assert.equal(normalizeAvatar({ type: 'provider', provider: 'zcode' }).provider, 'zcode');
  assert.equal(sourceScope('/fixture/.zcode/skills/fixture').nativeCliType, 'zcode');
  assert.ok(sourceScope('/fixture/.agents/skills/fixture').nativeCliTypes.includes('zcode'));
});

test('ZCode separates streaming tools and reasoning from authoritative final and native usage', () => {
  const events = [], acc = {}, emit = (type, value) => events.push({ type, value });
  for (const item of [
    { type: 'model.streaming', payload: { kind: 'reasoning_delta', partId: 'thought', delta: 'Thinking', done: false } },
    { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'Checking.' } },
    { type: 'tool.updated', payload: { kind: 'started', toolCallId: 'read', toolName: 'Read' } },
    { type: 'tool.updated', payload: { kind: 'result', toolCallId: 'read', result: { success: true, content: 'read output' } } },
    { type: 'model.streaming', payload: { kind: 'text_delta', delta: 'Answer.' } },
    { type: 'result', response: 'Answer.', usage: { source: 'provider', inputTokens: 100, outputTokens: 10, totalTokens: 110, cacheReadTokens: 60, cacheWriteTokens: 2, reasoningTokens: 4 }, projection: { contextUsed: 80, contextWindow: 200000 } },
  ]) parsers.zcode(JSON.stringify(item), emit, acc);
  assert.equal(events.findLast(item => item.type === 'text_replace').value, 'Answer.');
  assert.ok(events.some(item => item.type === 'activity' && item.value.phase === 'commentary' && item.value.detail === 'Checking.'));
  assert.ok(events.some(item => item.type === 'activity' && item.value.id === 'read' && item.value.status === 'done'));
  assert.ok(events.some(item => item.type === 'activity' && item.value.id === 'zcode-thought-thought' && item.value.status === 'done'));
  assert.deepEqual(events.find(item => item.type === 'usage').value, { inputTokens: 100, outputTokens: 10, tokens: 110, cachedInputTokens: 60, cacheCreationInputTokens: 2, reasoningTokens: 4, cumulative: true });
  assert.deepEqual(events.find(item => item.type === 'context_usage').value, { totalTokens: 80, contextWindow: 200000, source: 'native' });
});

test('ZCode failures do not turn into final success and absent usage stays absent', () => {
  const acc = {}, events = [], emit = (type, value) => events.push({ type, value });
  parsers.zcode(JSON.stringify({ type: 'turn.failed', payload: { error: { message: 'Provider failed' } } }), emit, acc);
  parsers.zcode(JSON.stringify({ type: 'result', response: 'Failed' }), emit, acc);
  assert.ok(events.some(item => item.type === 'error' && item.value === 'Provider failed'));
  assert.ok(!events.some(item => ['final_answer', 'usage', 'context_usage'].includes(item.type)));
  events.length = 0;
  parsers.zcode(JSON.stringify({ type: 'result', response: 'Done', projection: { contextUsed: null, contextWindow: null } }), emit, {});
  assert.ok(!events.some(item => ['usage', 'context_usage'].includes(item.type)));
});


test('ZCode streams through a real isolated fixture process and stops on cancellation', async () => {
  const discovery = require('../src/main/cliDiscovery'), executable = require('../src/main/adapters/resolveExecutable');
  const adapterPath = require.resolve('../src/main/adapters/cliAdapter');
  const originalLocate = discovery.locateCliExecutable, originalResolve = executable.resolveExecutable;
  const program = `const args = process.argv.slice(1); const prompt = args[args.indexOf('--prompt') + 1];
    console.log(JSON.stringify({type:'model.streaming',payload:{kind:'text_delta',delta:prompt}}));
    if (prompt === 'cancel-fixture') setInterval(() => {}, 1000);
    else console.log(JSON.stringify({type:'result',response:prompt}));`;
  let runCliBot;
  try {
    discovery.locateCliExecutable = () => process.execPath;
    executable.resolveExecutable = () => ({ command: process.execPath, argsPrefix: ['-e', program, '--'] });
    delete require.cache[adapterPath]; runCliBot = require(adapterPath).runCliBot;
  } finally { discovery.locateCliExecutable = originalLocate; executable.resolveExecutable = originalResolve; delete require.cache[adapterPath]; }
  const run = prompt => runCliBot({ bot: { cliType: 'zcode', permissionMode: 'full' }, prompt, workspace: process.cwd(), noBytesTimeoutMs: 3000 });
  const result = await run('literal & 中文').promise;
  assert.equal(result.text, 'literal & 中文'); assert.equal(result.error, null);
  const pending = run('cancel-fixture');
  await new Promise(resolve => { const remove = pending.onEvent(type => { if (type === 'text_delta') { remove(); resolve(); } }); pending.promise.then(resolve); });
  await pending.cancel(); assert.equal((await pending.promise).aborted, true);
});
