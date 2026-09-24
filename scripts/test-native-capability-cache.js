'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { NativeCapabilityCache } = require('../src/main/nativeCapabilityCache');
const { configureStorage, discover, prepare, claudeMcpMetadata } = require('../src/main/nativeCapabilities');

function directory(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-inventory-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function transport(calls, { disabled = false, fail = false, partial = false } = {}) {
  return () => ({
    initialize: async () => { calls.push('initialize'); },
    request: async method => {
      calls.push(method);
      if (fail) throw new Error('synthetic failure');
      return method === 'plugin/installed' ? { marketplaces: [{ plugins: [
        { id: 'fixture@local', name: 'Fixture', installed: true, enabled: !disabled, secretField: 'discard me' },
      ] }], marketplaceLoadErrors: partial ? [{}] : [] }
        : { data: [{ name: 'fixture_mcp', tools: { echo: {} } }] };
    }, close: async () => { calls.push('close'); },
  });
}

test('inventory persists only display metadata and survives restart and caller mutation', t => {
  const data = directory(t), cwd = path.join(data, 'workspace');
  const cache = new NativeCapabilityCache(data);
  cache.set('codex', cwd, { cliType: 'codex', scannedAt: 1234, items: [{ id: 'fixture', kind: 'mcp', name: 'Fixture', enabled: true,
    status: 'ready', tools: { echo: { description: 'discard' } }, command: 'discard', env: { VALUE: 'discard' }, url: 'discard', headers: { value: 'discard' } }] });
  const contents = fs.readFileSync(path.join(data, 'native-capabilities.json'), 'utf8');
  assert.equal(contents.includes('discard'), false);
  const afterRestart = new NativeCapabilityCache(data);
  const result = afterRestart.get('codex', cwd); result.items[0].enabled = false;
  assert.equal(afterRestart.get('codex', cwd).items[0].enabled, true);
  assert.equal(afterRestart.get('claude', cwd), null);
  assert.equal(afterRestart.get('codex', path.join(cwd, 'another')), null);
});

test('cached metadata has no automatic expiry and explicit update changes the inventory', async t => {
  const data = directory(t), calls = [];
  configureStorage(data);
  await discover('codex', data, { rpcFactory: transport(calls) });
  const firstCalls = calls.length;
  await discover('codex', data, { rpcFactory: transport(calls) });
  assert.equal(calls.length, firstCalls);
  const updated = await discover('codex', data, { refresh: true, rpcFactory: transport(calls, { disabled: true }) });
  assert.equal(updated.items.find(item => item.kind === 'plugin').enabled, false);
  assert.ok(calls.length > firstCalls);
});

test('failed or partial refresh retains the last usable inventory on disk', async t => {
  const data = directory(t);
  configureStorage(data);
  const original = await discover('codex', data, { rpcFactory: transport([]) });
  const file = path.join(data, 'native-capabilities.json'), before = fs.readFileSync(file, 'utf8');
  for (const options of [{ fail: true }, { partial: true }]) {
    const result = await discover('codex', data, { refresh: true, rpcFactory: transport([], options) });
    assert.ok(result.refreshError);
    assert.equal(result.scannedAt, original.scannedAt);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('run preparation reads the inventory without invoking discovery transports', async t => {
  const data = directory(t);
  configureStorage(data);
  await assert.rejects(prepare({ cliType: 'codex', nativeCapabilities: { mode: 'selected', plugins: [], mcp: [] } }, data,
    { discovery: async () => { throw new Error('fixture missing'); } }), /设置.*更新/);
  await discover('codex', data, { rpcFactory: transport([]) });
  const prepared = await prepare({ cliType: 'codex', nativeCapabilities: { mode: 'selected', plugins: ['fixture@local'], mcp: [] } }, data);
  assert.equal(prepared.nativeConfig.plugins['fixture@local'].enabled, true);
  assert.equal(prepared.nativeConfig.mcp_servers.fixture_mcp.enabled, false);
});

test('simultaneous first reads share one scan and inventory cache cannot cross directories', async t => {
  const data = directory(t), calls = [];
  configureStorage(data);
  const results = await Promise.all([discover('codex', data, { rpcFactory: transport(calls) }), discover('codex', data, { rpcFactory: transport(calls) })]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(calls.filter(call => call === 'initialize').length, 1);
  await assert.rejects(discover('codex', path.join(data, 'different'), { scanIfMissing: false }), /设置.*更新/);
});

test('Claude disabled MCP warns and continues without pretending native enablement', async t => {
  const item = claudeMcpMetadata('fixture: test - Disabled')[0];
  assert.equal(item.enableSupported, false);
  const prepared = await prepare({ cliType: 'claude', nativeCapabilities: { mode: 'selected', mcp: ['fixture'], plugins: [] } }, directory(t),
    { discovery: async () => ({ items: [item] }) });
  assert.match(prepared.warnings[0], /Claude Code.*禁用/);
  assert.match(prepared.warnings[0], /mcp enable fixture/);
  assert.ok(prepared.nativeArgs.includes('mcp__fixture__*'));
  prepared.cleanup();
});

test('corrupt inventory is preserved until explicit update and never triggers an automatic native scan', async t => {
  const data = directory(t), file = path.join(data, 'native-capabilities.json'), calls = [];
  fs.writeFileSync(file, 'invalid fixture');
  configureStorage(data);
  await assert.rejects(discover('codex', data, { rpcFactory: transport(calls) }), /无法读取/);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), 'invalid fixture');
  await discover('codex', data, { refresh: true, rpcFactory: transport(calls) });
  assert.equal(new NativeCapabilityCache(data).get('codex', data).items.length, 2);
});

test('cancelled manual update keeps the committed inventory', async t => {
  const data = directory(t), controller = new AbortController();
  configureStorage(data);
  const previous = await discover('codex', data, { rpcFactory: transport([]) });
  await assert.rejects(discover('codex', data, { refresh: true, signal: controller.signal, rpcFactory: () => ({
    initialize: async () => { controller.abort(); }, request: async () => assert.fail('request after cancellation'), close: async () => {},
  }) }), { name: 'AbortError' });
  assert.deepEqual((await discover('codex', data)).items, previous.items);
});
