'use strict';

// Offline boundary tests: no CLI processes, disk stores, or credentials.
const assert = require('node:assert/strict');
const test = require('node:test');
const { DEFAULTS } = require('../src/shared/constants');

function fixture({ bots = 2, settings = {}, mode = 'sequential', runBot, capabilities } = {}) {
  const members = Array.from({ length: bots }, (_, i) => ({
    id: `b${i}`, name: `Bot${i}`, cliType: 'codex', enabled: true,
    permissionMode: 'read_only', cwd: '',
  }));
  const rooms = ['r1', 'r2'].map((id) => ({ id, botIds: members.map((b) => b.id),
    moderatorBotId: 'b0', routingMode: 'all', speakMode: mode }));
  const messages = { r1: [], r2: [] };
  const sessions = {};
  const config = { ...DEFAULTS, ...settings };
  const events = [];
  const calls = [];
  const store = {
    listBots: () => members, listRooms: () => rooms, getSettings: () => config,
    roomMembers: room => require('../src/shared/roomProfiles').members(room, members, config),
    getMessages: (id) => messages[id], getMessage: (id, mid) => messages[id].find((m) => m.id === mid),
    addMessage: (id, m) => messages[id].push(m),
    updateMessage: (id, mid, patch) => Object.assign(store.getMessage(id, mid), patch),
    getSessions: () => sessions, setSession: (key, value) => { sessions[key] = value; },
    getSkillsDir: () => 'unused', logCli: () => {},
    getDataPath: () => 'unused',
  };
  const substitutes = {
    '../src/main/store/persistence': store,
    '../src/main/skills/skillScanner': { listImported: () => [] },
    '../src/main/skills/skillReferences': { list: () => [] },
    '../src/main/adapters/cliAdapter': { runBot: (args) => {
      calls.push(args);
      return runBot ? runBot(args, calls.length) : complete({ sessionId: `session-${calls.length}` });
    } },
  };
  if (capabilities) substitutes['../src/main/nativeCapabilities'] = {
    normalizeSelection: require('../src/main/nativeCapabilities').normalizeSelection,
    ...capabilities,
  };
  const saved = [];
  for (const [name, exports] of Object.entries(substitutes)) {
    const id = require.resolve(name);
    saved.push([id, require.cache[id]]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }
  const moduleId = require.resolve('../src/main/orchestrator/orchestrator');
  delete require.cache[moduleId];
  const orchestrator = require(moduleId);
  for (const [id, original] of saved) {
    if (original) require.cache[id] = original;
    else delete require.cache[id];
  }
  delete require.cache[moduleId];
  orchestrator.setEmitter((e) => events.push(e));
  return { orchestrator, members, rooms, messages, sessions, config, events, calls, store };
}

function complete(result = {}) {
  return { onEvent: () => {}, cancel: async () => {}, promise: Promise.resolve({
    text: 'done', usage: { inputTokens: 2, outputTokens: 1, tokens: 3 }, ...result,
  }) };
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('actual dispatch applies history token budget but preserves current request and persona', async () => {
  const f = fixture({ bots: 1, settings: { historyTokenBudget: 15 }, runBot: () => complete({ text: 'LARGE_OLD_REPLY '.repeat(400) }) });
  f.members[0].persona = 'PERSONA_MUST_STAY';
  await f.orchestrator.handleHuman('r1', 'OLD_REQUEST');
  const current = 'CURRENT_REQUEST '.repeat(300);
  await f.orchestrator.handleHuman('r1', current);
  assert.ok(f.calls[1].prompt.includes(current));
  assert.ok(f.calls[1].prompt.includes(f.members[0].persona));
  assert.doesNotMatch(f.calls[1].prompt, /OLD_REQUEST|LARGE_OLD_REPLY/);
  assert.equal(f.messages.r1.filter(message => message.authorType === 'human').length, 2);
});

test('adapter final context survives completion and invalid token fields are explicitly estimated', async () => {
  const f = fixture({ bots: 1, runBot: () => complete({ usage: { inputTokens: -1, outputTokens: 'invalid' },
    contextUsage: { totalTokens: 150, contextWindow: 200000, source: 'native' } }) });
  await f.orchestrator.handleHuman('r1', 'hello');
  const message = f.messages.r1.findLast(item => item.authorType === 'bot');
  assert.equal(message.contextUsage.totalTokens, 150);
  assert.equal(message.usage.inputEstimated, true); assert.equal(message.usage.outputEstimated, true);
  assert.ok(message.usage.inputTokens > 0); assert.ok(message.usage.outputTokens > 0);
});

test('app-only turns receive room context without saving or resuming native sessions', async () => {
  const f = fixture({ bots: 1 });
  await f.orchestrator.handleHuman('r1', 'room one');
  await f.orchestrator.handleHuman('r2', 'room two');
  assert.equal(f.calls[1].priorSessionId, null);
  await f.orchestrator.handleHuman('r1', 'continue');
  assert.equal(f.calls[2].priorSessionId, null);
  assert.match(f.calls[2].prompt, /room one/);
  assert.doesNotMatch(f.calls[2].prompt, /room two/);
  assert.deepEqual(f.sessions, {});
  f.members[0].permissionMode = 'workspace';
  await f.orchestrator.handleHuman('r1', 'new permission');
  assert.equal(f.calls[3].priorSessionId, null);
  f.members[0].cwd = 'D:/another-project';
  await f.orchestrator.handleHuman('r1', 'new directory');
  assert.equal(f.calls[4].priorSessionId, null);
});

test('returning member receives messages missed during other human turns', async () => {
  const f = fixture();
  await f.orchestrator.handleHuman('r1', '@Bot0 first');
  await f.orchestrator.handleHuman('r1', '@Bot1 missed-detail');
  await f.orchestrator.handleHuman('r1', '@Bot0 return');
  assert.match(f.calls[2].prompt, /missed-detail/);
});

test('failed call usage counts while call-count guard still stops subsequent dispatch', async () => {
  const f = fixture({ settings: { maxCliCallsPerRun: 1, tokenBudgetPerRun: 3 },
    runBot: () => complete({ error: 'failed', text: '@Bot1 relay' }) });
  await f.orchestrator.handleHuman('r1', 'start');
  assert.equal(f.calls.length, 1);
  const last = f.events.filter((e) => e.kind === 'run_update').at(-1).run;
  assert.equal(last.tokens, 3);
  assert.equal(last.status, 'budget');
  assert.ok(f.messages.r1.some((m) => m.text.includes('未发言：Bot1')));
});

test('failed partial output never triggers relay and thrown adapter errors remain isolated', async () => {
  const f = fixture({ runBot: (args) => {
    if (args.bot.id === 'b0') throw new Error('cannot spawn');
    return complete({ text: '@Bot0 accidental', error: 'failed' });
  } });
  await f.orchestrator.handleHuman('r1', 'start');
  assert.equal(f.calls.length, 2);
  assert.equal(f.messages.r1.filter((m) => m.authorType === 'bot' && m.status === 'error').length, 2);
});

test('zero reported usage is preserved rather than replaced with estimates', async () => {
  const f = fixture({ bots: 1, runBot: () => complete({ usage: { inputTokens: 0, outputTokens: 0, tokens: 0 } }) });
  await f.orchestrator.handleHuman('r1', 'start');
  assert.equal(f.messages.r1.find((m) => m.authorType === 'bot').usage.tokens, 0);
});

test('stop holds room busy until turn settles; duplicate send and retry are rejected', async () => {
  const turn = deferred();
  const f = fixture({ bots: 1, runBot: () => ({ promise: turn.promise,
    onEvent: () => {}, cancel: async () => {} }) });
  const running = f.orchestrator.handleHuman('r1', 'start');
  const stopping = f.orchestrator.stop('r1');
  await assert.rejects(f.orchestrator.handleHuman('r1', 'duplicate'), /仍在运行/);
  await assert.rejects(f.orchestrator.retry('r1', 'missing'), /仍在运行/);
  assert.equal(f.orchestrator.getActiveRuns()[0].status, 'stopping');
  turn.resolve({ text: 'partial', aborted: true, usage: { tokens: 3 } });
  await Promise.all([running, stopping]);
  assert.equal(f.orchestrator.isBusy(), false);
  assert.equal(f.messages.r1.find((m) => m.authorType === 'bot').status, 'aborted');
  assert.equal(f.events.filter((e) => e.kind === 'run_update').at(-1).run.status, 'stopped');
  const human = f.messages.r1.find(message => message.authorType === 'human');
  assert.equal(human.roundRun.status, 'stopped');
  assert.ok(human.roundRun.endedAt >= human.roundRun.startedAt);
  assert.equal(f.events.filter(event => event.kind === 'run_update').at(-1).run.roundId, human.id);
});

test('a completed user round persists measured start/end and replay keeps its original timing', async () => {
  const f = fixture({ bots: 1 });
  await f.orchestrator.handleHuman('r1', 'first');
  const first = f.messages.r1.find(message => message.authorType === 'human'), original = { ...first.roundRun };
  assert.equal(first.roundRun.status, 'done');
  assert.ok(Number.isFinite(first.roundRun.startedAt));
  assert.ok(first.roundRun.endedAt >= first.roundRun.startedAt);
  await f.orchestrator.handleHuman('r1', 'second');
  assert.deepEqual(first.roundRun, original);
});

test('timing boundary disk failures reject visibly and never leave the room permanently busy', async () => {
  const f = fixture({ bots: 1 });
  const update = f.store.updateMessage;
  f.store.updateMessage = (roomId, id, patch) => { if (patch.roundRun) throw new Error('synthetic disk failure'); return update(roomId, id, patch); };
  await assert.rejects(f.orchestrator.handleHuman('r1', 'first'), /synthetic disk failure/);
  assert.equal(f.orchestrator.isBusy('r1'), false);
  assert.equal(f.calls.length, 0);
  f.store.updateMessage = update;
  await f.orchestrator.handleHuman('r1', 'can run again');
  assert.equal(f.orchestrator.isBusy('r1'), false);
});

test('parallel dispatch respects concurrency and total call caps', async () => {
  const turns = [];
  const f = fixture({ bots: 5, mode: 'parallel', settings: { maxCliCallsPerRun: 4 },
    runBot: () => { const d = deferred(); turns.push(d); return {
      promise: d.promise, onEvent: () => {}, cancel: async () => {},
    }; } });
  const running = f.orchestrator.handleHuman('r1', 'start');
  assert.equal(f.calls.length, 3);
  turns[0].resolve({ text: 'done', usage: { tokens: 1 } });
  await new Promise(setImmediate);
  assert.equal(f.calls.length, 4);
  for (const t of turns) t.resolve({ text: 'done', usage: { tokens: 1 } });
  await running;
  assert.equal(f.calls.length, 4);
});

test('retry is a new run, retries only eligible messages, and relays success', async () => {
  const f = fixture({ runBot: (args, n) => complete(n === 1 ? { error: 'failed' }
    : { text: n === 2 ? '@Bot1 continue' : 'done' }) });
  await f.orchestrator.handleHuman('r1', '@Bot0 start');
  const failed = f.messages.r1.find((m) => m.authorType === 'bot');
  await f.orchestrator.retry('r1', failed.id);
  assert.equal(f.calls.length, 3);
  assert.ok(failed.supersededBy);
  await assert.rejects(f.orchestrator.retry('r1', failed.id), /只能重试/);
  assert.equal(f.orchestrator.isBusy(), false);
});

test('disabled explicit target does not fall back to moderator or join relay', async () => {
  const f = fixture({ runBot: () => complete({ text: '@Bot1 please' }) });
  f.members[1].enabled = false;
  await f.orchestrator.handleHuman('r1', '@Bot1 start');
  assert.equal(f.calls.length, 0);
  await f.orchestrator.handleHuman('r1', '@all start');
  assert.equal(f.calls.length, 1);
});

test('per-edge cap ends a bot ping-pong while preserving successful turns', async () => {
  const f = fixture({ settings: { maxAutoTurns: 100 }, runBot: ({ bot }) =>
    complete({ text: bot.id === 'b0' ? '@Bot1 continue' : '@Bot0 continue' }) });
  await f.orchestrator.handleHuman('r1', '@Bot0 start');
  assert.equal(f.calls.length, 5);
  assert.ok(f.messages.r1.some((m) => m.text.includes('超过单边上限 2 次')));
});

test('stopAll drains all rooms and repeated stop calls are safe', async () => {
  const f = fixture({ bots: 1, runBot: () => {
    const d = deferred();
    return { promise: d.promise, onEvent: () => {}, cancel: async () =>
      d.resolve({ text: 'partial', aborted: true, usage: { tokens: 1 } }) };
  } });
  const one = f.orchestrator.handleHuman('r1', 'one');
  const two = f.orchestrator.handleHuman('r2', 'two');
  assert.equal(f.orchestrator.getActiveRuns().length, 2);
  await Promise.all([f.orchestrator.stopAll(), f.orchestrator.stop('r1'), one, two]);
  assert.deepEqual(f.orchestrator.getActiveRuns(), []);
});

test('new estimates ignore legacy global custom prices, retain CLI report mode, and support Agent prices', async () => {
  for (const mode of ['custom', 'cli', 'none']) {
    const f = fixture({ bots: 1, settings: { costMode: mode }, runBot: () => complete({ usage: {
      inputTokens: 2, outputTokens: 1, tokens: 3, cliCost: 0.2,
      ...(mode === 'custom' ? { apiCost: 0.1 } : {}),
    } }) });
    await f.orchestrator.handleHuman('r1', 'start');
    const usage = f.messages.r1.find((m) => m.authorType === 'bot').usage;
    assert.equal(usage.cost, mode === 'cli' ? 0.2 : null);
    assert.equal(usage.estimated, true);
  }
  const f = fixture({ bots: 1, settings: { costMode: 'none' } });
  f.members[0].model = 'fixture-model';
  f.config.agentPricing = { codex: [{ enabled: true, model: 'fixture-model', inputPerMillion: 2, outputPerMillion: 4 }] };
  await f.orchestrator.handleHuman('r1', 'start');
  assert.equal(f.messages.r1.find((m) => m.authorType === 'bot').usage.cost, 8 / 1e6);
});

test('Claude persona remains present in stdin transcript', () => {
  const { buildPrompt } = require('../src/main/orchestrator/transcript');
  const bot = { id: 'b', name: 'Bot', cliType: 'claude', persona: 'careful reviewer & collaborator' };
  assert.match(buildPrompt(bot, [], [bot], {}), /【你的角色设定】careful reviewer & collaborator/);
});

test('legacy token and cost limits do not stop priced rooms', async () => {
  const f = fixture({ settings: { costMode: 'none', costBudgetPerRun: 0.001, tokenBudgetPerRun: 1 } });
  f.members[0].model = 'fixture';
  f.config.agentPricing = { codex: [{ enabled: true, model: 'fixture', inputPerMillion: 1000, outputPerMillion: 0 }] };
  await f.orchestrator.handleHuman('r1', 'start');
  assert.equal(f.calls.length, 2);
  assert.equal(f.events.filter((e) => e.kind === 'run_update').at(-1).run.status, 'done');
});

test('legacy zero cost limit does not block token-only or explicitly priced rooms', async () => {
  const f = fixture({ bots: 1, settings: { costMode: 'none', costBudgetPerRun: 0 } });
  await f.orchestrator.handleHuman('r1', 'start');
  assert.equal(f.calls.length, 1);
  f.members[0].model = 'fixture';
  f.config.agentPricing = { codex: [{ enabled: true, model: 'fixture', inputPerMillion: 1, outputPerMillion: 1 }] };
  await f.orchestrator.handleHuman('r1', 'priced');
  assert.equal(f.calls.length, 2);
  assert.equal(f.events.filter((e) => e.kind === 'run_update').at(-1).run.status, 'done');
});

test('unregistered slash names do not load retired application copies', async () => {
  const f = fixture({ bots: 1 });
  assert.deepEqual(f.orchestrator.skillBlocksForText('/old-copy'), []);
  await f.orchestrator.handleHuman('r1', '/old-copy literal text');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].prompt, /old-copy literal text/);
});

