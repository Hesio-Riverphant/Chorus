'use strict';

// Offline protocol-shaped fixtures only. No model CLI or native user data.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { PARSERS } = require('../src/main/adapters/cliSpecs');
const { codexTokenUsage } = require('../src/main/adapters/tokenUsage');
const { contextUsage } = require('../src/main/contextUsage');
const { selectTranscript, buildPrompt } = require('../src/main/orchestrator/transcript');
const { estimateTokens } = require('../src/shared/util');
const { runBot } = require('../src/main/adapters/cliAdapter');

function parser(cli) {
  const acc = {}, events = [];
  return { send(value) { PARSERS[cli](JSON.stringify(value), (type, payload) => events.push({ type, payload }), acc); },
    last(type) { return events.findLast(event => event.type === type)?.payload; }, events };
}
const bot = { id: 'b1', name: 'One', cliType: 'claude', persona: 'Keep constraints.', role: 'reviewer' };
const room = { id: 'r1', botIds: [bot.id] };
const human = (id, text, extra = {}) => ({ id, authorType: 'human', text, status: 'done', ...extra });

test('resuming an interrupted relay retains the delegating member constraints with zero ordinary history', () => {
  const messages = [human('task', 'Plan release'),
    { id: 'delegation', roundId: 'task', authorType: 'bot', authorId: 'other', status: 'done', text: '@One fix Linux permissions only; leave API unchanged' },
    { id: 'failed', roundId: 'task', authorType: 'bot', authorId: bot.id, status: 'error', error: 'Provider interrupted', text: 'One permission changed' },
    human('resume', '@One continue', { audienceBotIds: [bot.id] })];
  const selection = selectTranscript(messages, bot, [bot], { roundId: 'resume', catchupMessages: 0 });
  assert.deepEqual(selection.messages.map(m => m.id), ['task', 'delegation', 'failed', 'resume']);
  assert.match(buildPrompt(bot, selection.messages, [bot], room), /leave API unchanged/);
});

test('Claude ordinary stream usage merges partial snapshots and separates latest request from call totals', () => {
  const p = parser('claude');
  for (const id of ['msg_a', 'msg_b']) {
    p.send({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: {
      id, type: 'message', role: 'assistant', model: 'claude-test', usage: {
        input_tokens: 30, output_tokens: 1, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 } } } });
    p.send({ type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 20 } } });
    p.send({ type: 'assistant', message: { id, model: 'claude-test', content: [], usage: {
      input_tokens: 30, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 900 } } });
  }
  p.send({ type: 'result', subtype: 'success', usage: { input_tokens: 60, output_tokens: 40,
    cache_creation_input_tokens: 200, cache_read_input_tokens: 1800 }, modelUsage: {
    'claude-test': { inputTokens: 60, outputTokens: 40, cacheReadInputTokens: 1800, cacheCreationInputTokens: 200, contextWindow: 200000 } } });
  assert.equal(p.last('usage').inputTokens, 2060);
  assert.equal(p.last('usage').cachedInputTokens, 1800);
  assert.equal(p.last('context_usage').inputTokens, 1030);
  assert.equal(p.last('context_usage').cachedInputTokens, 900);
  assert.equal(p.last('context_usage').totalTokens, 1050);
  assert.equal(p.last('context_usage').contextWindow, 200000);
});

test('failed recovery includes public progress once without reasoning or tool payloads', () => {
  const progress = 'Migration already applied';
  for (const status of ['error', 'aborted']) {
    const failed = { id: 'failed', roundId: 'task', authorType: 'bot', authorId: bot.id, status,
      text: progress, error: 'Connection ended', activities: [
        { phase: 'commentary', detail: progress, order: 1 },
        { kind: 'reasoning', detail: 'PRIVATE_REASONING' },
        { kind: 'tool', detail: 'RAW_TOOL_PAYLOAD' },
        { phase: 'commentary', detail: 'Database checked', order: 2 },
      ] };
    const selection = selectTranscript([human('task', 'Run migration'), failed, human('resume', '@One continue')], bot, [bot],
      { roundId: 'resume', catchupMessages: 0 });
    const prompt = buildPrompt(bot, selection.messages, [bot], room);
    assert.equal(prompt.split(progress).length - 1, 1);
    assert.match(prompt, /Database checked/);
    assert.doesNotMatch(prompt, /PRIVATE_REASONING|RAW_TOOL_PAYLOAD/);
    failed.text = ''; delete failed.error;
    assert.ok(selectTranscript([human('task', 'Run migration'), failed, human('resume', '@One continue')], bot, [bot],
      { roundId: 'resume', catchupMessages: 0 }).messages.some(message => message.id === 'failed'));
  }
});

