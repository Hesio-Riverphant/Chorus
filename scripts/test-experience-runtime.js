'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { PARSERS } = require('../src/main/adapters/cliSpecs');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { calculateCost } = require('../src/main/orchestrator/pricing');
const { upsertActivity } = require('../src/main/adapters/activities');
const { buildPrompt } = require('../src/main/orchestrator/transcript');

function parse(cli, lines) {
  const acc = {};
  const events = [];
  for (const line of lines) PARSERS[cli](JSON.stringify(line), (type, payload) => events.push({ type, payload }), acc);
  return events;
}

test('Codex command activity is distinct from final text and redacts credentials', () => {
  const events = parse('codex', [
    { type: 'item.started', item: { id: 'cmd-1', type: 'command_execution', command: 'curl -H "Authorization: Bearer fixture-secret" https://example.test', status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'cmd-1', type: 'command_execution', command: 'curl', aggregated_output: 'token=fixture-secret @Bot2', exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Final answer' } },
  ]);
  const activities = events.filter((e) => e.type === 'activity').map((e) => e.payload);
  assert.equal(activities.length, 2);
  assert.equal(activities[0].kind, 'command');
  assert.equal(activities[1].status, 'error');
  assert.ok(!JSON.stringify(activities).includes('fixture-secret'));
  assert.deepEqual(events.filter((e) => e.type === 'text').map((e) => e.payload), ['Final answer']);
});

test('Claude correlates tool start and result without emitting tool content as text', () => {
  const events = parse('claude', [
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo ok', api_key: 'fixture-secret' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'done @Bot2' }] } },
  ]);
  const activities = events.filter((e) => e.type === 'activity').map((e) => e.payload);
  assert.ok(activities.length >= 2);
  assert.ok(activities.every((a) => a.id === 't1'));
  assert.equal(activities.at(-1).status, 'done');
  assert.match(activities.at(-1).detail, /echo ok/);
  assert.match(activities.at(-1).detail, /done @Bot2/);
  assert.equal(events.filter((e) => e.type === 'text').length, 0);
  assert.ok(!JSON.stringify(activities).includes('fixture-secret'));
});

test('only publicly returned reasoning becomes a separate bounded activity', () => {
  const events = parse('codex', [{ type: 'item.completed', item: {
    id: 'r1', type: 'reasoning', text: 'Public summary '.repeat(1000),
  } }]);
  const activity = events.find((e) => e.type === 'activity');
  assert.ok(activity);
  assert.equal(activity.payload.kind, 'reasoning');
  assert.ok(activity.payload.detail.length <= 2048);
  assert.equal(events.filter((e) => e.type === 'text').length, 0);
});

test('activity count is bounded while updates of existing activities still work', () => {
  let activities = [];
  for (let i = 0; i < 150; i++) activities = upsertActivity(activities, { id: `a${i}`, kind: 'tool', name: 'tool', status: 'running' });
  assert.equal(activities.length, 100);
  activities = upsertActivity(activities, { id: 'a0', kind: 'tool', name: 'tool', status: 'done' });
  assert.equal(activities[0].status, 'done');
});

test('Agent prices preserve optional CLI reports and zero rates', () => {
  const bot = { cliType: 'codex', model: 'model-A' };
  const usage = { inputTokens: 1e6, outputTokens: 5e5, cliCost: 100, apiCost: 100 };
  const prices = { codex: [{ enabled: true, model: 'model-A', inputPerMillion: 2, outputPerMillion: 4 }] };
  assert.equal(calculateCost(bot, usage, 1e6, 5e5, 'cli', 0, prices).cost, 4);
  assert.equal(calculateCost({ ...bot, model: 'different' }, {}, 1, 1, 'none', 0, prices).cost, null);
  assert.equal(calculateCost(bot, { cliCost: 0.2 }, 1, 1, 'cli').cost, 0.2);
  assert.equal(calculateCost(bot, { apiCost: 0.1 }, 1, 1, 'cli').estimated, false);
});

test('empty persona uses role default and native references do not inject copied bodies', () => {
  const bot = { id: 'b1', name: 'Bot', role: '审查者', cliType: 'codex', persona: '  ' };
  const prompt = buildPrompt(bot, [{ authorType: 'human', text: 'task' }], [bot], {}, [{
    mode: 'reference', name: 'sample', skillFile: 'D:/skills/sample/SKILL.md', body: 'MUST_NOT_COPY',
  }]);
  assert.match(prompt, /你是审查者/);
  assert.match(prompt, /D:\/skills\/sample\/SKILL.md/);
  assert.ok(!prompt.includes('MUST_NOT_COPY'));
  assert.match(buildPrompt({ ...bot, persona: 'My custom role' }, [], [bot], {}, []), /My custom role/);
});

test('references store metadata only, preserve same alias across CLIs and fail closed', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-references-'));
  const refs = require('../src/main/skills/skillReferences');
  try {
    const source = path.join(root, 'native');
    fs.mkdirSync(source);
    const file = path.join(source, 'SKILL.md');
    fs.writeFileSync(file, 'PRIVATE_SKILL_BODY');
    const data = path.join(root, 'data');
    const a = refs.register(data, { name: 'sample', sourcePath: source, cliTypes: ['codex'] });
    refs.register(data, { name: 'sample', sourcePath: source, cliTypes: ['claude'] });
    assert.equal(refs.list(data).length, 2);
    assert.throws(() => refs.register(data, { name: 'sample', sourcePath: source, cliTypes: ['codex'] }), /已登记/);
    assert.equal(refs.resolve(data, { alias: 'sample', cliType: 'codex' }).id, a.id);
    assert.throws(() => refs.resolve(data, { alias: 'sample', cliType: 'kimi' }), /不适用于/);
    assert.ok(!fs.readFileSync(path.join(data, 'skill-references.json'), 'utf8').includes('PRIVATE_SKILL_BODY'));
    const readFile = fs.readFileSync;
    fs.readFileSync = (filePath, ...args) => {
      if (path.resolve(filePath) === file) throw new Error('skill body must not be read');
      return readFile(filePath, ...args);
    };
    try { refs.resolve(data, { alias: 'sample', cliType: 'codex' }); }
    finally { fs.readFileSync = readFile; }
    fs.renameSync(file, file + '.moved');
    assert.equal(refs.list(data)[0].availability, 'unchecked');
    assert.throws(() => refs.resolve(data, { alias: 'sample', cliType: 'codex' }), /不可访问/);
    refs.remove(data, a.id);
    assert.ok(fs.existsSync(file + '.moved'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function orchestrationFixture({ registered = [], resolveReference } = {}) {
  const members = [{ id: 'b1', name: 'Bot1', cliType: 'codex', enabled: true, role: '执行者', model: 'model-A' }];
  const room = { id: 'r1', botIds: ['b1'], moderatorBotId: 'b1', routingMode: 'moderator', speakMode: 'sequential' };
  const messages = [{ id: 'human1', authorType: 'human', text: 'Saved edited message', status: 'done', roomId: 'r1' }];
  const events = [], calls = [], sessions = {};
  const store = {
    roomMembers: current => require('../src/shared/roomProfiles').members(current, members),
    listBots: () => members, listRooms: () => [room], getSettings: () => ({}), getDataPath: () => 'fixture-only',
    getSkillsDir: () => 'fixture-only', getMessages: () => messages, getSessions: () => sessions,
    getMessage: (_, id) => messages.find((message) => message.id === id),
    setSession: (key, record) => { sessions[key] = record; }, logCli() {},
    addMessage: (_, message) => messages.push(message),
    updateMessage: (_, id, patch) => Object.assign(messages.find((m) => m.id === id), patch),
  };
  const filename = require.resolve('../src/main/orchestrator/orchestrator');
  const exported = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    __dirname: path.dirname(filename), module: exported, structuredClone,
    require: (name) => {
      if (name === '../store/persistence') return store;
      if (name === '../skills/skillReferences') return { list: () => registered, resolve: resolveReference };
      if (name === '../skills/skillScanner') return { listImported: () => {
        if (registered.length) throw new Error('must not inspect copied skills for native invocation');
        return [];
      } };
      if (name === '../adapters/cliAdapter') return { runBot: (options) => {
        calls.push(options);
        return { cancel: async () => {}, onEvent: (listener) => listener('activity', {
          id: 'tool1', kind: 'tool', name: 'Read', status: 'running', detail: '@OtherBot internal output',
        }), promise: Promise.resolve({ text: 'answer', usage: { inputTokens: 2, outputTokens: 1 }, sessionId: 'new-session' }) };
      } };
      return name.startsWith('.') ? require(path.resolve(path.dirname(filename), name)) : require(name);
    },
  });
  const orchestrator = exported.exports;
  orchestrator.setEmitter((event) => events.push(event));
  return { orchestrator, messages, calls, events, sessions };
}

test('continueHuman dispatches saved text once without duplicate human or stale session', async () => {
  const f = orchestrationFixture();
  await f.orchestrator.continueHuman('r1', 'human1');
  assert.equal(f.messages.filter((m) => m.authorType === 'human').length, 1);
  assert.equal(f.calls[0].priorSessionId, null);
  assert.match(f.calls[0].prompt, /Saved edited message/);
  const bot = f.messages.find((m) => m.authorType === 'bot');
  assert.equal(bot.activities[0].status, 'done');
  assert.equal(bot.text, 'answer');
  assert.ok(f.events.some((e) => e.kind === 'message_update' && e.id === bot.id && e.patch.activities));
  await assert.rejects(f.orchestrator.continueHuman('r1', 'human1'), /最后一条/);
});

test('native reference mismatch warns and allows normal reply without claiming the skill ran', async () => {
  const f = orchestrationFixture({ registered: [{ alias: 'native' }], resolveReference() { throw new Error('CLI不匹配'); } });
  f.messages[0].text = '/native task';
  await f.orchestrator.continueHuman('r1', 'human1');
  assert.equal(f.calls.length, 1);
  const bot = f.messages.find((m) => m.authorType === 'bot');
  assert.equal(bot.status, 'done');
  assert.equal(bot.usage.inputTokens, 2);
  assert.ok(f.messages.some(m => m.authorType === 'system' && m.text.includes('CLI不匹配')));
  assert.match(f.calls[0].prompt, /不可用|不适用|无法使用/);
});

test('retry revalidates the original human native skill and never scans historical slash commands', async () => {
  const resolved = [];
  const f = orchestrationFixture({ registered: [{ alias: 'native' }, { alias: 'historical' }],
    resolveReference(_, request) { resolved.push(request.alias); throw new Error('native source missing'); } });
  f.messages.unshift({ id: 'old-human', roomId: 'r1', authorType: 'human', text: '/historical old task', status: 'done' });
  f.messages.find((message) => message.id === 'human1').text = '/native task';
  await f.orchestrator.continueHuman('r1', 'human1');
  const failed = f.messages.find((message) => message.authorType === 'bot');
  failed.status = 'error'; // A subsequent native failure remains retryable after the soft skill warning.
  await f.orchestrator.retry('r1', failed.id);
  assert.deepEqual(resolved, ['native', 'native']);
  assert.equal(f.calls.length, 2);
  assert.equal(f.messages.filter((message) => message.authorType === 'bot').at(-1).status, 'done');
  assert.equal(f.messages.filter((message) => message.authorType === 'human').length, 2);
});

test('repeated relay retry does not inherit the original human skill selection', async () => {
  let resolved = 0;
  const f = orchestrationFixture({ registered: [{ alias: 'native' }], resolveReference() {
    resolved += 1; throw new Error('must not resolve human skill for a relay');
  } });
  f.messages[0].text = '/native original task';
  f.messages.push({ id: 'relay-failed', roomId: 'r1', authorType: 'bot', authorId: 'b1',
    text: '', status: 'error', roundId: 'human1', _wave: 1 });
  await f.orchestrator.retry('r1', 'relay-failed');
  const retried = f.messages.filter((message) => message.authorType === 'bot').at(-1);
  assert.equal(retried.skillScope, 'relay');
  retried.status = 'error'; // A second failed attempt preserves its original scope.
  await f.orchestrator.retry('r1', retried.id);
  assert.equal(resolved, 0);
  assert.equal(f.calls.length, 2);
});

test('internal connection probe disables resume, forces read-only and adds provider isolation flags', async () => {
  for (const cliType of ['claude', 'codex']) {
    const calls = [];
    const logs = [];
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.pid = 123;
    const filename = require.resolve('../src/main/adapters/cliAdapter');
    const exported = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
      module: exported, process, setTimeout, clearTimeout,
      require: (name) => name === 'child_process' ? { spawn: (command, args, options) => {
        calls.push({ command, args, options }); return child;
      } } : name.startsWith('.') ? require(path.resolve(path.dirname(filename), name)) : require(name),
    });
    const handle = exported.exports.runBot({ bot: { cliType, permissionMode: 'full' }, probe: true,
      priorSessionId: 'must-not-resume', workspace: process.cwd(), prompt: 'Reply OK', log: (line) => logs.push(line) });
    child.stdout.write(JSON.stringify({ type: 'item.updated', item: { id: 'tool1', type: 'command_execution',
      command: 'echo token=fixture-private-value' } }) + '\n');
    child.stderr.write('authorization=fixture-private-value');
    child.emit('close', 0);
    await handle.promise;
    const args = calls[0].args;
    assert.ok(!logs.join('').includes('fixture-private-value'));
    assert.ok(!args.includes('must-not-resume'));
    assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!args.includes('--auto'));
    if (cliType === 'claude') {
      assert.equal(args[args.indexOf('--tools') + 1], '""');
      assert.ok(args.includes('--no-session-persistence'));
      assert.ok(args.includes('--strict-mcp-config'));
      assert.equal(args[args.indexOf('--permission-mode') + 1], 'dontAsk');
    } else if (cliType === 'codex') {
      assert.ok(args.includes('--ephemeral'));
      assert.ok(args.includes('--skip-git-repo-check'));
      assert.equal(args[args.indexOf('-s') + 1], 'read-only');
    }
  }
});
