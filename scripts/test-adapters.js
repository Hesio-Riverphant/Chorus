'use strict';

// Native failures need their actionable diagnostic, independent of provider code.
require('node:test')('Claude errors arrays retain provider detail and remove credentials', () => {
  const assert = require('node:assert/strict'), events = [];
  require('../src/main/adapters/cliSpecs').PARSERS.claude(JSON.stringify({ type: 'result', subtype: 'error_during_execution',
    is_error: true, errors: ['Authentication rejected: sign in again', 'api_key=synthetic-test-secret'], usage: {} }),
  (type, payload) => events.push({ type, payload }), {});
  const error = events.find(event => event.type === 'error').payload;
  assert.match(error, /Authentication rejected: sign in again/);
  assert.doesNotMatch(error, /synthetic-test-secret/);
});

require('node:test')('bounded native stderr decodes split UTF8 and never reveals a detached credential suffix', () => {
  const assert = require('node:assert/strict');
  const { createDiagnostics } = require('../src/main/adapters/diagnostics');
  const d = createDiagnostics(), text = Buffer.from('\uFEFF认证失败：请重新登录');
  for (const byte of text) d.push(Buffer.from([byte]));
  assert.equal(d.text(), '认证失败：请重新登录');
  const secret = createDiagnostics(40); secret.push(Buffer.from('api_key=' + 'x'.repeat(100))); secret.push(Buffer.from('tail-secret'));
  assert.match(secret.text(), /超过大小上限/); assert.doesNotMatch(secret.text(), /tail-secret|xxxx/);
});

// Offline process/NDJSON boundary tests. Never launches a model CLI.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const { RoomEvent } = require('../src/shared/constants');
const { PARSERS } = require('../src/main/adapters/cliSpecs');
const adapterPath = require.resolve('../src/main/adapters/cliAdapter');

function fixture(overrides = {}, spawnCalls = []) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const original = childProcess.spawn;
  childProcess.spawn = (command, args, options) => {
    spawnCalls.push({ command, args, options });
    if (command === 'taskkill') {
      const killer = new EventEmitter();
      killer.kill = () => true;
      process.nextTick(() => killer.emit('close', 0));
      return killer;
    }
    return child;
  };
  delete require.cache[adapterPath];
  const executable = require('../src/main/adapters/resolveExecutable');
  const discovery = require('../src/main/cliDiscovery');
  const locate = discovery.locateCliExecutable;
  discovery.locateCliExecutable = () => overrides.executablePath || null;
  const resolveExecutable = executable.resolveExecutable;
  executable.resolveExecutable = command => { if (overrides.launcherFailure) throw new Error('unsupported-wrapper'); return { command, argsPrefix: [] }; };
  const { runCliBot: runBot } = require(adapterPath);
  discovery.locateCliExecutable = locate;
  executable.resolveExecutable = resolveExecutable;
  childProcess.spawn = original;
  const handle = runBot({ bot: { cliType: 'codex' }, prompt: 'hello', workspace: process.cwd(), noBytesTimeoutMs: 50, ...overrides });
  const events = [];
  handle.onEvent((type, payload) => events.push({ type, payload }));
  return { child, handle, events };
}

test('custom JSONL subagents stay out of parent replies and retain provider identity', async () => {
  const cliType = 'custom_' + 'a'.repeat(32);
  const profile = { id: cliType, label: 'Fixture agent', command: process.execPath, args: [], promptMode: 'stdin', outputMode: 'jsonl' };
  const f = fixture({ bot: { cliType, permissionMode: 'full' }, cliSettings: { cliProfiles: [profile] } });
  const send = event => f.child.stdout.write(JSON.stringify(event) + '\n');
  send({ type: 'subagent', version: 1, id: 'child', sequence: 0, status: 'running', name: 'Research', task: 'Inspect fixture', output: 'First' });
  send({ type: 'subagent', version: 1, id: 'child', sequence: 1, status: 'done', output: 'First\n@Other child result' });
  send({ type: 'subagent', version: 1, id: 'child', sequence: 0, status: 'running', output: 'stale' });
  send({ type: 'text', text: 'Parent answer' });
  f.child.emit('close', 0);
  const result = await f.handle.promise;
  assert.equal(result.error, null); assert.equal(result.text, 'Parent answer');
  const activity = f.events.filter(event => event.type === 'activity').at(-1)?.payload;
  assert.equal(activity?.kind, 'subagent'); assert.equal(activity.status, 'done');
  assert.equal(activity.subagent.cliType, cliType); assert.equal(activity.subagent.task, 'Inspect fixture');
  assert.equal(activity.subagent.output, 'First\n@Other child result');
});