test('failed attempt recovery respects durable recipients after rename and skips successful superseded output', () => {
  const renamed = { ...bot, name: 'Renamed' }, other = { id: 'other', name: 'Other' };
  const messages = [human('task', '@One private task', { audienceBotIds: [bot.id] }),
    { id: 'successful', roundId: 'task', authorType: 'bot', authorId: bot.id, status: 'done', text: 'STALE_SUCCESS', supersededBy: 'old', audienceBotIds: [bot.id] },
    { id: 'old', roundId: 'task', authorType: 'bot', authorId: bot.id, status: 'aborted', text: 'OLD_PARTIAL', error: 'OLD_ERROR', supersedes: 'successful', supersededBy: 'latest', audienceBotIds: [bot.id] },
    { id: 'latest', roundId: 'task', authorType: 'bot', authorId: bot.id, status: 'error', text: 'NEW_PARTIAL', error: 'NEW_ERROR', supersedes: 'old', audienceBotIds: [bot.id] },
    human('resume', '@Renamed continue', { audienceBotIds: [bot.id] })];
  const own = selectTranscript(messages, renamed, [renamed, other], { roundId: 'resume', catchupMessages: 0 });
  assert.deepEqual(own.messages.map(message => message.id), ['task', 'old', 'latest', 'resume']);
  assert.equal(selectTranscript(messages, other, [renamed, other], { roundId: 'resume' }).messages.length, 0);
  messages[1].status = 'error'; messages[1].audienceBotIds = [other.id];
  assert.ok(!selectTranscript(messages, renamed, [renamed, other], { roundId: 'resume' }).messages.some(message => message.id === 'successful'));
  messages[3].status = 'done';
  const completed = selectTranscript(messages, renamed, [renamed, other], { roundId: 'resume' });
  assert.ok(!completed.messages.some(message => message.id === 'old'));
});

test('successful normal history retains its prompt and token cost without public progress replay', () => {
  const reply = { id: 'reply', roundId: 'task', authorType: 'bot', authorId: bot.id, status: 'done', text: 'Final result' };
  const messages = [human('task', 'Work'), reply, human('next', 'Next task')];
  const baseline = selectTranscript(messages, bot, [bot], { roundId: 'next' });
  const prompt = buildPrompt(bot, baseline.messages, [bot], room);
  reply.activities = [{ phase: 'commentary', detail: 'Earlier public progress' }];
  const actual = selectTranscript(messages, bot, [bot], { roundId: 'next' });
  assert.equal(actual.historyTokenEstimate, baseline.historyTokenEstimate);
  assert.equal(buildPrompt(bot, actual.messages, [bot], room), prompt);
});

test('Claude does not guess window from a different model or result-only cumulative usage', () => {
  const p = parser('claude');
  p.send({ type: 'result', usage: { input_tokens: 50000, output_tokens: 3000 }, modelUsage: { test: { contextWindow: 200000 } } });
  assert.equal(p.last('context_usage'), undefined);
  p.send({ type: 'assistant', message: { id: 'one', model: 'other', usage: { input_tokens: 100, output_tokens: 20 } } });
  p.send({ type: 'result', modelUsage: { test: { contextWindow: 200000 } } });
  assert.equal(p.last('context_usage').totalTokens, 120);
  assert.equal(p.last('context_usage').contextWindow, null);
  assert.equal(p.last('context_usage').cachedInputTokens, undefined);
});

