'use strict';

// Harness tests use simulated workers; the final worker test scans fixtures only. An optional
// module path lets an isolated worktree review the integration module.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const modulePath = process.argv[2] ? path.resolve(process.argv[2])
  : path.join(__dirname, '../src/main/skills/skillDiscovery.js');
const source = fs.readFileSync(modulePath, 'utf8');

function harness() {
  const instances = [];
  const timers = new Set();
  let constructionError = null;
  class Worker extends EventEmitter {
    constructor(file, options) {
      super();
      if (constructionError) throw constructionError;
      this.file = file;
      this.options = options;
      this.terminations = 0;
      this.termination = new Promise((resolve, reject) => {
        this.finishTermination = resolve;
        this.failTermination = reject;
      });
      instances.push(this);
    }
    terminate() { this.terminations += 1; return this.termination; }
  }
  const exported = { exports: {} };
  vm.runInNewContext(source, {
    require: (name) => {
      if (name === '../../shared/i18n') return require('../src/shared/i18n');
      assert.equal(name, 'node:worker_threads');
      return { Worker, isMainThread: true };
    },
    module: exported,
    __filename: modulePath,
    setTimeout: (fn, delay) => { const t = { fn, delay }; timers.add(t); return t; },
    clearTimeout: (t) => timers.delete(t),
  });
  return { scan: exported.exports.scan, instances, timers,
    failConstruction: (error) => { constructionError = error; },
    expire: () => { for (const t of [...timers]) t.fn(); },
  };
}

test('one worker slot survives response until termination finishes', async () => {
  const h = harness();
  const options = { roots: ['fixture-only'], cwd: 'fixture' };
  const first = h.scan(options);
  assert.equal(JSON.stringify(h.instances[0].options.workerData), JSON.stringify({ ...options, language: 'zh-CN' }));
  await assert.rejects(h.scan({}), /正在进行/);
  assert.equal(h.instances.length, 1);
  const result = { skills: [], roots: [], warnings: [], truncated: false };
  h.instances[0].emit('message', result);
  assert.equal(await first, result);
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.scan({}), /正在进行/);
  h.instances[0].emit('exit', 0);
  assert.equal(h.instances[0].terminations, 1);
  h.instances[0].finishTermination(0);
  await Promise.resolve();
  const second = h.scan({});
  assert.equal(h.instances.length, 2);
  h.instances[1].emit('message', result);
  await second;
  h.instances[1].finishTermination(0);
});

test('timeout rejects after five seconds but retains busy slot during termination', async () => {
  const h = harness();
  const first = h.scan({});
  assert.equal([...h.timers][0].delay, 5000);
  const rejection = assert.rejects(first, /超时/);
  h.expire();
  await rejection;
  await assert.rejects(h.scan({}), /正在进行/);
  h.instances[0].emit('message', { skills: ['late result'] });
  assert.equal(h.instances[0].terminations, 1);
  h.instances[0].finishTermination(0);
  await Promise.resolve();
  const second = h.scan({});
  h.instances[1].emit('message', { skills: [] });
  await second;
  h.instances[1].finishTermination(0);
});

test('worker error and premature exit reject and clear the slot after termination', async () => {
  for (const event of ['error', 'exit']) {
    const h = harness();
    const first = h.scan({});
    const rejection = assert.rejects(first, event === 'error' ? /fixture failure/ : /提前结束/);
    h.instances[0].emit(event, event === 'error' ? new Error('fixture failure') : 1);
    await rejection;
    assert.equal(h.timers.size, 0);
    if (event === 'error') await assert.rejects(h.scan({}), /正在进行/);
    h.instances[0].finishTermination(1);
    await Promise.resolve();
    const second = h.scan({});
    h.instances[1].emit('message', { skills: [] });
    await second;
    h.instances[1].finishTermination(0);
  }
});

test('worker construction failure releases the slot without arming a timer', async () => {
  const h = harness();
  h.failConstruction(new Error('worker unavailable'));
  await assert.rejects(h.scan({}), /worker unavailable/);
  assert.equal(h.timers.size, 0);
  h.failConstruction(null);
  const next = h.scan({});
  assert.equal(h.instances.length, 1);
  h.instances[0].emit('message', { skills: [] });
  await next;
  h.instances[0].finishTermination(0);
});

test('failed termination is handled and only exit releases its slot', async () => {
  const h = harness();
  const first = h.scan({});
  h.instances[0].emit('message', { skills: [] });
  await first;
  h.instances[0].failTermination(new Error('termination failed'));
  await Promise.resolve();
  await assert.rejects(h.scan({}), /正在进行/);
  h.instances[0].emit('exit', 0);
  const second = h.scan({});
  h.instances[1].emit('message', { skills: [] });
  await second;
  h.instances[1].finishTermination(0);
});

test('late termination of an exited worker cannot release a newer worker slot', async () => {
  const h = harness();
  const first = h.scan({});
  h.instances[0].emit('message', { skills: [] });
  await first;
  h.instances[0].emit('exit', 0);
  const second = h.scan({});
  h.instances[0].finishTermination(0);
  await Promise.resolve();
  await assert.rejects(h.scan({}), /正在进行/);
  assert.equal(h.instances.length, 2);
  h.instances[1].emit('message', { skills: [] });
  await second;
  h.instances[1].finishTermination(0);
});


test('real worker filters backup trees and selects the newest local source', async () => {
  const os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-discovery-'));
  const write = (relative, timestamp) => {
    const dir = path.join(root, relative); fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, '---\nname: worker-fixture\ndescription: metadata only\n---\n');
    fs.utimesSync(file, timestamp, timestamp);
    return dir;
  };
  try {
    write('old', 100); const newest = write('new', 200);
    write('.rollback/a/b/c/d/e/f/g/h', 300);
    write('.venv/lib/a/b/c/d/e/f/g/h', 400);
    // category=other excludes all native home roots before filesystem access.
    const result = await require(modulePath).scan({ category: 'other', roots: [root] });
    assert.equal(result.truncated, false);
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].sourcePath, newest);
    assert.equal(result.skills[0].modifiedAt, 200000);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
