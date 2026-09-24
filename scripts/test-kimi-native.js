'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const cp = require('node:child_process');
const { PARSERS, SPECS } = require('../src/main/adapters/cliSpecs');
const calls = [];
const modelId = 'provider/kimi-k2.6';
let fixture;
const reset = () => { fixture = { providers: { provider: { type: 'kimi', apiKey: 'fixture-private-value', baseUrl: 'https://example.invalid/v1' } },
  models: { [modelId]: { provider: 'provider', model: 'kimi-k2.6', maxContextSize: 262144, private: 'fixture-private-value' } } }; };
reset();
const originalLoad = Module._load, originalExec = cp.execFile;
cp.execFile = (command, args, options, callback) => {
  calls.push({ command, args, options });
  queueMicrotask(() => callback(null, args.includes('--version') ? '0.28.1\n' : JSON.stringify(fixture), ''));
};
Module._load = function (name, ...args) {
  if (name === './cliDiscovery') return { locateCliExecutable: () => 'fixture-kimi' };
  if (name === './adapters/resolveExecutable') return { resolveExecutable: command => ({ command, argsPrefix: [] }) };
  return originalLoad.call(this, name, ...args);
};
let kimi;
try { kimi = require('../src/main/kimiNative'); }
finally { cp.execFile = originalExec; Module._load = originalLoad; }

test('native Kimi model discovery exports model metadata only and resolves unique native aliases', async () => {
  reset();
  const models = await kimi.listKimiModels();
  assert.deepEqual(models, [{ id: modelId, label: modelId, nativeModel: 'kimi-k2.6', source: 'kimi-native', reasoningLevels: [], nativeCliVersion: '0.28.1', contextWindow: 262144 }]);
  assert.ok(!JSON.stringify(models).includes('fixture-private-value'));
  assert.equal(await kimi.resolveKimiModel('kimi-k2.6'), modelId);
  assert.equal(await kimi.resolveKimiModel(modelId), modelId);
  const providerCall = calls.find(call => call.args[0] === 'provider');
  assert.deepEqual(providerCall.args, ['provider', 'list', '--json']);
  assert.equal(providerCall.options.windowsHide, true);
  assert.equal(providerCall.options.shell, false);
  assert.equal(providerCall.options.timeout, 8000);
});

test('unknown and ambiguous native model names are rejected without guessing an account', async () => {
  reset();
  await assert.rejects(kimi.resolveKimiModel('missing'), /未配置/);
  fixture.models['other/kimi-k2.6'] = { ...fixture.models[modelId] };
  await assert.rejects(kimi.resolveKimiModel('kimi-k2.6'), /多个/);
});

test('Kimi provider probe makes one bounded tiny real-protocol request without Agent tools or credential output', async () => {
  reset(); let requestCount = 0;
  const result = await kimi.probeKimi('kimi-k2.6', {}, undefined, async (url, options) => {
    requestCount += 1;
    assert.equal(String(url), 'https://example.invalid/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer fixture-private-value');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'kimi-k2.6');
    assert.equal(body.tools, undefined);
    assert.equal(body.max_completion_tokens, 32);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    return Response.json({ choices: [{ message: { role: 'assistant', content: 'OK' } }] });
  });
  assert.equal(requestCount, 1);
  assert.equal(result.ok, true);
  assert.equal(result.detail, '模型连接成功');
  assert.equal(result.transport, 'provider-api');
  assert.ok(!JSON.stringify(result).includes('fixture-private-value'));
});

test('failed, empty and oversized model responses never become a successful connection', async () => {
  reset();
  const unauthorized = await kimi.probeKimi(modelId, {}, undefined, async () => Response.json({ error: 'fixture-private-value' }, { status: 401 }));
  assert.equal(unauthorized.ok, false); assert.match(unauthorized.detail, /身份验证/);
  assert.ok(!JSON.stringify(unauthorized).includes('fixture-private-value'));
  const empty = await kimi.probeKimi(modelId, {}, undefined, async () => Response.json({ choices: [] }));
  assert.equal(empty.ok, false);
  await assert.rejects(kimi.probeKimi(modelId, {}, undefined, async () => new Response('x'.repeat(65537))), /上限/);
});

test('unsupported OAuth provider and native metadata failures do not fall back to an unsafe Agent probe', async () => {
  reset(); fixture.providers.provider.oauth = { storage: 'fixture-private-value' };
  let requests = 0;
  await assert.rejects(kimi.probeKimi(modelId, {}, undefined, async () => { requests += 1; }), /暂不支持/);
  assert.equal(requests, 0);
  fixture = { providers: {}, models: null, private: 'fixture-private-value' };
  await assert.rejects(kimi.listKimiModels(), error => !error.message.includes('fixture-private-value') && /格式/.test(error.message));
});

test('Kimi native headless refuses implicit auto permissions and omits the conflicting --auto flag', () => {
  for (const permissionMode of ['workspace', 'read_only', undefined]) {
    assert.throws(() => SPECS.kimi.args({ permissionMode }, null, 'hello'), /选择全权限/);
  }
  const args = SPECS.kimi.args({ permissionMode: 'full', model: modelId }, null, 'hello');
  assert.ok(!args.includes('--auto'));
  assert.deepEqual(args.slice(0, 4), ['-p', 'hello', '--output-format', 'stream-json']);
});

test('installed Kimi role/content protocol preserves public process, tool output and final answer without fake usage', () => {
  const events = [], acc = {};
  const emit = (type, value) => events.push({ type, value });
  for (const event of [
    { role: 'assistant', content: 'Checking the file.', tool_calls: [{ id: 'tool-1', function: { name: 'Shell', arguments: '{"command":"git status"}' } }] },
    { role: 'tool', tool_call_id: 'tool-1', content: 'clean' },
    { role: 'assistant', content: 'The tree is clean.' },
    { role: 'meta', type: 'session.resume_hint', content: 'do not display session hint' },
  ]) PARSERS.kimi(JSON.stringify(event), emit, acc);
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => event.value), ['The tree is clean.']);
  assert.ok(events.some(event => event.type === 'activity' && event.value.phase === 'commentary'));
  assert.ok(events.some(event => event.type === 'activity' && event.value.id === 'tool-1' && event.value.status === 'done' && /clean/.test(event.value.detail)));
  assert.equal(events.filter(event => event.type === 'usage' || event.type === 'context_usage').length, 0);
});

test('documented CodeBuddy launcher passes prompt literally and scopes permissions', () => {
  const args = SPECS.codebuddy.args({ model: 'm', permissionMode: 'read_only' }, null, 'hello & literal');
  assert.ok(args.includes('hello & literal'));
  assert.ok(args.includes('--no-session-persistence'));
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
  assert.equal(args[args.indexOf('--tools') + 1], 'Read,Grep,Glob');
});