test('oversized stderr never exposes a credential suffix after losing its label', async () => {
  const logs = [], f = fixture({ log: value => logs.push(value) });
  const marker = 'synthetic-private-value';
  f.child.stderr.write('api_key=' + marker.repeat(300));
  f.child.stderr.write(marker.repeat(200)); f.child.emit('close', 1);
  const result = await f.handle.promise;
  assert.match(result.error, /错误输出过长/);
  assert.ok(!JSON.stringify([logs, f.events, result]).includes(marker));
});

test('Claude no-tool fallback replaces base read-only tools for native and wrapper launches', async () => {
  for (const launcherFailure of [false, true]) {
    const calls = [];
    const { child, handle } = fixture({ launcherFailure,
      bot: { cliType: 'claude', permissionMode: 'read_only' },
      nativeArgs: ['--safe-mode', '--strict-mcp-config', '--tools', ''] }, calls);
    const args = calls[0].args.map(arg => arg.replace(/^"|"$/g, ''));
    assert.equal(args.filter(arg => arg === '--tools').length, 1);
    assert.equal(args[args.indexOf('--tools') + 1], '');
    assert.ok(!args.includes('Read,Grep,Glob'));
    assert.ok(args.includes('mcp__*'));
    child.emit('close', 0); await handle.promise;
  }
});

test('mainstream CLI launchers preserve models and literal prompts across the actual process boundary', async () => {
  for (const cliType of ['gemini', 'qwen', 'copilot', 'cursor', 'droid']) {
    const calls = [], prompt = 'Question & literal 中文';
    const { child, handle } = fixture({ bot: { cliType, model: 'provider/model', permissionMode: 'full' }, prompt }, calls);
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].args[calls[0].args.indexOf('--model') + 1], 'provider/model');
    if (['gemini', 'cursor', 'droid'].includes(cliType)) {
      assert.equal(child.stdin.read().toString(), prompt);
      if (cliType === 'gemini') {
        child.stdout.write(JSON.stringify({ type: 'message', role: 'assistant', content: 'Answer' }) + '\n');
        child.stdout.write(JSON.stringify({ type: 'result', status: 'success' }) + '\n');
      } else child.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Answer' }, null, cliType === 'droid' ? 2 : 0) + '\n');
    } else {
      assert.equal(calls[0].args[calls[0].args.indexOf('--prompt') + 1], prompt);
      child.stdout.write(cliType === 'qwen' ? JSON.stringify({ type: 'result', is_error: false, result: 'Answer' }) + '\n' : 'Answer');
    }
    child.emit('close', 0);
    const result = await handle.promise;
    assert.equal(result.error, null); assert.equal(result.text, 'Answer');
  }
});

test('Cursor and Droid cancellation kills the owned process and settles an interrupted result', async () => {
  for (const cliType of ['cursor', 'droid']) {
    const calls = [];
    const { handle } = fixture({ bot: { cliType, permissionMode: 'read_only' } }, calls);
    await handle.cancel();
    assert.equal((await handle.promise).aborted, true);
    if (process.platform === 'win32') assert.ok(calls.some(call => call.command === 'taskkill' && call.args.includes('/T')));
  }
});

test('Codex thread.started preserves the resumable thread ID', () => {
  const events = [];
  PARSERS.codex(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }), (type, payload) => events.push({ type, payload }), {});
  assert.deepEqual(events, [{ type: 'session', payload: 'thread-1' }]);
});

test('Codex deltas followed by completed snapshot do not duplicate text', () => {
  const acc = {};
  let text = '';
  const emit = (type, payload) => { if (type === 'text') text += payload; };
  for (const event of [
    { type: 'item.started', item: { id: 'a', type: 'agent_message' } },
    { type: 'item.delta', delta: { type: 'output_text_delta', text: 'hello' } },
    { type: 'item.completed', item: { id: 'a', type: 'agent_message', text: 'hello' } },
    { type: 'item.completed', item: { id: 'b', type: 'agent_message', text: 'hello again' } },
  ]) {
    PARSERS.codex(JSON.stringify(event), emit, acc);
    if (event.type === 'item.completed' && event.item.id === 'a') assert.equal(text, 'hello');
  }
  assert.equal(text, 'hellohello again');
});

