'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Persistence = require('../src/main/store/persistence').constructor;

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-side-chats-'));
  const stores = [];
  const open = async () => {
    const store = new Persistence(); stores.push(store);
    await store.init({ isPackaged: true, getPath: () => dir });
    clearInterval(store.timer); return store;
  };
  t.after(() => {
    for (const store of stores) clearInterval(store.timer);
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('convoke-side-chats-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, open, store: await open() };
}

test('pin and rename retain transcript identity and survive restart', async (t) => {
  const f = await fixture(t), { store } = f;
  const room = store.rooms[0];
  store.addMessage(room.id, { id: 'm', roomId: room.id, text: 'kept', status: 'done' });
  assert.ok(store.setRoomPinned(room.id, true).pinnedAt > 0);
  assert.equal(store.renameRoom(room.id, 'Renamed').id, room.id);
  assert.throws(() => store.renameRoom(room.id, ''), /名称/);
  assert.throws(() => store.setRoomPinned(room.id, 'yes'), /状态/);
  const reopened = await f.open();
  assert.equal(reopened.rooms[0].name, 'Renamed');
  assert.ok(reopened.rooms[0].pinnedAt);
  assert.equal(reopened.getMessages(room.id)[0].text, 'kept');
  assert.equal(reopened.setRoomPinned(room.id, false).pinnedAt, null);
});

test('side chat keeps member identity with isolated snapshot edits, history and routing', async (t) => {
  const f = await fixture(t), { store } = f;
  const parent = store.saveRoom({ ...store.rooms[0], cwd: f.dir });
  const source = store.bots.find(bot => bot.id === parent.botIds[0]);
  const count = store.bots.length;
  store.addMessage(parent.id, { id: 'm', roomId: parent.id, text: 'parent', status: 'done' });
  const side = store.createSideChat(parent.id);
  assert.equal(side.parentRoomId, parent.id);
  assert.equal(side.cwd, f.dir);
  assert.deepEqual(side.botIds, parent.botIds);
  assert.equal(store.bots.length, count);
  assert.deepEqual(store.getMessages(side.id), []);
  store.saveBot({ id: source.id, model: 'shared-model' });
  assert.notEqual(store.roomMembers(side)[0].model, 'shared-model');
  const edited = store.saveRoomMember(side.id, { id: source.id, model: 'side-only-model' });
  assert.equal(edited.bot.model, 'side-only-model');
  assert.equal(store.bots.find(bot => bot.id === source.id).model, 'shared-model');
  store.saveRoom({ ...side, routingMode: 'all', speakMode: 'sequential' });
  store.addMessage(side.id, { id: 's', roomId: side.id, text: 'side', status: 'done' });
  assert.equal(store.rooms.find(room => room.id === parent.id).routingMode, parent.routingMode);
  const reopened = await f.open();
  assert.equal(reopened.getMessages(side.id)[0].text, 'side');
  assert.equal(reopened.getMessages(parent.id)[0].text, 'parent');
  assert.deepEqual(reopened.rooms.find(room => room.id === side.id).botIds, parent.botIds);
  reopened.deleteBot(source.id);
  assert.ok(!reopened.rooms.find(room => room.id === parent.id).botIds.includes(source.id));
  const sideAfter = reopened.rooms.find(room => room.id === side.id);
  assert.ok(sideAfter.botIds.includes(source.id));
  assert.equal(reopened.roomMembers(sideAfter)[0].model, 'side-only-model');
});

test('adding an existing member to a side chat never creates another bot', async (t) => {
  const { store } = await fixture(t);
  const side = store.createSideChat(store.rooms[0].id);
  const template = store.saveBot({ name: 'Template', cliType: 'codex', enabled: true });
  const count = store.bots.length;
  const updated = store.saveRoom({ ...side, botIds: [...side.botIds, template.id] });
  assert.equal(store.bots.length, count);
  assert.ok(updated.botIds.includes(template.id));
  store.saveRoom(updated);
  assert.equal(store.bots.length, count);
});

// Explicit fixture for old private-profile records; recovery must continue to
// preserve their identity even though newly created side chats share members.
function legacySide(store) {
  const side = store.createSideChat(store.rooms[0].id);
  const clones = side.botIds.map(id => store.saveBot({ ...store.bots.find(bot => bot.id === id),
    id: undefined, ownerRoomId: side.id, sourceBotId: id }));
  return store.saveRoom({ ...side, botIds: clones.map(bot => bot.id), moderatorBotId: clones[0].id });
}

test('parent directory edits update side rooms and removal keeps side histories reachable', async (t) => {
  const { store } = await fixture(t);
  const parent = store.rooms[0];
  const side = store.createSideChat(parent.id);
  store.addMessage(side.id, { id: 's', roomId: side.id, text: 'retained', status: 'done' });
  store.saveRoom({ id: parent.id, cwd: 'new-directory' });
  assert.equal(store.rooms.find((room) => room.id === side.id).cwd, 'new-directory');
  store.saveRoom({ id: side.id, cwd: 'ignored' });
  assert.equal(store.rooms.find((room) => room.id === side.id).cwd, 'new-directory');
  store.deleteRoom(parent.id);
  const retained = store.rooms.find((room) => room.id === side.id);
  assert.equal(retained.parentRoomId, undefined);
  assert.equal(store.getMessages(side.id)[0].text, 'retained');
  assert.equal(store.saveRoom({ ...retained }).botIds.length, side.botIds.length);
});

test('room commit failure rolls back new cloned profiles and keeps source untouched', async (t) => {
  const { store, dir } = await fixture(t);
  const bots = JSON.parse(JSON.stringify(store.bots)), rooms = JSON.parse(JSON.stringify(store.rooms));
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(dir, 'rooms.json')) throw new Error('fixture room commit failure');
    return rename(from, to);
  };
  try { assert.throws(() => store.createSideChat(rooms[0].id), /fixture room commit failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(store.rooms, rooms);
  assert.deepEqual(store.bots, bots);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bots.json'), 'utf8')), bots);
});

test('branching a side conversation creates a separate room with independent profiles and author references', async (t) => {
  const { store } = await fixture(t);
  const side = legacySide(store);
  const authorId = side.botIds[0];
  store.addMessage(side.id, { id: 's', roomId: side.id, authorType: 'bot', authorId,
    mentions: [side.botIds[1]], mode: 'plan', modeTargetIds: [authorId, side.botIds[1]], text: 'branch history', status: 'done' });
  const fork = store.forkRoomAt(side.id, 's');
  assert.equal(fork.parentRoomId, undefined);
  assert.ok(fork.botIds.every((id) => !side.botIds.includes(id)));
  assert.equal(store.getMessages(fork.id)[0].authorId, fork.botIds[0]);
  assert.deepEqual(store.getMessages(fork.id)[0].mentions, [fork.botIds[1]]);
  assert.deepEqual(store.getMessages(fork.id)[0].modeTargetIds, fork.botIds.slice(0, 2));
  store.saveBot({ id: fork.botIds[0], name: 'Branch member' });
  assert.notEqual(store.bots.find((bot) => bot.id === authorId).name, 'Branch member');
  const template = store.saveBot({ name: 'New template', cliType: 'codex' });
  const updated = store.saveRoom({ ...fork, botIds: [...fork.botIds, template.id] });
  assert.ok(updated.botIds.includes(template.id));
  assert.equal(updated.memberProfiles[template.id].name, template.name);
});

async function deletedSideCollision(t) {
  const f = await fixture(t), { store } = f;
  let side = legacySide(store);
  side = store.setMemberDisplayOrder(side.id, [...side.botIds].reverse());
  const authorId = side.botIds[0], mentionedId = side.botIds[1];
  store.saveBot({ id: authorId, model: 'snapshot-model' });
  store.addMessage(side.id, { id: 'archived', roomId: side.id, authorType: 'bot', authorId,
    mentions: [mentionedId, 'all'], mode: 'plan', modeTargetIds: [authorId, mentionedId], text: 'archived', status: 'done' });
  const archive = store.archiveCurrent(side.id);
  store.addMessage(side.id, { id: 'live', roomId: side.id, authorType: 'bot', authorId,
    mentions: [mentionedId], mode: 'plan', modeTargetIds: [authorId, mentionedId], text: 'live', status: 'done' });
  const key = store.deleteRoom(side.id);
  delete side.parentRoomId;
  store.saveRoom(side);
  return { ...f, side, key, archive };
}

test('restoring a side-chat ID collision clones private members and remaps live and archived authors', async (t) => {
  const { store, open, side, key, archive } = await deletedSideCollision(t);
  const restoredId = store.restoreTrash(key);
  const restored = store.rooms.find(room => room.id === restoredId);
  assert.notEqual(restoredId, side.id);
  assert.ok(restored.botIds.every(id => !side.botIds.includes(id)));
  assert.deepEqual(restored.memberDisplayOrder, [...restored.botIds].reverse());
  assert.equal(restored.moderatorBotId, restored.botIds[0]);
  for (const id of restored.botIds) assert.equal(store.bots.find(bot => bot.id === id).ownerRoomId, restoredId);
  for (const message of [store.getMessage(restoredId, 'live'), store.getArchive(restoredId, archive.id).messages[0]]) {
    assert.equal(message.roomId, restoredId);
    assert.equal(message.authorId, restored.botIds[0]);
    assert.equal(message.mentions[0], restored.botIds[1]);
    assert.equal(message.mode, 'plan');
    assert.deepEqual(message.modeTargetIds, restored.botIds.slice(0, 2));
  }
  assert.equal(store.getArchive(restoredId, archive.id).messages[0].mentions[1], 'all');
  store.saveBot({ id: restored.botIds[0], model: 'restored-only' });
  assert.equal(store.bots.find(bot => bot.id === side.botIds[0]).model, 'snapshot-model');
  const reopened = await open();
  assert.equal(reopened.getMessage(restoredId, 'live').authorId, restored.botIds[0]);
  assert.equal(reopened.bots.find(bot => bot.id === restored.botIds[0]).ownerRoomId, restoredId);
});

test('failed side restore commit rolls back private profiles and retries the same saved identities', async (t) => {
  const { store, open, dir, side, key } = await deletedSideCollision(t);
  const beforeBots = JSON.parse(JSON.stringify(store.bots));
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(dir, 'rooms.json')) throw new Error('fixture restore commit failure');
    return rename(from, to);
  };
  try { assert.throws(() => store.restoreTrash(key), /fixture restore commit failure/); }
  finally { fs.renameSync = rename; }
  assert.deepEqual(store.bots, beforeBots);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'bots.json'), 'utf8')), beforeBots);
  const staged = JSON.parse(fs.readFileSync(path.join(dir, 'trash', key, 'restore.json'), 'utf8'));
  assert.ok(staged.botIds.every(id => !side.botIds.includes(id)));
  store.saveBot({ id: side.botIds[0], model: 'changed-after-failure' });
  const reopened = await open();
  assert.equal(reopened.restoreTrash(key), staged.id);
  const restored = reopened.rooms.find(room => room.id === staged.id);
  assert.deepEqual(restored.botIds, staged.botIds);
  assert.equal(reopened.bots.find(bot => bot.id === restored.botIds[0]).model, 'snapshot-model');
  assert.equal(reopened.bots.find(bot => bot.id === side.botIds[0]).model, 'changed-after-failure');
});

