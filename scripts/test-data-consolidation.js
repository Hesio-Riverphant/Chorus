'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { planConsolidation, applyConsolidation, inventory } = require('./consolidate-data');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-merge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (store, file, value) => { const p = path.join(root, store, file); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(value)); };
  for (const store of ['source', 'destination']) {
    write(store, 'rooms.json', [{ id: 'room_' + store, name: 'Room', botIds: ['bot_' + store] }]);
    write(store, 'bots.json', [{ id: 'bot_' + store, name: 'Bot' }]);
    write(store, 'settings.json', { catchupMessages: store === 'source' ? 30 : 10 });
    write(store, 'messages/room_' + store + '.json', [{ id: 'msg_' + store, text: store }]);
  }
  return { root, write, plan: () => planConsolidation(path.join(root, 'source'), path.join(root, 'destination')) };
}
test('consolidation preserves both histories with independent verified rollback copies', t => {
  const f = fixture(t); f.write('destination', 'Preferences', { fixture: true });
  const plan = f.plan(); assert.equal(plan.summary.messages, 2);
  const result = applyConsolidation(plan, path.join(f.root, 'backup'));
  assert.equal(result.verified, true); assert.equal(result.rooms, 2);
  const merged = inventory(path.join(f.root, 'destination'));
  assert.deepEqual(JSON.parse(merged.get('rooms.json')).map(r => r.name), ['Room', 'Room (2)']);
  assert.equal(JSON.parse(merged.get('settings.json')).catchupMessages, 30);
  assert.ok(!inventory(path.join(f.root, 'backup/destination')).has('Preferences'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'destination/Preferences'))).fixture, true);
  assert.deepEqual(inventory(path.join(f.root, 'backup/source')), plan.primary);
});
test('divergent record identifiers stop consolidation before changing data', t => {
  const f = fixture(t); f.write('destination', 'bots.json', [{ id: 'bot_source', name: 'Different' }]);
  assert.throws(f.plan, /同一记录/); assert.equal(fs.existsSync(path.join(f.root, 'backup')), false);
});
test('changes after planning abort before backup or destination writes', t => {
  const f = fixture(t), plan = f.plan(); f.write('source', 'settings.json', { catchupMessages: 9 });
  assert.throws(() => applyConsolidation(plan, path.join(f.root, 'backup')), /数据已变化/);
  assert.equal(fs.existsSync(path.join(f.root, 'backup')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'destination/settings.json'))).catchupMessages, 10);
});
test('overlapping stores, invalid record IDs and missing references are rejected', t => {
  const f = fixture(t);
  assert.throws(() => planConsolidation(path.join(f.root, 'source'), path.join(f.root, 'source')), /彼此独立/);
  f.write('source', 'rooms.json', [{ id: '../escape', botIds: [] }]); assert.throws(f.plan, /格式无效/);
  f.write('source', 'rooms.json', [{ id: 'room_source', botIds: ['missing'] }]); assert.throws(f.plan, /成员缺失/);
});

test('live application store lease prevents migration, including acquisition after planning', t => {
  const f = fixture(t), plan = f.plan();
  const lease = require('../src/main/store/storeLease').acquireStoreLease(path.join(f.root, 'destination'));
  try {
    assert.throws(() => applyConsolidation(plan, path.join(f.root, 'backup')), /正在使用/);
    assert.equal(fs.existsSync(path.join(f.root, 'backup')), false);
  } finally { lease.release(); }
  assert.equal(applyConsolidation(plan, path.join(f.root, 'backup')).verified, true);
});

test('Windows BOM input remains readable and invalid JSON errors do not quote content', t => {
  const f = fixture(t), file = path.join(f.root, 'source/settings.json');
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ catchupMessages: 7 }));
  assert.equal(JSON.parse(f.plan().merged.get('settings.json')).catchupMessages, 7);
  fs.writeFileSync(file, '{private_fixture=unparseable}');
  assert.throws(f.plan, error => /JSON 格式无效/.test(error.message) && !error.message.includes('private_fixture'));
});

test('partially failed publication cleans owned staging and restores previous records', t => {
  const f = fixture(t), plan = f.plan(), originalWrite = fs.writeFileSync;
  let injected = false;
  fs.writeFileSync = function(file, ...args) {
    if (!injected && typeof file === 'number') {
      // Lease creation writes a string; publication writes the original buffer.
      if (Buffer.isBuffer(args[0])) {
        injected = true; originalWrite.call(this, file, args[0].subarray(0, 3));
        throw Object.assign(new Error('Synthetic EIO'), { code: 'EIO' });
      }
    }
    return originalWrite.call(this, file, ...args);
  };
  try { assert.throws(() => applyConsolidation(plan, path.join(f.root, 'backup')), /Synthetic EIO/); }
  finally { fs.writeFileSync = originalWrite; }
  assert.ok(injected);
  assert.deepEqual(inventory(path.join(f.root, 'destination')), plan.secondary);
  assert.equal(fs.readdirSync(path.join(f.root, 'backup')).some(name => name.startsWith('stage-')), false);
});

test('stale recovery requires a directory singleton and publishes only complete lock records', t => {
  const f = fixture(t), dir = path.join(f.root, 'source'), lock = path.join(dir, '.convoke-store-lock');
  const { acquireStoreLease } = require('../src/main/store/storeLease');
  const exited = require('node:child_process').spawnSync(process.execPath, ['-e', '']);
  fs.writeFileSync(lock, JSON.stringify({ pid: exited.pid, nonce: 'fixture-old-owner' }));
  assert.throws(() => acquireStoreLease(dir), /遗留锁/);
  const owner = acquireStoreLease(dir, { recoverStale: true });
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
  assert.throws(() => acquireStoreLease(dir), /正在使用/);
  owner.release();
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.readdirSync(dir).some(name => name.startsWith('.convoke-lock-owner-')), false);
});

test('a normal contender taking the released stale name is never overwritten by recovery', t => {
  const f = fixture(t), dir = path.join(f.root, 'source'), lock = path.join(dir, '.convoke-store-lock');
  const { acquireStoreLease } = require('../src/main/store/storeLease');
  const exited = require('node:child_process').spawnSync(process.execPath, ['-e', '']);
  fs.writeFileSync(lock, JSON.stringify({ pid: exited.pid, nonce: 'fixture-old-owner' }));
  const original = fs.renameSync; let contender;
  fs.renameSync = function(from, to) {
    const result = original.call(this, from, to);
    if (from === lock && !contender) contender = acquireStoreLease(dir);
    return result;
  };
  try { assert.throws(() => acquireStoreLease(dir, { recoverStale: true }), /正在使用/); }
  finally { fs.renameSync = original; contender?.release(); }
  assert.ok(contender);
});