test('text emits the normalized streaming event and preserves split UTF-8', async () => {
  const { child, handle, events } = fixture();
  const bytes = Buffer.from(JSON.stringify({ type: 'item.completed', item: { id: 'a', type: 'agent_message', text: '中文' } }) + '\n');
  const split = bytes.indexOf(Buffer.from('中')) + 1;
  child.stdout.write(bytes.subarray(0, split));
  child.stdout.write(bytes.subarray(split));
  child.emit('close', 0);
  const result = await handle.promise;
  assert.equal(result.text, '中文');
  assert.deepEqual(events.filter((e) => e.type === RoomEvent.TEXT_DELTA).map((e) => e.payload), ['中文']);
});

test('nonzero exit remains an error after a valid partial response', async () => {
  const { child, handle } = fixture();
  child.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'partial' } }) + '\n');
  child.emit('close', 1);
  const result = await handle.promise;
  assert.match(result.error, /code 1/);
  assert.equal(result.text, 'partial');
});

test('protocol failure remains an error even with exit code zero', async () => {
  const { child, handle, events } = fixture();
  child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'quota exceeded' } }) + '\n');
  child.emit('close', 0);
  assert.equal((await handle.promise).error, 'quota exceeded');
  assert.equal(events.some((e) => e.type === RoomEvent.DONE), false);
});

test('protocol and stderr failures redact credential-shaped fields before events or results', async () => {
  for (const protocol of [true, false]) {
    const { child, handle, events } = fixture();
    if (protocol) child.stdout.write(JSON.stringify({ type: 'error', message: 'api_key=TEST_SENTINEL_VALUE' }) + '\n');
    else child.stderr.write('api_key=TEST_SENTINEL_VALUE');
    child.emit('close', protocol ? 0 : 1);
    const result = await handle.promise;
    assert.ok(result.error);
    assert.ok(!JSON.stringify({ result, events }).includes('TEST_SENTINEL_VALUE'));
  }
});

test('Pi uses shell-free argv, preserves streamed whitespace, closes stdin and suppresses native session IDs', async () => {
  const calls = [];
  const prompt = '中文 "quoted" & echo nope | %PATH%\nnext line';
  const { child, handle } = fixture({ bot: { cliType: 'pi', permissionMode: 'read_only' }, prompt, priorSessionId: 'old-id' }, calls);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].args.at(-1), prompt);
  assert.ok(calls[0].args.includes('--no-session'));
  assert.ok(!calls[0].args.includes('old-id'));
  assert.equal(child.stdin.writableEnded, true);
  child.stdout.write('  indented\n\n'); child.stdout.write('end\n'); child.emit('close', 0);
  const result = await handle.promise;
  assert.equal(result.text, '  indented\n\nend\n');
  assert.equal(result.sessionId, null);
});

test('Pi connection probe disables all tools before the prompt delimiter', async () => {
  const calls = [];
  const { child, handle } = fixture({ bot: { cliType: 'pi', permissionMode: 'full' }, probe: true }, calls);
  const args = calls[0].args;
  assert.ok(args.indexOf('--no-tools') < args.indexOf('--'));
  assert.ok(args.includes('--no-extensions'));
  assert.ok(!args.includes('--tools'));
  child.emit('close', 0); await handle.promise;
});

test('Windows Pi rejects oversized argv before spawning with a useful context limit message', { skip: process.platform !== 'win32' }, () => {
  const calls = [];
  assert.throws(() => fixture({ bot: { cliType: 'pi' }, prompt: 'x'.repeat(40000) }, calls), /补历史条数/);
  assert.equal(calls.length, 0);
});

test('stdin failure is handled without crashing the application', async () => {
  const { child, handle } = fixture();
  child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
  child.emit('close', 1);
  assert.ok((await handle.promise).error);
});