test('side restore cleanup retry does not duplicate private members or overwrite a newer reply', async (t) => {
  const { store, open, dir, key } = await deletedSideCollision(t);
  const rm = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === path.join(dir, 'trash', key)) throw new Error('fixture restore cleanup failure');
    return rm(target, options);
  };
  try { assert.throws(() => store.restoreTrash(key), /fixture restore cleanup failure/); }
  finally { fs.rmSync = rm; }
  const restored = JSON.parse(fs.readFileSync(path.join(dir, 'trash', key, 'restore.json'), 'utf8'));
  const count = store.bots.length;
  store.addMessage(restored.id, { id: 'newer', roomId: restored.id, text: 'retained', status: 'done' });
  const reopened = await open();
  assert.equal(reopened.restoreTrash(key), restored.id);
  assert.equal(reopened.bots.length, count);
  assert.equal(reopened.getMessage(restored.id, 'newer').text, 'retained');
});

test('restoring an unused side-chat ID preserves its own private member identities', async (t) => {
  const { store } = await fixture(t);
  const side = store.createSideChat(store.rooms[0].id);
  const count = store.bots.length;
  const key = store.deleteRoom(side.id);
  assert.equal(store.restoreTrash(key), side.id);
  assert.deepEqual(store.rooms.find(room => room.id === side.id).botIds, side.botIds);
  assert.equal(store.bots.length, count);
});