test('changing a bot model preserves application context without native sessions', async () => {
  const f = fixture({ bots: 1 });
  await f.orchestrator.handleHuman('r1', 'default turn');
  f.members[0].model = 'provider/chosen-model';
  await f.orchestrator.handleHuman('r1', 'new model turn');
  assert.equal(f.calls[1].bot.model, 'provider/chosen-model');
  assert.equal(f.calls[1].priorSessionId, null);
  await f.orchestrator.handleHuman('r1', 'continue chosen model');
  assert.equal(f.calls[2].priorSessionId, null);
  assert.match(f.calls[2].prompt, /default turn/);
});


test('native history uncertainty allows configured members and keeps application records', async () => {
  const f = fixture({ bots: 1 });
  f.members[0].cliType = 'kimi';
  await f.orchestrator.handleHuman('r1', 'private room context');
  assert.equal(f.calls.length, 1);
  assert.equal(f.messages.r1.at(-1).status, 'done');
  assert.ok(f.messages.r1.some(message => message.text === 'private room context'));
  assert.deepEqual(f.sessions, {});
});

test('app-only mode ignores preexisting native session cursors and replays bounded room history', async () => {
  const f = fixture({ bots: 1, settings: { catchupMessages: 2 } });
  await f.orchestrator.handleHuman('r1', 'older-context');
  const prior = f.messages.r1.at(-1);
  f.sessions[JSON.stringify(['r1', 'b0'])] = { id: 'legacy-native-id', lastMessageId: prior.id,
    config: f.orchestrator.sessionFor('r1', f.members[0]).config };
  await f.orchestrator.handleHuman('r1', 'current-context');
  assert.equal(f.calls[1].priorSessionId, null);
  assert.match(f.calls[1].prompt, /older-context/);
  assert.match(f.calls[1].prompt, /current-context/);
  assert.equal(f.sessions[JSON.stringify(['r1', 'b0'])].id, 'legacy-native-id');
});