test('cancel settles even when the process does not emit close', async () => {
  const { handle } = fixture();
  await handle.cancel();
  const result = await Promise.race([handle.promise, new Promise((resolve) => setTimeout(() => resolve('hung'), 100))]);
  assert.notEqual(result, 'hung');
  assert.equal(result.aborted, true);
});

test('no output timeout produces a single failed result', async () => {
  const { handle, events } = fixture();
  const result = await handle.promise;
  assert.equal(result.error, 'timeout');
  assert.equal(events.filter((e) => e.type === RoomEvent.ERROR).length, 1);
});

test('Codex accumulates separate turns without double counting incremental updates', () => {
  const acc = {};
  let usage;
  const emit = (type, payload) => { if (type === 'usage') usage = payload; };
  for (const type of ['turn.completed.incremental', 'turn.completed', 'turn.completed']) {
    PARSERS.codex(JSON.stringify({ type, usage: { input_tokens: 10, output_tokens: 2 } }), emit, acc);
  }
  assert.equal(usage.inputTokens, 20);
  assert.equal(usage.outputTokens, 4);
});

test('Claude sums model calls and does not count repeated message snapshots twice', () => {
  const acc = {};
  let usage;
  const emit = (type, payload) => { if (type === 'usage') usage = payload; };
  for (const id of ['a', 'a', 'b']) {
    PARSERS.claude(JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: 10, output_tokens: 2 } } }), emit, acc);
  }
  PARSERS.claude(JSON.stringify({ type: 'result', usage: { input_tokens: 20, output_tokens: 4 } }), emit, acc);
  assert.equal(usage.inputTokens, 20);
  assert.equal(usage.outputTokens, 4);
});

test('a logging failure does not interrupt the turn', async () => {
  const { child, handle } = fixture({ log() { throw new Error('disk full'); } });
  child.stdout.write('malformed line\n');
  child.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }));
  child.emit('close', 0);
  const result = await handle.promise;
  assert.equal(result.sessionId, null);
  assert.equal(result.error, null);
});

test('native history uncertainty is a notice and each configured builtin can spawn', async () => {
  for (const cliType of ['kimi', 'opencode', 'hermes']) {
    const calls = [];
    const f = fixture({ bot: { cliType, permissionMode: cliType === 'kimi' ? 'full' : 'read_only' } }, calls);
    await new Promise(resolve => queueMicrotask(resolve));
    assert.equal(calls.length, 1);
    assert.equal(f.events.some(item => item.type === 'history_notice'), true);
    if (cliType === 'opencode') f.child.stdout.write(JSON.stringify({ type: 'text', part: { text: 'native reply' } }) + '\n');
    if (cliType === 'hermes') f.child.stdout.write('native reply');
    if (cliType === 'kimi') f.child.stdout.write(JSON.stringify({ role: 'assistant', content: 'native reply' }) + '\n');
    f.child.emit('close', 0);
    assert.equal((await f.handle.promise).error, null);
  }
});

test('shell launcher rejects unsafe model IDs before spawning', () => {
  for (const cliType of ['claude', 'codex']) {
    for (const value of ['x & whoami', 'x|whoami', 'x%PATH%', 'x!PATH!', 'x"y', 'x\ny', 'x y', '-s']) {
      for (const field of ['model']) {
        const calls = [];
        const overrides = { bot: { cliType } };
        if (field === 'model') overrides.bot.model = value;
        else overrides.priorSessionId = value;
        assert.throws(() => fixture(overrides, calls), /模型名称|会话标识/);
        assert.equal(calls.length, 0);
      }
    }
  }
});

test('recognized launchers use shell-free argv while saved session IDs are ignored', async () => {
  for (const cliType of ['claude', 'codex']) {
    const calls = [];
    const { child, handle } = fixture({ bot: { cliType, model: 'provider/model-name_v1.2:latest' }, priorSessionId: '019c1234-abcd-1234' }, calls);
    child.emit('close', 0);
    await handle.promise;
    assert.equal(calls[0].command, cliType);
    assert.equal(calls[0].options.shell, false);
    assert.ok(calls[0].args.includes('provider/model-name_v1.2:latest'));
    assert.ok(!calls[0].args.includes('019c1234-abcd-1234'));
    assert.ok(calls[0].args.includes(cliType === 'codex' ? '--ephemeral' : '--no-session-persistence'));
  }
});