test('legacy migration retains exact side author IDs and snapshots with an independent backup', async (t) => {
  const { store, open, dir } = await fixture(t);
  const parent = store.rooms[0], side = legacySide(store);
  const oldId = side.botIds[0];
  store.addMessage(side.id, { id: 'old', authorType: 'bot', authorId: oldId, text: 'retained', status: 'done' });
  const archive = store.archiveCurrent(side.id);
  const unknown = store.saveBot({ name: 'Same name', cliType: 'codex', ownerRoomId: side.id, sourceBotId: 'missing' });
  store.saveRoom({ ...side, botIds: [...side.botIds, unknown.id] });
  // Simulate the legacy schema without room snapshots.
  const diskRooms = JSON.parse(fs.readFileSync(path.join(dir, 'rooms.json'), 'utf8'));
  delete diskRooms.find(room => room.id === side.id).memberProfiles;
  fs.writeFileSync(path.join(dir, 'rooms.json'), JSON.stringify(diskRooms));
  const reopened = await open();
  const migrated = reopened.rooms.find(room => room.id === side.id);
  assert.deepEqual(migrated.botIds, [...side.botIds, unknown.id]);
  assert.ok(migrated.memberProfiles[oldId]);
  assert.ok(reopened.bots.some(bot => bot.id === oldId));
  assert.equal(reopened.getArchive(side.id, archive.id).messages[0].authorId, oldId);
  const backup = JSON.parse(fs.readFileSync(path.join(dir, 'rooms-before-local-profiles.json'), 'utf8'));
  assert.ok(backup.rooms.find(room => room.id === side.id).botIds.includes(oldId));
  assert.deepEqual((await open()).rooms.find(room => room.id === side.id).botIds, migrated.botIds);
});