test('disabled Agent is rejected before capability metadata or model execution', async () => {
  let preparations = 0;
  const f = fixture({ bots: 1, settings: { enabledCliIds: [] }, capabilities: {
    prepare: async () => { preparations++; throw new Error('metadata must not run'); },
  } });
  f.rooms[0].memberCapabilities = {};
  f.rooms[0].memberCapabilities.b0 = { mode: 'selected', mcp: [], plugins: [] };
  await f.orchestrator.handleHuman('r1', 'activation boundary');
  assert.equal(preparations, 0);
  assert.equal(f.calls.length, 0);
  const message = f.messages.r1.find(item => item.authorType === 'bot');
  assert.equal(message.status, 'error');
  assert.match(message.error, /启用/);
  assert.equal(message.usage.tokens, 0);
  assert.equal(f.orchestrator.isBusy(), false);
});

test('extension cleanup failure preserves a completed reply and its accounted usage', async () => {
  let cleaned = 0;
  const f = fixture({ bots: 1, capabilities: {
    prepare: async () => ({ nativeArgs: [], nativeConfig: {}, cleanup() {
      cleaned++; throw new Error('fixture private cleanup detail');
    } }),
  } });
  f.rooms[0].memberCapabilities = {};
  f.rooms[0].memberCapabilities.b0 = { mode: 'selected', mcp: [], plugins: [] };
  await f.orchestrator.handleHuman('r1', 'cleanup boundary');
  const message = f.messages.r1.find(item => item.authorType === 'bot');
  assert.equal(cleaned, 1);
  assert.equal(message.status, 'done');
  assert.equal(message.text, 'done');
  assert.equal(message.usage.inputTokens, 2);
  assert.equal(message.usage.outputTokens, 1);
  assert.equal(message.usage.tokens, 3);
  assert.equal(f.events.filter(event => event.kind === 'run_update').at(-1).run.tokens, 3);
  assert.ok(f.messages.r1.some(item => item.authorType === 'system' && /清理/.test(item.text)));
  assert.doesNotMatch(JSON.stringify(f.messages), /fixture private cleanup detail/);
  assert.equal(f.orchestrator.isBusy(), false);
});