test('selected reasoning and Claude plan reach the process without weakening app-only history', async () => {
  for (const cliType of ['claude', 'codex', 'pi']) {
    const calls = [];
    const { child, handle } = fixture({ bot: { cliType, reasoningEffort: 'high', executionMode: cliType === 'claude' ? 'plan' : 'chat' } }, calls);
    child.emit('close', 0); await handle.promise;
    const args = calls[0].args;
    const flag = cliType === 'claude' ? '--effort' : cliType === 'pi' ? '--thinking' : '-c';
    assert.equal(args[args.indexOf(flag) + 1], cliType === 'codex' ? 'model_reasoning_effort=high' : 'high');
    if (cliType === 'claude') assert.equal(args[args.indexOf('--permission-mode') + 1], 'plan');
  }
});

test('disabled providers, unsupported reasoning and unimplemented plan modes fail before spawn', () => {
  for (const overrides of [
    { cliSettings: { enabledCliIds: [] } },
    { bot: { cliType: 'claude', reasoningEffort: 'high;echo' } },
    { bot: { cliType: 'claude', model: 'haiku', reasoningEffort: 'high' } },
    { bot: { cliType: 'pi', executionMode: 'plan' } },
  ]) {
    const calls = []; assert.throws(() => fixture(overrides, calls)); assert.equal(calls.length, 0);
  }
});

test('custom Windows wrappers retain safe args and block shell metacharacters in extension paths', async () => {
  const calls = [];
  const { child, handle } = fixture({ launcherFailure: true, nativeArgs: ['--plugin-dir', 'C:\\My Plugins\\sample'] }, calls);
  child.emit('close', 0); await handle.promise;
  assert.equal(calls[0].options.shell, true);
  assert.ok(calls[0].args.includes('"C:\\My Plugins\\sample"'));
  for (const char of ['&', '|', '<', '>', '^', '%', '!', '"', '\n']) {
    const rejected = [];
    assert.throws(() => fixture({ launcherFailure: true, nativeArgs: ['--plugin-dir', `C:\\bad${char}path`] }, rejected));
    assert.equal(rejected.length, 0);
  }
});

test('launch uses the discovered absolute path for agents outside PATH', async () => {
  const calls = [];
  const { child, handle } = fixture({ executablePath: 'C:\\User\\.local\\bin\\codex.exe' }, calls);
  child.emit('close', 0); await handle.promise;
  assert.equal(calls[0].command, 'C:\\User\\.local\\bin\\codex.exe');
});

test('Claude read-only allows host questions without exposing mutation tools and probes disable tools once', async () => {
  for (const probe of [false, true]) {
    const calls = [];
    const { child, handle } = fixture({ bot: { cliType: 'claude', permissionMode: 'read_only' }, probe }, calls);
    child.emit('close', 0); await handle.promise;
    const args = calls[0].args;
    assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
    assert.equal(args.filter(arg => arg === '--tools').length, 1);
    assert.equal(args[args.indexOf('--tools') + 1], probe ? '' : 'Read,Grep,Glob,AskUserQuestion');
    assert.equal(args[args.indexOf('--disallowedTools') + 1], 'mcp__*');
  }
});

test('selected model reaches each supported CLI without native resume', async () => {
  for (const cliType of ['claude', 'codex']) for (const priorSessionId of [null, 'session-fixture']) {
    const calls = [];
    const { child, handle } = fixture({ bot: { cliType, model: 'provider/chosen-model[1m]' }, priorSessionId }, calls);
    child.emit('close', 0);
    await handle.promise;
    const flag = cliType === 'claude' ? '--model' : '-m';
    assert.equal(calls[0].args[calls[0].args.indexOf(flag) + 1], 'provider/chosen-model[1m]');
  }
});


test('custom CLI expands only declared placeholders and reports its real text result', async () => {
  const cliType = 'custom_' + 'b'.repeat(32);
  const settings = { cliProfiles: [{ id: cliType, label: 'Sample', command: 'C:\\Tools\\agent.exe',
    args: ['--model', '{model}', '{prompt}'], promptMode: 'arg', outputMode: 'text', historyArgs: ['--no-history'] }] };
  const calls = [];
  const f = fixture({ bot: { cliType, model: 'model/sample' }, cliSettings: settings, prompt: '@Bot 中文 & literal' }, calls);
  assert.deepEqual(calls[0].args, ['--model', 'model/sample', '@Bot 中文 & literal', '--no-history']);
  assert.equal(calls[0].options.shell, false);
  f.child.stdout.write('  Raw final\n'); f.child.emit('close', 0);
  assert.equal((await f.handle.promise).text, '  Raw final\n');
});

