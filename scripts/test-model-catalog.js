'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listModels } = require('../src/main/modelCatalog');
const officialIds = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];

function assertOfficialFallback(result) {
  assert.deepEqual(result.models.filter((m) => m.source === 'candidate').map((m) => m.id), officialIds);
  assert.ok(result.models.every((m) => m.source !== 'codex-cache'));
  assert.ok(result.models.every((m) => !/候选|Candidate/.test(m.label)));
  assert.match(result.notice, /测试连接/);
  assert.match(result.notice, /不代表当前提供商已授权/);
}

function fixture(t, content) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-models-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const dir = path.join(homeDir, '.codex');
  fs.mkdirSync(dir);
  const file = path.join(dir, 'models_cache.json');
  if (content !== undefined) fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return { homeDir, env: {}, file };
}

test('Codex uses visible metadata IDs, deduplicates and isolates saved CLI models', (t) => {
  const opts = fixture(t, { models: [
    { slug: 'model-a', display_name: 'Model A', visibility: 'list', arbitrary: 'do not expose' },
    { slug: 'model-a', display_name: 'Duplicate', visibility: 'list' },
    { slug: 'hidden', visibility: 'hide' },
    { slug: 'unknown-visibility', visibility: 'future-value' },
    { slug: 'bad id', visibility: 'list' },
    { id: 'wrong-schema', visibility: 'list' }, null,
  ] });
  const result = listModels('codex', { ...opts, bots: [
    { cliType: 'codex', model: 'model-a' },
    { cliType: 'codex', model: 'saved-custom' },
    { cliType: 'claude', model: 'wrong-cli' },
  ] });
  assert.deepEqual(result.models.filter(model => model.source !== 'candidate'), [
    { id: 'model-a', label: 'Model A', source: 'codex-cache' },
    { id: 'saved-custom', label: 'saved-custom', source: 'saved-bot' },
  ]);
  assert.match(result.notice, /测试连接/);
  assert.ok(!JSON.stringify(result).includes('do not expose'));
});

test('missing Codex cache returns official candidates, retains saved models and explains the gap', (t) => {
  const result = listModels('codex', { ...fixture(t), bots: [{ cliType: 'codex', model: 'custom' }] });
  assertOfficialFallback(result);
  assert.deepEqual(result.models.filter((m) => m.source === 'saved-bot').map((m) => m.id), ['custom']);
  assert.match(result.notice, /未找到/);
});

test('corrupt or invalid-schema metadata fails closed without exposing file contents', (t) => {
  for (const content of ['{ fixture-private-marker', null, [], { models: {} }]) {
    const result = listModels('codex', fixture(t, content));
    assertOfficialFallback(result);
    assert.match(result.notice, /格式无效/);
    assert.ok(!result.notice.includes('fixture-private-marker'));
  }
});

test('oversize cache and excessive model count are rejected', (t) => {
  for (const content of [' '.repeat(2 * 1024 * 1024 + 1), { models: Array.from({ length: 513 }, (_, i) => ({ slug: `m-${i}`, visibility: 'list' })) }]) {
    const result = listModels('codex', fixture(t, content));
    assertOfficialFallback(result);
    assert.match(result.notice, /上限/);
  }
});

test('CODEX_HOME metadata overrides the default home directory', (t) => {
  const fallback = fixture(t, { models: [{ slug: 'fallback', visibility: 'list' }] });
  const custom = fixture(t, { models: [{ slug: 'custom-home', visibility: 'list' }] });
  const result = listModels('codex', { ...fallback, env: { CODEX_HOME: path.dirname(custom.file) } });
  assert.deepEqual(result.models.filter(m => m.source === 'codex-cache').map((m) => m.id), ['custom-home']);
  assert.ok(result.models.some(m => m.id === 'gpt-6-luna' && m.source === 'candidate'));
});

test('invalid and network cache directories are rejected without reading the default cache', (t) => {
  const opts = fixture(t, { models: [{ slug: 'fallback', visibility: 'list' }] });
  for (const CODEX_HOME of ['relative-path', '\\\\example.invalid\\share', 12]) {
    const result = listModels('codex', { ...opts, env: { CODEX_HOME } });
    assertOfficialFallback(result);
    assert.match(result.notice, /目录无效/);
  }
});