test('stop aborts selected capability preparation before any model can start', { timeout: 1500 }, async () => {
  const started = deferred();
  let signal;
  const f = fixture({ bots: 1, capabilities: {
    prepare: (_bot, _cwd, options) => new Promise((_resolve, reject) => {
      signal = options.signal;
      signal.addEventListener('abort', () => reject(new Error('fixture preparation cancelled')), { once: true });
      started.resolve();
    }),
  } });
  f.rooms[0].memberCapabilities = {};
  f.rooms[0].memberCapabilities.b0 = { mode: 'selected', mcp: [], plugins: [] };
  const running = f.orchestrator.handleHuman('r1', 'prepare then stop');
  await started.promise;
  assert.equal(f.orchestrator.isBusy('r1'), true);
  assert.equal(f.calls.length, 0);
  await Promise.all([running, f.orchestrator.stop('r1'), f.orchestrator.stop('r1')]);
  assert.equal(signal.aborted, true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.orchestrator.isBusy(), false);
  const message = f.messages.r1.find(item => item.authorType === 'bot');
  assert.equal(message.status, 'aborted');
  assert.equal(message.usage.tokens, 0);
  assert.equal(f.events.filter(event => event.kind === 'run_update').at(-1).run.status, 'stopped');
});

test('late capability completion after stop is cleaned without starting a model', { timeout: 1500 }, async () => {
  const prepared = deferred();
  let signal, cleaned = 0;
  const f = fixture({ bots: 1, capabilities: {
    prepare: (_bot, _cwd, options) => { signal = options.signal; return prepared.promise; },
  } });
  f.rooms[0].memberCapabilities = {};
  f.rooms[0].memberCapabilities.b0 = { mode: 'selected', mcp: [], plugins: [] };
  const running = f.orchestrator.handleHuman('r1', 'late prepare');
  const stopping = f.orchestrator.stop('r1');
  assert.equal(signal.aborted, true);
  assert.equal(f.orchestrator.isBusy('r1'), true);
  prepared.resolve({ nativeArgs: [], nativeConfig: {}, cleanup() { cleaned++; } });
  await Promise.all([running, stopping]);
  assert.equal(cleaned, 1);
  assert.equal(f.calls.length, 0);
  assert.equal(f.messages.r1.find(item => item.authorType === 'bot').status, 'aborted');
  assert.equal(f.orchestrator.isBusy(), false);
});