test('cache counts are native reported, accumulated without incremental duplication, and absent when unavailable', () => {
  for (const cli of ['claude', 'codex']) {
    const events = [], acc = {};
    const emit = (type, payload) => { if (type === 'usage') events.push(payload); };
    if (cli === 'claude') {
      PARSERS.claude(JSON.stringify({ type: 'result', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 40, cache_creation_input_tokens: 3 } }), emit, acc);
      assert.equal(events[0].inputTokens, 53);
      assert.equal(events[0].cachedInputTokens, 40);
      assert.equal(events[0].cacheCreationInputTokens, 3);
    } else {
      for (const type of ['turn.completed.incremental', 'turn.completed']) PARSERS.codex(JSON.stringify({ type, usage: { input_tokens: 50, output_tokens: 5, cached_input_tokens: 40 } }), emit, acc);
      PARSERS.codex(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 20, output_tokens: 2, cached_input_tokens: 10 } }), emit, acc);
      assert.equal(events.at(-1).cachedInputTokens, 50);
      assert.equal(events.at(-1).inputTokens, 70);
    }
    const missing = [];
    PARSERS[cli](JSON.stringify(cli === 'claude' ? { type: 'result', usage: { input_tokens: 10 } } : { type: 'turn.completed', usage: { input_tokens: 10 } }), (type, payload) => { if (type === 'usage') missing.push(payload); }, {});
    assert.equal(Object.hasOwn(missing[0], 'cachedInputTokens'), false);
  }
});


test('Claude native plan preserves the explicit read-only tool boundary', async () => {
  const calls = [];
  const f = fixture({ bot: { cliType: 'claude', executionMode: 'plan', permissionMode: 'read_only' } }, calls);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf('--permission-mode'), calls[0].args.indexOf('--permission-mode') + 6),
    ['--permission-mode', 'plan', '--tools', 'Read,Grep,Glob,AskUserQuestion', '--disallowedTools', 'mcp__*']);
  f.child.emit('close', 0); await f.handle.promise;
});


test('custom model selection cannot silently fall back when its launch has no model placeholder', () => {
  const { customSpec } = require('../src/main/adapters/cliAdapter');
  const spec = customSpec({ builtin: false, command: 'sample.exe', promptMode: 'stdin', outputMode: 'text', args: ['run'], historyArgs: [] });
  assert.throws(() => spec.args({ model: 'selected-model' }, null, 'hello'), /未配置独立的 \{model\}/);
  assert.deepEqual(spec.args({ model: '' }, null, 'hello'), ['run']);
});