test('forwarded Claude child usage cannot overwrite parent context', () => {
  const p = parser('claude');
  p.send({ type: 'assistant', message: { id: 'parent', usage: { input_tokens: 200, output_tokens: 10 } } });
  p.send({ type: 'assistant', parent_tool_use_id: 'task-1', message: { id: 'child', content: [], usage: { input_tokens: 90000, output_tokens: 400 } } });
  assert.equal(p.last('context_usage').totalTokens, 210);
});

test('missing or malformed native counters remain unknown, while measured zero remains zero', () => {
  const incomplete = codexTokenUsage({ total: {}, last: {}, modelContextWindow: -1 });
  assert.equal(incomplete.usage.inputTokens, undefined);
  assert.equal(incomplete.contextUsage.totalTokens, null);
  assert.equal(incomplete.contextUsage.contextWindow, null);
  const valid = codexTokenUsage({ total: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    last: { inputTokens: 0, outputTokens: 0 }, modelContextWindow: 0 });
  assert.equal(valid.usage.tokens, 0); assert.equal(valid.contextUsage.totalTokens, 0);
  const p = parser('claude'); p.send({ type: 'result' });
  assert.equal(p.last('usage').inputTokens, undefined);
  p.send({ type: 'assistant', message: { id: 'malformed', usage: { input_tokens: -1, output_tokens: '15' } } });
  p.send({ type: 'result' });
  assert.equal(p.last('usage').inputTokens, undefined); assert.equal(p.last('usage').outputTokens, undefined);
  assert.equal(p.last('context_usage').totalTokens, null);
  const report = contextUsage(room, bot, [bot], [{ authorId: bot.id, authorType: 'bot', status: 'done',
    usage: { inputTokens: -1, cachedInputTokens: '42' }, contextUsage: { totalTokens: -5, contextWindow: 0 } }]);
  assert.equal(report.currentTokens, null); assert.equal(report.contextWindow, null);
  assert.equal(report.cachedInputTokens, null); assert.equal(report.lastInputTokens, null);
});

test('Codex exec totals never become current context, and empty completion never fabricates usage', () => {
  const p = parser('codex');
  p.send({ type: 'turn.completed', usage: { input_tokens: 75000, cached_input_tokens: 60000, output_tokens: 100 } });
  assert.equal(p.last('usage').inputTokens, 75000);
  assert.equal(p.last('context_usage'), undefined);
  const empty = parser('codex'); empty.send({ type: 'turn.completed' });
  assert.equal(empty.last('usage'), undefined);
});

test('preview and real dispatch share filtering, history limits and exact app prompt estimate', () => {
  const prior = [human('old', 'older'), human('private', 'SECRET', { mode: 'goal', modeTargetIds: ['other'] }),
    human('failed', 'error', { status: 'error' }), human('recent', 'most recent')];
  const preview = contextUsage(room, bot, [bot], prior, 1, 100);
  const selected = selectTranscript([...prior, human('now', 'CURRENT')], bot, [bot],
    { roundId: 'now', catchupMessages: 1, historyTokenBudget: 100 });
  assert.deepEqual(selected.messages.map(message => message.id), ['recent', 'now']);
  assert.equal(preview.historyMessages, 1);
  assert.equal(preview.nextInputEstimate, estimateTokens(buildPrompt(bot, selected.messages.slice(0, -1), [bot], room, [])));
});

test('history budget preserves whole current input and relay messages; zero catchup keeps current round', () => {
  const messages = [human('old', 'older'), human('large', 'large history '.repeat(300)), human('now', 'CURRENT '.repeat(400)),
    { id: 'relay', authorId: bot.id, authorType: 'bot', text: 'RELAY '.repeat(200), status: 'done', roundId: 'now' }];
  for (const catchupMessages of [0, 20]) {
    const selected = selectTranscript(messages, bot, [bot], { roundId: 'now', catchupMessages, historyTokenBudget: 25 });
    assert.deepEqual(selected.messages.map(message => message.id), ['now', 'relay']);
    const prompt = buildPrompt(bot, selected.messages, [bot], room, []);
    assert.ok(prompt.includes(messages[2].text)); assert.ok(prompt.includes(messages[3].text));
    assert.ok(prompt.includes(bot.persona)); assert.ok(prompt.includes('@全体'));
    assert.equal(selected.omittedHistoryMessages, 2);
  }
  assert.throws(() => selectTranscript(messages, bot, [bot], { roundId: 'missing' }), /本轮消息不存在/);
});