test('pending native questions survive a renderer snapshot, route to their room and clear at completion', { timeout: 1500 }, async () => {
  const turn = deferred();
  const received = [];
  let emit;
  const f = fixture({ bots: 1, runBot: () => ({
    promise: turn.promise, onEvent: (listener) => { emit = listener; }, cancel: async () => {},
    respondInput: (id, answers) => { received.push({ id, answers }); emit('input_resolved', { requestId: id }); return true; },
  }) });
  const running = f.orchestrator.handleHuman('r1', 'native input');
  const message = f.messages.r1.find(item => item.authorType === 'bot');
  emit('input_request', { requestId: 'question_1', questions: [{ id: 'choice', question: 'Which fixture?' }] });
  const pending = f.orchestrator.getPendingInputs();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].roomId, 'r1');
  assert.equal(pending[0].messageId, message.id);
  assert.equal(pending[0].botId, 'b0');
  assert.throws(() => f.orchestrator.respondInput({ roomId: 'r2', messageId: message.id, requestId: 'question_1', answers: {} }), /已结束/);
  const answers = { choice: { answers: ['fixture A'] } };
  assert.equal(f.orchestrator.respondInput({ roomId: 'r1', messageId: message.id, requestId: 'question_1', answers }), true);
  assert.deepEqual(received, [{ id: 'question_1', answers }]);
  assert.deepEqual(f.orchestrator.getPendingInputs(), []);
  assert.doesNotMatch(JSON.stringify(f.messages), /fixture A/);
  emit('input_request', { requestId: 'question_2', questions: [{ id: 'other', question: 'Another fixture?' }] });
  turn.resolve({ text: 'done', usage: { inputTokens: 2, outputTokens: 1, tokens: 3 } });
  await running;
  assert.deepEqual(f.orchestrator.getPendingInputs(), []);
  assert.throws(() => f.orchestrator.respondInput({ roomId: 'r1', messageId: message.id, requestId: 'question_2', answers: {} }), /已结束/);
});


