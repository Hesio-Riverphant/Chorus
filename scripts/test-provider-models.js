'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { discoverClaudeModels } = require('../src/main/providerModels');
function fixture(t, config = {}) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-catalog-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(homeDir, '.claude'));
  fs.writeFileSync(path.join(homeDir, '.claude', 'settings.json'), JSON.stringify(config));
  return { homeDir, env: {} };
}
test('Claude reads its configured provider model endpoint with bounded metadata-only output', async t => {
  const opts = fixture(t, { env: { ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic', ANTHROPIC_AUTH_TOKEN: 'test-fixture-key' } });
  let requests = 0;
  const result = await discoverClaudeModels({ ...opts, fetchImpl: async (url, options) => {
    requests += 1; assert.equal(String(url), 'https://example.invalid/anthropic/v1/models');
    assert.equal(options.method, 'GET'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, 'Bearer test-fixture-key');
    return Response.json({ data: [{ id: 'model-a', display_name: 'Model A', private: 'test-fixture-key' }, { id: 'bad id' }] });
  } });
  assert.equal(requests, 1);
  assert.deepEqual(result, [{ id: 'model-a', label: 'Model A', source: 'claude-provider' }]);
});
test('Claude catalog handles pagination and does not duplicate a v1 suffix', async t => {
  const opts = fixture(t); let calls = 0;
  const result = await discoverClaudeModels({ ...opts, env: { ANTHROPIC_BASE_URL: 'https://example.invalid/v1', ANTHROPIC_API_KEY: 'test-fixture' },
    fetchImpl: async url => {
      calls += 1;
      assert.equal(url.pathname, '/v1/models');
      if (calls === 1) return Response.json({ data: [{ id: 'a' }], has_more: true, last_id: 'a' });
      assert.equal(url.searchParams.get('after_id'), 'a');
      return Response.json({ data: [{ id: 'a' }, { id: 'b' }], has_more: false });
    } });
  assert.deepEqual(result.map(item => item.id), ['a', 'b']);
});
test('catalog errors never expose provider HTTP bodies or credentials', async t => {
  const opts = { ...fixture(t), env: { ANTHROPIC_API_KEY: 'test-private-marker' } };
  await assert.rejects(discoverClaudeModels({ ...opts, fetchImpl: async () => Response.json({ secret: 'test-private-marker' }, { status: 401 }) }), error => /401/.test(error.message) && !error.message.includes('test-private-marker'));
  await assert.rejects(discoverClaudeModels({ ...opts, fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1)) }), /上限/);
  await assert.rejects(discoverClaudeModels(fixture(t)), /未提供模型目录/);
});

test('a gateway 404 can use only its same-origin shared model catalog', async t => {
  const opts = { ...fixture(t), env: { ANTHROPIC_BASE_URL: 'https://example.invalid/anthropic', ANTHROPIC_AUTH_TOKEN: 'test-key' } };
  const paths = [];
  const result = await discoverClaudeModels({ ...opts, fetchImpl: async url => {
    assert.equal(url.origin, 'https://example.invalid'); paths.push(url.pathname);
    return paths.length === 1 ? Response.json({}, { status: 404 }) : Response.json({ data: [{ id: 'actual-model' }] });
  } });
  assert.deepEqual(paths, ['/anthropic/v1/models', '/v1/models']);
  assert.equal(result[0].id, 'actual-model');
});