test('history estimates and latest usage exclude superseded replies and preserve running native context', () => {
  const messages = [human('old', 'previous', { authorType: 'bot', authorId: bot.id, supersededBy: 'new', contextUsage: { totalTokens: 999 } }),
    human('new', '', { authorType: 'bot', authorId: bot.id, status: 'streaming', contextUsage: { totalTokens: 200, contextWindow: 1000 } })];
  const report = contextUsage(room, bot, [bot], messages);
  assert.equal(report.currentTokens, 200); assert.equal(report.historyMessages, 0);
  assert.equal(report.currentScope, 'last_model_request');
});

function chatFixture(options = {}) {
  let listener;
  const calls = [], events = [];
  let closed = false, factoryOptions;
  const rpc = {
    onMessage(fn) { listener = fn; }, async initialize() {},
    async request(method, params) {
      calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-chat', ephemeral: true, path: null } };
      if (method === 'turn/start') return { turn: { id: 'turn-chat' } };
      return {};
    }, async close() { closed = true; },
  };
  const handle = runBot({ bot: { cliType: 'codex', executionMode: 'chat', permissionMode: 'workspace', model: 'model-test', reasoningEffort: 'high' },
    workspace: process.cwd(), prompt: 'Current input', priorSessionId: 'must-not-resume', noBytesTimeoutMs: 500,
    cliSettings: { enabledCliIds: ['codex'] }, rpcFactory(config) { factoryOptions = config; return rpc; }, ...options });
  handle.onEvent((type, payload) => events.push({ type, payload }));
  return { handle, calls, events, ready: () => new Promise(resolve => setImmediate(resolve)),
    send(method, params) { listener({ method, params: { threadId: 'thread-chat', turnId: 'turn-chat', ...params } }); },
    get closed() { return closed; }, get factoryOptions() { return factoryOptions; } };
}

test('normal Codex chat uses native temporary RPC with cwd, model, effort and inherited capabilities', async () => {
  const f = chatFixture(); await f.ready();
  assert.equal(f.factoryOptions.cwd, process.cwd());
  assert.deepEqual(f.factoryOptions.cliSettings.enabledCliIds, ['codex']);
  assert.deepEqual(f.calls[0], { method: 'thread/start', params: { cwd: process.cwd(), ephemeral: true, dynamicTools: [require('../src/main/adapters/questionTool').questionTool],
    approvalPolicy: 'on-request', sandbox: 'workspace-write', model: 'model-test', allowProviderModelFallback: false } });
  assert.deepEqual(f.calls[1].params, { threadId: 'thread-chat', input: [{ type: 'text', text: 'Current input' }], effort: 'high' });
  f.send('thread/tokenUsage/updated', { tokenUsage: { total: { inputTokens: 80000, outputTokens: 120, totalTokens: 80120, cachedInputTokens: 60000 },
    last: { inputTokens: 20000, outputTokens: 40, totalTokens: 20040, cachedInputTokens: 15000 }, modelContextWindow: 256000 } });
  f.send('turn/completed', { turn: { id: 'turn-chat', status: 'completed' } });
  const result = await f.handle.promise;
  assert.equal(result.usage.inputTokens, 80000); assert.equal(result.contextUsage.totalTokens, 20040);
  assert.equal(result.contextUsage.cachedInputTokens, 15000); assert.equal(result.contextUsage.contextWindow, 256000);
  assert.equal(result.sessionId, null); assert.equal(f.closed, true);
});

test('normal Codex chat cancellation and no-output timeout close the native process', async () => {
  const f = chatFixture(); await f.ready(); await f.handle.cancel();
  assert.ok(f.calls.some(call => call.method === 'turn/interrupt'));
  assert.equal((await f.handle.promise).aborted, true); assert.equal(f.closed, true);
  const timed = chatFixture({ noBytesTimeoutMs: 20 });
  assert.match((await timed.handle.promise).error, /timeout|超时/i); assert.equal(timed.closed, true);
});
