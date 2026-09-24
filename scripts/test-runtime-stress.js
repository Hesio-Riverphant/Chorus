'use strict';

// Run separately: node --test scripts/test-runtime-stress.js
// Real scheduler, disk persistence, custom CLI and three-generation Node trees.
// Peak: two trees (six fixture processes); no native Agents or network calls.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const store = require('../src/main/store/persistence');
const orchestrator = require('../src/main/orchestrator/orchestrator');
const { terminateTree } = require('../src/main/adapters/processTree');
const cliId = 'custom_' + '7'.repeat(32);

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
async function until(check, label, timeout = 7000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (check()) return; await delay(15); }
  assert.fail(`Timed out: ${label}`);
}
function records(dir) {
  return fs.readdirSync(dir).filter(name => name.endsWith('-ready.json')).map(name => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); } catch { return null; }
  }).filter(Boolean);
}
function pidsIn(dir) {
  return fs.readdirSync(dir).filter(name => name.endsWith('.pid')).map(name => Number(fs.readFileSync(path.join(dir, name), 'utf8'))).filter(Number.isSafeInteger);
}
async function noSurvivors(pids) {
  await until(() => pids.every(pid => !alive(pid)), `processes remain: ${pids}`, 7000);
}
function release(dir, record) { fs.writeFileSync(path.join(dir, `${record.id}-release`), 'finish'); }

test('real cross-room scheduling isolates stop, preserves provider errors, retries, and reaps race fixtures', { timeout: 90000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-runtime-stress-'));
  const dirs = ['room-one', 'room-two'].map(name => path.join(root, name));
  dirs.forEach(dir => fs.mkdirSync(dir));
  const events = [];
  t.after(async () => {
    await orchestrator.stopAll();
    clearInterval(store.timer);
    const pids = dirs.flatMap(pidsIn);
    // Emergency cleanup never hides failures: assertions precede this hook.
    for (const pid of pids) if (alive(pid)) await terminateTree(pid);
    for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await noSurvivors(pids);
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith('chorus-runtime-stress-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  await store.init({ isPackaged: true, getPath: () => path.join(root, 'data') });
  clearInterval(store.timer);
  store.saveSettings({ enabledCliIds: [cliId], cliProfiles: [{ id: cliId, label: 'Offline stress fixture',
    command: process.execPath, args: [path.join(__dirname, 'fixtures', 'runtime-stress-cli.js'), 'parent', '{model}'],
    historyArgs: [], promptMode: 'stdin', outputMode: 'jsonl' }] });
  const bots = dirs.map((_, i) => store.saveBot({ name: `Stress ${i}`, cliType: cliId,
    model: 'hold', enabled: true, permissionMode: 'read_only', persona: 'Controlled test fixture.' }));
  const rooms = bots.map((bot, i) => store.saveRoom({ name: `Stress room ${i}`, botIds: [bot.id],
    moderatorBotId: bot.id, routingMode: 'all', speakMode: 'sequential', cwd: dirs[i] }));
  orchestrator.setEmitter(event => events.push(structuredClone(event)));
  const lastBot = index => store.getMessages(rooms[index].id).findLast(message => message.authorType === 'bot');
  const model = (index, value) => { bots[index] = store.saveBot({ ...bots[index], model: value }); };
  async function start(index, value) {
    model(index, value);
    const seen = new Set(records(dirs[index]).map(record => record.id));
    const turn = orchestrator.handleHuman(rooms[index].id, `fixture request ${value}`);
    await until(() => records(dirs[index]).some(record => !seen.has(record.id)), `${value} tree ready`);
    const record = records(dirs[index]).find(record => !seen.has(record.id));
    return { turn, record };
  }

  await t.test('two rooms are simultaneously live; stopping one leaves the other running', async () => {
    const first = await start(0, 'hold');
    const second = await start(1, 'hold');
    assert.equal(orchestrator.getActiveRuns().length, 2);
    assert.ok([...first.record.pids, ...second.record.pids].every(alive));
    await Promise.all([orchestrator.stop(rooms[0].id), first.turn]);
    await noSurvivors(first.record.pids);
    assert.equal(lastBot(0).status, 'aborted');
    assert.equal(orchestrator.isBusy(rooms[1].id), true);
    assert.ok(second.record.pids.every(alive));
    release(dirs[1], second.record);
    await second.turn;
    assert.equal(lastBot(1).status, 'done');
    assert.match(lastBot(1).text, /completed:hold/);
    await noSurvivors(second.record.pids);
    assert.equal(orchestrator.isBusy(), false);
  });

  for (const code of [429, 503]) await t.test(`HTTP ${code} is visible, persisted and manually retryable`, async () => {
    model(0, `fail${code}`);
    await orchestrator.handleHuman(rooms[0].id, `fixture ${code}`);
    const failed = lastBot(0);
    assert.equal(failed.status, 'error');
    assert.match(failed.error, new RegExp(String(code)));
    assert.ok(events.some(event => event.kind === 'message_update' && event.id === failed.id &&
      event.patch?.status === 'error' && String(event.patch.error).includes(String(code))));
    store.flushSync();
    const disk = JSON.parse(fs.readFileSync(path.join(root, 'data', 'messages', `${rooms[0].id}.json`), 'utf8'));
    assert.match(disk.find(message => message.id === failed.id).error, new RegExp(String(code)));
    await noSurvivors(pidsIn(dirs[0]));
    await orchestrator.retry(rooms[0].id, failed.id);
    const retried = lastBot(0);
    assert.equal(retried.status, 'done');
    assert.equal(retried.supersedes, failed.id);
    assert.equal(store.getMessage(rooms[0].id, failed.id).supersededBy, retried.id);
    assert.match(retried.text, new RegExp(`completed:fail${code}`));
    await noSurvivors(pidsIn(dirs[0]));
  });

  await t.test('ten bounded stop/exit races settle once without surviving owned processes', async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const { turn, record } = await start(0, 'race');
      assert.ok(record.pids.every(alive));
      release(dirs[0], record);
      // Exercise immediate stop and stop competing with orderly tree exit.
      await delay([0, 1, 5, 15, 30][iteration % 5]);
      await Promise.all([orchestrator.stop(rooms[0].id), turn, orchestrator.stop(rooms[0].id)]);
      const message = lastBot(0);
      assert.ok(['done', 'aborted'].includes(message.status), `${iteration}: ${message.status}`);
      if (message.status === 'done') assert.match(message.text, /completed:race/);
      assert.equal(orchestrator.isBusy(), false);
      assert.equal(orchestrator.getPendingInputs().length, 0);
      const finishes = events.filter(event => event.kind === 'message_update' && event.id === message.id &&
        ['done', 'error', 'aborted'].includes(event.patch?.status));
      assert.equal(finishes.length, 1, `iteration ${iteration} must finish exactly once`);
      await noSurvivors(record.pids);
    }
  });
});