test('per-message plan routes to moderator and researcher even in host mode, without mutating bot defaults', async () => {
  const f = fixture({ bots: 3, mode: 'host' });
  f.members[1].role = '研究者';
  await f.orchestrator.handleHuman('r1', 'scoped-plan-secret', { mode: 'plan' });
  assert.deepEqual(f.calls.map(call => call.bot.id), ['b0', 'b1']);
  assert.ok(f.calls.every(call => call.bot.executionMode === 'plan'));
  assert.ok(f.members.every(bot => bot.executionMode === undefined));
  assert.deepEqual(f.messages.r1[0].modeTargetIds, ['b0', 'b1']);
  await f.orchestrator.handleHuman('r1', '@Bot2 ordinary', { mode: 'chat' });
  assert.doesNotMatch(f.calls.at(-1).prompt, /scoped-plan-secret/);
  assert.equal(f.calls.at(-1).bot.executionMode, 'chat');
});

test('explicit mode mentions win; unsupported native modes reject before saving or dispatch', async () => {
  const f = fixture({ bots: 3 });
  f.members[1].cliType = 'kimi';
  await assert.rejects(f.orchestrator.handleHuman('r1', '@Bot1 plan', { mode: 'plan' }), /Bot1.*不支持/);
  assert.equal(f.messages.r1.length, 0); assert.equal(f.calls.length, 0);
  await f.orchestrator.handleHuman('r1', '@Bot2 explicit', { mode: 'goal' });
  assert.deepEqual(f.calls.map(call => call.bot.id), ['b2']);
  assert.equal(f.calls[0].bot.executionMode, 'goal');
  await assert.rejects(f.orchestrator.handleHuman('r1', 'invalid', { mode: 'invented' }), /模式无效/);
});