test('Claude moves only tool-boundary public text into ordered progress and retains the final once', async () => {
  const { child, handle, events } = fixture({ bot: { cliType: 'claude' } });
  const write = value => child.stdout.write(JSON.stringify(value) + '\n');
  const stream = event => write({ type: 'stream_event', event });
  stream({ type: 'message_start', message: { id: 'progress' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '先检查文件。' } });
  stream({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'edit', name: 'Edit' } });
  write({ type: 'assistant', message: { id: 'progress', stop_reason: 'tool_use', content: [
    { type: 'text', text: '先检查文件。' }, { type: 'tool_use', id: 'edit', name: 'Edit', input: { file_path: 'src/demo.js' } },
  ] } });
  write({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit', content: 'ok' }] } });
  stream({ type: 'message_start', message: { id: 'final' } });
  stream({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已经修复。' } });
  write({ type: 'assistant', message: { id: 'final', stop_reason: 'end_turn', content: [{ type: 'text', text: '已经修复。' }] } });
  child.emit('close', 0);
  const result = await handle.promise;
  assert.equal(result.text, '已经修复。');
  let renderedText = '';
  for (const event of events) {
    if (event.type === 'text_delta') renderedText += event.payload;
    if (event.type === 'text_replace') renderedText = event.payload;
  }
  assert.equal(renderedText, result.text);
  assert.ok(events.some(event => event.type === 'final_answer' && event.payload === true));
  const progress = events.find(event => event.type === 'activity' && event.payload.phase === 'commentary').payload;
  const edit = events.filter(event => event.type === 'activity' && event.payload.id === 'edit').at(-1).payload;
  assert.equal(progress.detail, '先检查文件。'); assert.ok(progress.order < edit.order);
  assert.deepEqual(edit.files, ['src/demo.js']); assert.equal(edit.status, 'done');
});

test('Claude single-block envelopes retain native stream indexes after thinking without duplicating text', () => {
  const acc = {}, events = []; let body = '';
  const emit = (type, payload) => { events.push({ type, payload }); if (type === 'text') body += payload; if (type === 'text_replace') body = payload; };
  const write = event => PARSERS.claude(JSON.stringify(event), emit, acc);
  const stream = event => write({ type: 'stream_event', event });
  for (const [id, text, stop] of [['progress', 'Checking.', 'tool_use'], ['final', 'Answer.', 'end_turn']]) {
    stream({ type: 'message_start', message: { id } });
    stream({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    write({ type: 'assistant', message: { id, content: [{ type: 'thinking', thinking: '' }] } });
    stream({ type: 'content_block_stop', index: 0 });
    stream({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    stream({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } });
    write({ type: 'assistant', message: { id, content: [{ type: 'text', text }] } });
    stream({ type: 'content_block_stop', index: 1 });
    stream({ type: 'message_delta', delta: { stop_reason: stop } });
    stream({ type: 'message_stop' });
  }
  assert.equal(body, 'Answer.');
  const progress = events.filter(event => event.type === 'activity' && event.payload.phase === 'commentary');
  assert.equal(progress.at(-1).payload.detail, 'Checking.');
  assert.equal(new Set(progress.map(event => event.payload.id)).size, 1);
});

test('Claude identical text in different stream blocks or messages is preserved', () => {
  const acc = {}; let body = '';
  const emit = (type, payload) => { if (type === 'text') body += payload; if (type === 'text_replace') body = payload; };
  const write = event => PARSERS.claude(JSON.stringify(event), emit, acc);
  const stream = event => write({ type: 'stream_event', event });
  for (const id of ['one', 'two']) {
    stream({ type: 'message_start', message: { id } });
    for (const index of [0, 1]) {
      stream({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      stream({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: 'Repeat.' } });
      write({ type: 'assistant', message: { id, content: [{ type: 'text', text: 'Repeat.' }] } });
      stream({ type: 'content_block_stop', index });
    }
    stream({ type: 'message_delta', delta: { stop_reason: 'end_turn' } });
    stream({ type: 'message_stop' });
  }
  assert.equal(body, 'Repeat.'.repeat(4));
});

test('Claude interrupted and unidentified streams remain visible without inferred final or duplicate snapshots', async () => {
  for (const identified of [true, false]) {
    const { child, handle, events } = fixture({ bot: { cliType: 'claude' } });
    const write = value => child.stdout.write(JSON.stringify(value) + '\n');
    if (identified) write({ type: 'stream_event', event: { type: 'message_start', message: { id: 'unresolved' } } });
    write({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '尚未分类的原文' } } });
    if (!identified) write({ type: 'assistant', message: { id: 'late', content: [{ type: 'text', text: '尚未分类的原文' }, { type: 'tool_use', id: 't', name: 'Read', input: {} }] } });
    child.emit('close', 1);
    const result = await handle.promise;
    assert.equal(result.text, '尚未分类的原文');
    assert.ok(result.error); assert.ok(!events.some(event => event.type === 'final_answer'));
    assert.ok(!events.some(event => event.type === 'activity' && event.payload.phase === 'commentary'));
  }
});

test('Claude nonstream assistant envelopes retain real final text and a full activity list never drops progress', () => {
  for (const full of [true, false]) {
    const acc = full ? { activities: Array.from({ length: 100 }, (_, i) => ({ id: `existing-${i}`, kind: 'tool' })) } : {};
    let body = ''; const events = [];
    const emit = (type, payload) => { events.push({ type, payload }); if (type === 'text') body += payload; if (type === 'text_replace') body = payload; };
    PARSERS.claude(JSON.stringify({ type: 'assistant', message: { id: 'snapshot', stop_reason: full ? 'tool_use' : 'end_turn', content: [{ type: 'text', text: '完整输出' }] } }), emit, acc);
    assert.equal(body, '完整输出');
    if (full) assert.ok(!events.some(event => event.type === 'activity'));
    else assert.ok(events.some(event => event.type === 'final_answer'));
  }
});


test('ZCode process receives literal prompt, requires final result and cancels its owned process', async () => {
  for (const terminal of ['result', 'incomplete', 'cancel']) {
    const calls = [], prompt = 'literal & 中文';
    const { child, handle } = fixture({ bot: { cliType: 'zcode', permissionMode: 'full' }, prompt }, calls);
    assert.equal(calls[0].options.shell, false); assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].args[calls[0].args.indexOf('--prompt') + 1], prompt);
    if (terminal === 'cancel') { await handle.cancel(); assert.equal((await handle.promise).aborted, true); }
    else {
      child.stdout.write(JSON.stringify({ type: 'model.streaming', payload: { kind: 'text_delta', delta: 'Answer' } }) + '\n');
      if (terminal === 'result') child.stdout.write(JSON.stringify({ type: 'result', response: 'Answer' }) + '\n');
      child.emit('close', 0); const result = await handle.promise;
      assert.equal(result.text, 'Answer');
      if (terminal === 'result') assert.equal(result.error, null);
      else assert.match(result.error, /成功结果/);
    }
  }
  const calls = [];
  assert.throws(() => fixture({ bot: { cliType: 'zcode', permissionMode: 'full' }, probe: true }, calls), /无工具连接测试/);
  assert.equal(calls.length, 0);
});


test('timeout and cancellation never parse late buffered terminal JSON', async () => {
  for (const cancel of [false, true]) {
    const { child, handle, events } = fixture({ bot: { cliType: 'qwen', permissionMode: 'full' }, noBytesTimeoutMs: 10 });
    child.stdout.write(JSON.stringify({ type: 'result', result: 'late result' }));
    if (cancel) await handle.cancel();
    else await new Promise(resolve => setTimeout(resolve, 25));
    child.emit('close', 0);
    const result = await handle.promise;
    assert.equal(result.aborted, cancel);
    assert.equal(result.error, cancel ? null : 'timeout');
    assert.equal(result.text, '');
    assert.ok(!events.some(event => event.type === 'final_answer' || event.type === 'done'));
  }
});

test('mainstream partial streams cannot certify success without terminal result', async () => {
  for (const cliType of ['gemini', 'qwen', 'cursor', 'droid']) {
    const { child, handle } = fixture({ bot: { cliType, permissionMode: 'full' } });
    const item = cliType === 'gemini' ? { type: 'message', role: 'assistant', content: 'partial' }
      : { type: 'assistant', message: { content: [{ type: 'text', text: 'partial' }] } };
    child.stdout.write(JSON.stringify(item) + '\n'); child.emit('close', 0);
    assert.ok((await handle.promise).error);
  }
});

test('plain UTF8 BOM is stripped once and native stderr 429/503 tails remain readable and redacted', async () => {
  const { child, handle } = fixture({ bot: { cliType: 'pi', permissionMode: 'full' } });
  const data = Buffer.from('\uFEFF中文 😀');
  for (const byte of data) child.stdout.write(Buffer.from([byte]));
  child.emit('close', 0); assert.equal((await handle.promise).text, '中文 😀');
  for (const code of ['429', '503']) {
    const logs = [];
    const f = fixture({ log: value => logs.push(value) }); const tail = Buffer.from(`${code} 中文 unavailable api_key=TEST_SENTINEL_VALUE`);
    for (const byte of tail) f.child.stderr.write(Buffer.from([byte]));
    f.child.emit('close', 1); const result = await f.handle.promise;
    assert.match(result.error, new RegExp(code)); assert.match(result.error, /中文/);
    assert.ok(!result.error.includes('TEST_SENTINEL_VALUE'));
    assert.equal(logs.length, 1); assert.ok(!logs[0].includes('TEST_SENTINEL_VALUE'));
    assert.match(logs[0], /已隐藏/);
  }
});
