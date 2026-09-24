'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { normalizeSelection, discover, prepare, claudeMcpMetadata } = require('../src/main/nativeCapabilities');
const { contextUsage } = require('../src/main/contextUsage');

test('native capability selections validate and deduplicate only identifiers', () => {
  assert.deepEqual(normalizeSelection(), { mode: 'inherit', mcp: [], plugins: [] });
  assert.deepEqual(normalizeSelection({ mode: 'selected', mcp: ['local', 'local'] }).mcp, ['local']);
  assert.throws(() => normalizeSelection({ mode: 'selected', plugins: ['bad\nname'] }));
});
test('MCP discovery reduces output to names and state; unknown format fails closed', () => {
  assert.deepEqual(claudeMcpMetadata('local: command with confidential-value - ✓ Connected'),
    [{ id: 'local', name: 'local', kind: 'mcp', enabled: true, status: 'ready' }]);
  assert.deepEqual(claudeMcpMetadata('No MCP servers configured.'), []);
  assert.throws(() => claudeMcpMetadata('new output format'), /格式/);
});
test('per-thread capability config controls plugin parents and standalone servers separately', async () => {
  const discovery = async () => ({ items: [
    { id: 'parent@local', kind: 'plugin', enabled: true },
    { id: 'derived', kind: 'mcp', pluginId: 'parent@local' },
    { id: 'independent', kind: 'mcp' },
  ] });
  const result = await prepare({ cliType: 'codex', nativeCapabilities: { mode: 'selected', mcp: ['independent'], plugins: [] } }, process.cwd(), { discovery });
  assert.equal(result.nativeConfig.plugins['parent@local'].enabled, false);
  assert.equal(result.nativeConfig.mcp_servers.independent.enabled, true);
  assert.equal(Object.hasOwn(result.nativeConfig.mcp_servers, 'derived'), false);
});
test('removed selections warn and preserve known disabled capabilities without blocking a reply', async () => {
  const bot = { cliType: 'codex', nativeCapabilities: { mode: 'selected', mcp: ['gone'], plugins: [] } };
  const result = await prepare(bot, process.cwd(), { discovery: async () => ({ items: [{ id: 'denied', kind: 'mcp' }] }) });
  assert.match(result.warnings.join(' '), /gone.*继续回答/);
  assert.equal(result.nativeConfig.mcp_servers.denied.enabled, false);
  assert.equal(Object.hasOwn(result.nativeConfig.mcp_servers, 'gone'), false);
});

test('unreadable inventory refreshes once; Claude can answer with all custom tools off', async () => {
  const calls = [];
  const result = await prepare({ cliType: 'claude', nativeCapabilities: { mode: 'selected' } }, process.cwd(), {
    discovery: async (_type, _cwd, options) => { calls.push(options.refresh); throw new Error('fixture missing'); },
  });
  assert.deepEqual(calls, [false, true]);
  assert.deepEqual(result.nativeArgs, ['--safe-mode', '--strict-mcp-config', '--tools', '']);
  assert.match(result.warnings[0], /无工具安全模式/);
  // Codex has no proven global disable override. Do not silently inherit a wider allowlist.
  await assert.rejects(prepare({ cliType: 'codex', nativeCapabilities: { mode: 'selected' } }, process.cwd(), {
    discovery: async () => ({ items: [], truncated: true }),
  }), /无法保证.*禁用/);
});

test('Claude selection writes only temporary invocation settings and preserves read-only deny', async () => {
  const result = await prepare({ cliType: 'claude', permissionMode: 'read_only', nativeCapabilities: { mode: 'selected', mcp: [], plugins: [] } }, process.cwd(),
    { discovery: async () => ({ items: [{ id: 'local@fixture', kind: 'plugin' }, { id: 'local', kind: 'mcp' }] }) });
  const file = result.nativeArgs[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { enabledPlugins: { 'local@fixture': false } });
  assert.equal(result.nativeArgs.includes('--disallowedTools'), false);
  result.cleanup(); assert.equal(fs.existsSync(path.dirname(file)), false);
});
test('metadata scan flags incomplete marketplaces before use', async () => {
  let closed = false;
  const data = await discover('codex', process.cwd(), { refresh: true, rpcFactory: () => ({
    initialize: async () => {}, request: async method => method === 'plugin/installed'
      ? { marketplaces: [], marketplaceLoadErrors: [{ message: 'not exposed' }] } : { data: [] },
    close: async () => { closed = true; },
  }) });
  assert.equal(data.truncated, true); assert.equal(closed, true);
});
test('context usage respects zero catchup and separates native window from billed totals', () => {
  const bot = { id: 'b1', name: 'One', cliType: 'codex' }, room = { id: 'r1', botIds: ['b1'] };
  const messages = [{ authorType: 'human', text: 'history', status: 'done' },
    { authorType: 'bot', authorId: 'b1', text: 'answer', status: 'done', usage: { inputTokens: 40000 },
      contextUsage: { inputTokens: 10000, totalTokens: 10020, contextWindow: 250000 } }];
  const report = contextUsage(room, bot, [bot], messages, 0);
  assert.equal(report.historyMessages, 0); assert.equal(report.currentTokens, 10020);
  assert.equal(report.lastInputTokens, 40000); assert.equal(report.contextWindow, 250000);
  assert.equal(contextUsage(room, bot, [bot], messages, 1).historyMessages, 1);
});

test('context estimate respects mode recipients and reports native cache fields only when supplied', () => {
  const bot = { id: 'b1', name: 'One', cliType: 'codex' }, room = { id: 'r1', botIds: ['b1'] };
  const messages = [{ authorType: 'human', text: 'restricted', status: 'done', mode: 'plan', modeTargetIds: ['b2'] },
    { authorType: 'bot', authorId: 'b1', text: 'visible', status: 'done', usage: { inputTokens: 100, cachedInputTokens: 60 } }];
  const report = contextUsage(room, bot, [bot], messages, 20);
  assert.equal(report.historyMessages, 1); assert.equal(report.cachedInputTokens, 60);
  delete messages[1].usage.cachedInputTokens;
  assert.equal(contextUsage(room, bot, [bot], messages, 20).cachedInputTokens, null);
});