test('Claude aliases reflect locally verified help and saved models remain available', () => {
  const result = listModels('claude', { bots: [
    { cliType: 'claude', model: 'sonnet' },
    { cliType: 'claude', model: 'haiku' },
    { cliType: 'claude', model: 'sonnet[1m]' },
    { cliType: 'codex', model: 'wrong-cli' },
  ] });
  assert.deepEqual(result.models.filter((m) => m.source === 'claude-alias').map((m) => m.id), ['fable', 'opus', 'sonnet', 'haiku']);
  assert.equal(result.models.filter((m) => m.id === 'sonnet').length, 1);
  assert.equal(result.models.find((m) => m.id === 'haiku').source, 'claude-alias');
  assert.ok(result.models.some((m) => m.id === 'sonnet[1m]'));
  assert.ok(!result.models.some((m) => m.id === 'wrong-cli'));
  assert.match(result.notice, /测试连接/);
  assert.match(result.notice, /当前账号/);
});

test('Kimi returns only valid saved models and explains unavailable enumeration', () => {
  const result = listModels('kimi', { bots: [null, {},
    { cliType: 'kimi', model: '' }, { cliType: 'kimi', model: '--flag' },
    { cliType: 'kimi', model: 'a\nb' }, { cliType: 'kimi', model: 'x'.repeat(201) },
    { cliType: 'kimi', model: 'kimi-custom' }, { cliType: 'kimi', model: 'kimi-custom' },
    { cliType: 'claude', model: 'opus' },
  ] });
  assert.deepEqual(result.models, [{ id: 'kimi-custom', label: 'kimi-custom', source: 'saved-bot' }]);
  assert.match(result.notice, /完整模型 ID/);
  assert.deepEqual(listModels('kimi').models, []);
});

test('output is bounded and malformed bot input cannot break listing', (t) => {
  const result = listModels('codex', fixture(t, { models: Array.from({ length: 129 }, (_, i) => ({ slug: `m-${i}`, visibility: 'list' })) }));
  assert.equal(result.models.length, 128);
  assert.match(result.notice, /上限/);
  assert.deepEqual(listModels('kimi', { bots: {} }).models, []);
  assert.throws(() => listModels('unknown'), /CLI/);
});

test('empty or hidden-only cache uses official candidates instead of hidden metadata', (t) => {
  for (const models of [[], [{ slug: 'hidden', visibility: 'hide' }], [{ slug: 'no-visibility' }]]) {
    const result = listModels('codex', fixture(t, { models }));
    assertOfficialFallback(result);
    assert.match(result.notice, /没有有效的可见模型/);
  }
});

test('invalid display labels fall back to the model ID without returning control characters', (t) => {
  const result = listModels('codex', fixture(t, { models: [
    { slug: 'control-label', display_name: 'bad\nlabel', visibility: 'list' },
    { slug: 'object-label', display_name: {}, visibility: 'list' },
  ] }));
  assert.deepEqual(result.models.filter(m => m.source === 'codex-cache').map((m) => m.label), ['control-label', 'object-label']);
});

test('Codex public metadata supplies per-model reasoning and context limits without other fields', (t) => {
  const result = listModels('codex', fixture(t, { models: [{ slug: 'future-model', visibility: 'list',
    supported_reasoning_levels: [{ effort: 'low', description: 'unused' }, { effort: 'ultra' }, { effort: 'high;command' }],
    context_window: 400000, private: 'not-public' }] }));
  assert.deepEqual(result.models[0].reasoningLevels, ['low', 'ultra']);
  assert.equal(result.models[0].contextWindow, 400000);
  assert.ok(!JSON.stringify(result).includes('not-public'));
  assert.equal(require('../src/shared/reasoning').levelsFor('codex', 'future-model', result.models).join(','), 'low,ultra');
});

test('Claude offers Haiku with a family name and gives concrete custom-ID guidance', () => {
  const result = listModels('claude');
  assert.equal(result.models.find(model => model.id === 'haiku').label, 'Claude Haiku');
  assert.match(result.customHint, /claude-fable-5/);
  assert.ok(!/CLI 别名|官方文档候选/.test(result.notice));
  assert.deepEqual(require('../src/shared/reasoning').levelsFor('claude', 'haiku'), []);
});

test('removing a custom candidate hides the suggestion without changing saved member models', () => {
  const bots = [{ cliType: 'kimi', model: 'invalid-custom' }];
  const result = listModels('kimi', { bots, settings: { hiddenModelCandidates: [{ cliType: 'kimi', model: 'invalid-custom' }] } });
  assert.ok(!result.models.some(model => model.id === 'invalid-custom'));
  assert.equal(bots[0].model, 'invalid-custom');
});