test('archive search includes standalone snapshots from archived rooms and excludes permanently deleted content', async t => {
  const { store, open } = await fixture(t);
  const room = store.rooms[0];
  store.addMessage(room.id, { id: 'needle_old', text: 'Needle old content', createdAt: 1, status: 'done' });
  const a = store.archiveCurrent(room.id);
  store.addMessage(room.id, { id: 'needle_new', text: 'Needle recent content', createdAt: 5, status: 'done' });
  store.addMessage(room.id, { id: 'progress', text: 'Final', createdAt: 6, status: 'done',
    activities: [{ phase: 'commentary', detail: 'public-progress-query', order: 0 }] });
  const b = store.archiveCurrent(room.id);
  store.setRoomArchived(room.id, true);
  const reopened = await open();
  assert.deepEqual((await reopened.searchArchives(' NEEDLE ')).hits.map(hit => [hit.archiveId, hit.messageId]), [[b.id, 'needle_new'], [a.id, 'needle_old']]);
  assert.equal((await reopened.searchArchives('needle', 1)).hits.length, 1);
  assert.equal((await reopened.searchArchives('public-progress-query')).hits[0].messageId, 'progress');
  assert.deepEqual((await reopened.searchArchives('')).hits, []);
  assert.deepEqual(reopened.getMessages(room.id), []);
  reopened.permanentDeleteRoom(room.id);
  assert.deepEqual((await reopened.searchArchives('needle')).hits, []);
});

test('failed shared bot deletion preserves the member and both room memberships on disk', async t => {
  const { store, dir, open } = await fixture(t);
  const parent = store.rooms[0], side = store.createSideChat(parent.id), botId = side.botIds[0];
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === path.join(dir, 'rooms.json')) throw new Error('fixture delete failure'); return rename(from, to); };
  try { assert.throws(() => store.deleteBot(botId), /fixture delete failure/); }
  finally { fs.renameSync = rename; }
  const reopened = await open();
  assert.ok(reopened.bots.some(bot => bot.id === botId));
  assert.ok(reopened.rooms.filter(room => [parent.id, side.id].includes(room.id)).every(room => room.botIds.includes(botId)));
});