test('researcher cannot summon an outside member; moderator can and grants round context', async () => {
  for (const author of ['b0', 'b1']) {
    const f = fixture({ bots: 3, runBot: (args) => complete({ text: args.bot.id === author ? '@Bot2 join' : 'done' }) });
    f.members[1].role = '研究员';
    await f.orchestrator.handleHuman('r1', 'private-plan-token', { mode: 'plan' });
    assert.equal(f.calls.some(call => call.bot.id === 'b2'), author === 'b0');
    if (author === 'b0') {
      assert.match(f.calls.find(call => call.bot.id === 'b2').prompt, /private-plan-token/);
      assert.ok(f.messages.r1.filter(item => item.mode === 'plan').every(item => item.modeTargetIds.includes('b2')));
    }
  }
});

test('retry and regenerate preserve per-message mode and audience, while successful normal chat can override legacy plan', async () => {
  const f = fixture({ bots: 2, runBot: (args, index) => complete(index === 1 ? { error: 'fail' } : {}) });
  await f.orchestrator.handleHuman('r1', '@Bot1 target', { mode: 'plan' });
  const failed = f.messages.r1.find(item => item.status === 'error');
  await f.orchestrator.retry('r1', failed.id);
  assert.equal(f.calls[1].bot.executionMode, 'plan');
  assert.equal(f.calls[1].bot.id, 'b1');
  const human = f.messages.r1[0]; f.messages.r1.splice(1);
  await f.orchestrator.continueHuman('r1', human.id);
  assert.equal(f.calls[2].bot.executionMode, 'plan');
  f.members[0].executionMode = 'plan';
  await f.orchestrator.handleHuman('r1', '@Bot0 normal', { mode: 'chat' });
  assert.equal(f.calls[3].bot.executionMode, 'chat');
});


test('stop persists the final confirmed paused goal even though streaming events are suppressed', async () => {
  const pending = deferred();
  const f = fixture({ bots: 1, runBot: () => ({ onEvent() {}, promise: pending.promise,
    async cancel() { pending.resolve({ text: 'partial', aborted: true, goal: { status: 'paused', tokensUsed: 3, timeUsedSeconds: 1 } }); },
  }) });
  const running = f.orchestrator.handleHuman('r1', 'goal', { mode: 'goal' });
  await f.orchestrator.stop('r1'); await running;
  const reply = f.messages.r1.find(message => message.authorType === 'bot');
  assert.equal(reply.status, 'aborted'); assert.equal(reply.goal.status, 'paused');
  assert.ok(f.events.some(event => event.kind === 'message_update' && event.patch?.goal?.status === 'paused'));
});

test('Claude goal receives its current human objective separately from room history and preserves that round on retry', async () => {
  const f = fixture({ bots: 1, runBot: (_args, index) => complete(index === 2 ? { error: 'synthetic first attempt failure' } : {}) });
  f.members[0].cliType = 'claude';
  const prior = 'Earlier room context '.repeat(220);
  const objective = 'Finish the current synthetic goal';
  await f.orchestrator.handleHuman('r1', prior);
  await f.orchestrator.handleHuman('r1', objective, { mode: 'goal' });
  const failed = f.messages.r1.find(message => message.authorType === 'bot' && message.status === 'error');
  assert.equal(f.calls[1].bot.executionMode, 'goal');
  assert.equal(f.calls[1].goalObjective, objective);
  assert.match(f.calls[1].prompt, /Earlier room context/);
  assert.ok(f.calls[1].prompt.length > 4000);
  assert.notEqual(f.calls[1].goalObjective, f.calls[1].prompt);
  await f.orchestrator.handleHuman('r1', 'A later ordinary conversation', { mode: 'chat' });
  await f.orchestrator.retry('r1', failed.id);
  assert.equal(f.calls.at(-1).goalObjective, objective);
  assert.equal(f.calls.at(-1).bot.executionMode, 'goal');
  assert.equal(f.calls[2].goalObjective, undefined);
});

