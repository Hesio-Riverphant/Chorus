'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { calculateCost } = require('../src/main/orchestrator/pricing');
const { normalizeAgentPricing, DEFAULT_PERIODS } = require('../src/shared/agentPricing');
const bot = { cliType: 'codex', model: 'model' };
const rates = { enabled: true, model: 'model', inputPerMillion: 10, outputPerMillion: 20, cachedInputPerMillion: 1 };
const config = { codex: [{ ...rates, timeZone: 'Asia/Shanghai', peakPeriods: DEFAULT_PERIODS,
  offPeak: { enabled: true, inputPerMillion: 5, outputPerMillion: 10, cachedInputPerMillion: 0.5 } }] };
const usage = { inputTokens: 1000000, outputTokens: 200000, cachedInputTokens: 400000, cacheCreationInputTokens: 100000 };
const cost = (settings, at, u = usage, member = bot) => calculateCost(member, u, u.inputTokens ?? 1000000, u.outputTokens ?? 200000, 'none', Date.parse(at || '2026-09-24T01:00:00Z'), settings);

test('Agent prices apply to all matching members and only their Agent model', () => {
  const a = cost(config); assert.equal(a.cost, 10.4); assert.equal(a.costSource, 'agent_pricing');
  assert.equal(cost(config, null, usage, { ...bot, id: 'second' }).cost, a.cost);
  assert.equal(cost(config, null, usage, { ...bot, cliType: 'kimi' }).cost, null);
  assert.equal(cost(config, null, usage, { ...bot, model: 'other' }).cost, null);
});
test('weekly peak windows use timezone, weekday, lunch gap and exact half-open boundaries', () => {
  for (const [at, tier] of [
    ['2026-09-24T00:59:59Z', 'offPeak'], ['2026-09-24T01:00:00Z', 'peak'],
    ['2026-09-24T04:00:00Z', 'offPeak'], ['2026-09-24T06:00:00Z', 'peak'],
    ['2026-09-24T10:00:00Z', 'offPeak'], ['2026-09-26T02:00:00Z', 'offPeak'],
  ]) { const result = cost(config, at); assert.equal(result.pricing.tier, tier); assert.equal(result.cost, tier === 'peak' ? 10.4 : 5.2); }
});
test('overnight peak belongs to previous selected weekday and supports independent schedules', () => {
  const settings = { codex: [{ ...config.codex[0], peakPeriods: [{ days: [5], start: '22:00', end: '06:00' }] }] };
  assert.equal(cost(settings, '2026-09-25T16:00:00Z').pricing.tier, 'peak');
  assert.equal(cost(settings, '2026-09-25T22:00:00Z').pricing.tier, 'offPeak');
});
test('unknown or inconsistent usage never fabricates a cached discount or a cost', () => {
  assert.equal(cost(config, null, { ...usage, cachedInputTokens: undefined }).cost, null);
  assert.equal(cost(config, null, { ...usage, cachedInputTokens: 1000001 }).cost, null);
  assert.equal(cost(config, null, { ...usage, inputTokens: undefined }).cost, null);
});
test('single tariff accepts blank cache rate and explicit zero, all non-hit input uses miss rate', () => {
  assert.equal(cost({ codex: [{ ...rates, cachedInputPerMillion: null }] }, null, { ...usage, cachedInputTokens: undefined }).cost, 14);
  assert.equal(cost({ codex: [{ ...rates, cachedInputPerMillion: 0 }] }, null, { ...usage, cachedInputTokens: 1000000, outputTokens: 0 }).cost, 0);
});
test('settings normalization rejects invalid and duplicate tariffs', () => {
  assert.deepEqual(normalizeAgentPricing(config), config);
  for (const tariff of [{ ...rates, inputPerMillion: -1 }, { ...config.codex[0], timeZone: 'bad/zone' },
    { ...config.codex[0], peakPeriods: [{ days: [7], start: '09:00', end: '12:00' }] }]) assert.throws(() => normalizeAgentPricing({ codex: [tariff] }));
  assert.throws(() => normalizeAgentPricing({ codex: [rates, rates] }), /重复/);
});