test('archive search bounds results, reports corrupt/oversize files and leaves source untouched', async t => {
  const { store, dir } = await fixture(t);
  const room = store.rooms[0], archiveDir = path.join(dir, 'archives', room.id);
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.writeFileSync(path.join(archiveDir, 'corrupt.json'), '{broken');
  fs.writeFileSync(path.join(archiveDir, 'large.json'), ' '.repeat(8192));
  fs.writeFileSync(path.join(archiveDir, 'good.json'), JSON.stringify({ id: 'good', messages: Array.from({ length: 300 }, (_, i) => ({ id: `m${i}`, text: 'needle', createdAt: i })) }));
  const result = await store.searchArchives('needle');
  assert.equal(result.hits.length, 100);
  assert.equal(result.hits[0].messageId, 'm299');
  assert.equal(result.hits.at(-1).messageId, 'm200');
  assert.equal(result.warnings.length, 2);
  assert.equal(fs.readFileSync(path.join(archiveDir, 'corrupt.json'), 'utf8'), '{broken');
  const small = await require('../src/main/store/archiveSearch').searchArchives(dir, [room], 'needle', { maxArchiveBytes: 4096 });
  assert.ok(small.warnings.some(warning => warning.includes('超过')));
});

test('superseded archive searches terminate their worker without blocking later searches', async t => {
  const { store } = await fixture(t);
  const controller = new AbortController();
  const previous = store.searchArchives('first', 100, controller.signal);
  controller.abort();
  await assert.rejects(previous, error => error.name === 'AbortError');
  assert.deepEqual(await store.searchArchives('second'), { hits: [], warnings: [] });
});


test('side member edit/remove/add/restart stays independent of global configuration and deletion', async t => {
  const { store, open } = await fixture(t);
  const parent = store.rooms[0], source = store.bots[0];
  store.saveSettings({ agentCapabilities: { [source.cliType]: { mode: 'selected', mcp: ['initial'], plugins: [] } } });
  const side = store.createSideChat(parent.id);
  assert.deepEqual(store.roomMembers(side)[0].nativeCapabilities.mcp, ['initial']);
  store.saveSettings({ agentCapabilities: { [source.cliType]: { mode: 'selected', mcp: ['later'], plugins: [] } } });
  assert.deepEqual(store.roomMembers(side)[0].nativeCapabilities.mcp, ['initial']);
  store.saveRoomMember(side.id, { id: source.id, name: 'Local', persona: 'LOCAL PERSONA' });
  const removed = store.saveRoom({ ...side, botIds: side.botIds.filter(id => id !== source.id) });
  assert.ok(!store.roomMembers(removed).some(bot => bot.id === source.id));
  assert.equal(store.bots[0].name, source.name);
  const added = store.saveRoom({ ...removed, botIds: [...removed.botIds, source.id] });
  assert.equal(store.roomMembers(added).find(bot => bot.id === source.id).persona, 'LOCAL PERSONA');
  store.deleteBot(source.id);
  const reopened = await open(), restored = reopened.rooms.find(room => room.id === side.id);
  assert.equal(reopened.roomMembers(restored).find(bot => bot.id === source.id).name, 'Local');
  const localNew = reopened.saveRoomMember(side.id, { name: 'Side only', cliType: 'codex', enabled: true });
  assert.ok(!reopened.bots.some(bot => bot.id === localNew.bot.id));
  assert.throws(() => reopened.saveRoomMember(parent.id, { id: source.id, name: 'bad' }), /侧聊/);
  assert.throws(() => reopened.saveRoomMember(side.id, { name: 'local', cliType: 'codex' }), /同名/);
});