test('successful parent completion preserves an unconfirmed child running state instead of fabricating completion', async () => {
  const f = fixture({ bots: 1, runBot: () => ({ ...complete(), onEvent(emit) {
    emit('activity', { id: 'native-child', kind: 'subagent', name: 'Synthetic child', status: 'running',
      subagent: { agentId: 'child-thread', parentAgentId: 'parent-thread', cliType: 'codex', task: 'Synthetic task', output: 'Still working' } });
    emit('activity', { id: 'ordinary-tool', kind: 'tool', name: 'Tool', status: 'running' });
  } }) });
  await f.orchestrator.handleHuman('r1', 'Synthetic parent task');
  const reply = f.messages.r1.find(message => message.authorType === 'bot');
  assert.equal(reply.status, 'done');
  const child = reply.activities.find(activity => activity.id === 'native-child');
  assert.equal(child.status, 'running');
  assert.equal(child.subagent.parentAgentId, 'parent-thread');
  assert.equal(child.subagent.output, 'Still working');
  assert.equal(reply.activities.find(activity => activity.id === 'ordinary-tool').status, 'done');
  const finalActivities = f.events.filter(event => event.kind === 'message_update' && event.id === reply.id && event.patch?.activities).at(-1).patch.activities;
  assert.equal(finalActivities.find(activity => activity.id === 'native-child').status, 'running');
});


test('advisory extension warning is visible before native reply without failing the turn', async () => {
  const f = fixture({ bots: 1, capabilities: {
    prepare: async () => ({ nativeArgs: [], nativeConfig: {}, warnings: ['fixture MCP unavailable, continuing'], cleanup() {} }),
  } });
  f.rooms[0].memberCapabilities = {};
  f.rooms[0].memberCapabilities.b0 = { mode: 'selected', mcp: ['missing'], plugins: [] };
  await f.orchestrator.handleHuman('r1', 'answer despite advisory');
  assert.equal(f.calls.length, 1);
  const warning = f.messages.r1.find(item => item.authorType === 'system' && item.text.includes('fixture MCP'));
  assert.ok(warning);
  assert.equal(f.messages.r1.find(item => item.authorType === 'bot').status, 'done');
});


test('dispatch consumes Agent defaults and isolated per-room capability and side profile overrides', async () => {
  const choices = [];
  const f = fixture({ bots: 1, settings: { agentCapabilities: { codex: { mode: 'selected', mcp: ['agent'], plugins: [] } } },
    capabilities: { prepare: async bot => { choices.push(bot.nativeCapabilities.mcp); return { cleanup() {}, nativeArgs: [] }; } } });
  f.rooms[0].memberCapabilities = { b0: { mode: 'selected', mcp: ['room-one'], plugins: [] } };
  await f.orchestrator.handleHuman('r1', 'one');
  await f.orchestrator.handleHuman('r2', 'two');
  assert.deepEqual(choices, [['room-one'], ['agent']]);
  f.rooms[0].memberProfiles = { b0: { ...f.members[0], name: 'Side member', persona: 'SIDE_SNAPSHOT', model: 'side-model', nativeCapabilities: { mode: 'selected', mcp: ['snapshot'], plugins: [] } } };
  f.rooms[0].memberCapabilities = {};
  f.members[0].persona = 'GLOBAL_LATER';
  await f.orchestrator.handleHuman('r1', 'side');
  assert.equal(f.calls[2].bot.model, 'side-model');
  assert.ok(f.calls[2].prompt.includes('SIDE_SNAPSHOT'));
  assert.ok(!f.calls[2].prompt.includes('GLOBAL_LATER'));
  assert.deepEqual(choices[2], ['snapshot']);
});