test('room capability override applies only to that room and follows Agent default after removal', async t => {
  const { store, open } = await fixture(t), bot = store.bots[0];
  const first = store.rooms[0], second = store.saveRoom({ name: 'Second', botIds: [bot.id] });
  const choice = name => ({ mode: 'selected', mcp: [name], plugins: [] });
  store.saveSettings({ agentCapabilities: { [bot.cliType]: choice('agent') } });
  const updated = store.saveRoom({ id: first.id, memberCapabilities: { [bot.id]: choice('first') } });
  assert.deepEqual(store.roomMembers(updated)[0].nativeCapabilities.mcp, ['first']);
  assert.deepEqual(store.roomMembers(second)[0].nativeCapabilities.mcp, ['agent']);
  const reopened = await open();
  assert.deepEqual(reopened.roomMembers(reopened.rooms.find(room => room.id === first.id))[0].nativeCapabilities.mcp, ['first']);
  const cleared = reopened.saveRoom({ id: first.id, memberCapabilities: {} });
  assert.deepEqual(reopened.roomMembers(cleared)[0].nativeCapabilities.mcp, ['agent']);
});

test('global names are case-insensitively unique while legacy duplicates retain identity', async t => {
  const { store, dir, open } = await fixture(t), first = store.bots[0];
  const other = store.saveBot({ name: 'Alpha', cliType: 'codex' });
  assert.throws(() => store.saveBot({ name: ' alpha ', cliType: 'claude' }), /同名/);
  assert.throws(() => store.saveBot({ id: first.id, name: 'ALPHA' }), /同名/);
  const legacy = { ...other, id: 'legacy_duplicate' };
  fs.writeFileSync(path.join(dir, 'bots.json'), JSON.stringify([...store.bots, legacy]));
  const reopened = await open();
  assert.equal(reopened.bots.find(bot => bot.id === legacy.id).name, 'Alpha');
  assert.equal(reopened.saveBot({ id: legacy.id, persona: 'keep old identity' }).id, legacy.id);
});

test('local-only side members survive fork, detached parent and trash restore', async t => {
  const { store, open } = await fixture(t), parent = store.rooms[0];
  const side = store.createSideChat(parent.id);
  const { bot, room } = store.saveRoomMember(side.id, { name: 'Private', cliType: 'codex', enabled: true });
  store.addMessage(side.id, { id: 'local_msg', authorType: 'bot', authorId: bot.id, text: 'local', status: 'done' });
  const fork = store.forkRoomAt(side.id, 'local_msg');
  assert.equal(store.roomMembers(fork).find(member => member.id === bot.id).name, 'Private');
  const key = store.deleteRoom(side.id);
  store.deleteRoom(parent.id);
  const restoredId = store.restoreTrash(key);
  const reopened = await open(), restored = reopened.rooms.find(item => item.id === restoredId);
  assert.equal(reopened.roomMembers(restored).find(member => member.id === bot.id).name, 'Private');
  assert.equal(reopened.getMessages(restoredId)[0].authorId, bot.id);
  assert.equal(restored.parentRoomId, undefined);
  assert.equal(reopened.saveRoom({ id: restoredId, name: 'Restored detached side' }).memberProfiles[bot.id].name, 'Private');
});


test('changing a global member Agent clears old room overrides while side snapshots stay intact', async t => {
  const { store, open } = await fixture(t);
  const room = store.rooms[0], bot = store.bots.find(item => room.botIds.includes(item.id));
  store.saveBot({ ...bot, cliType: 'codex' });
  const selected = id => ({ mode: 'selected', mcp: [id], plugins: [] });
  store.saveSettings({ agentCapabilities: { claude: selected('claude-default') } });
  store.saveRoom({ id: room.id, memberCapabilities: { [bot.id]: selected('codex-override') } });
  const side = store.createSideChat(room.id);
  store.saveBot({ ...store.bots.find(item => item.id === bot.id), cliType: 'claude' });
  const reopened = await open();
  assert.deepEqual(reopened.roomMembers(reopened.rooms.find(item => item.id === room.id)).find(item => item.id === bot.id).nativeCapabilities.mcp, ['claude-default']);
  assert.deepEqual(reopened.roomMembers(reopened.rooms.find(item => item.id === side.id)).find(item => item.id === bot.id).nativeCapabilities.mcp, ['codex-override']);
});
