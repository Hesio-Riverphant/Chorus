'use strict';

// All fixtures live in a new OS temp directory; never read the user's data/logs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Persistence = require('../src/main/store/persistence').constructor;
const { readJson, writeJsonAtomic } = require('../src/main/store/jsonStore');
const { normalizeBotProfile, getDefaultPersona, ROLE_PRESETS, MAX_AVATAR_BYTES } = require('../src/shared/botProfile');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-persistence-'));
  const stores = [];
  t.after(() => {
    for (const store of stores) clearInterval(store.timer);
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('agent-room-persistence-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dir,
    async open() {
      const store = new Persistence();
      stores.push(store);
      await store.init({ isPackaged: true, getPath: () => dir });
      clearInterval(store.timer);
      return store;
    },
  };
}

test('edited private recipients remain stable after a member rename without regeneration', async t => {
  const f = fixture(t), store = await f.open(), room = store.rooms[0], [a, b] = store.bots;
  store.addMessage(room.id, { id: 'edit-private', roomId: room.id, authorType: 'human', text: `@${a.name} old`, status: 'done', audienceBotIds: [a.id], targetBotId: a.id });
  store.rewindRoom(room.id, 'edit-private', `@${b.name} new private content`);
  store.saveBot({ ...b, name: 'Renamed member' });
  const reopened = await f.open();
  const human = reopened.getMessage(room.id, 'edit-private');
  assert.deepEqual(human.audienceBotIds, [b.id]);
  const { selectTranscript } = require('../src/main/orchestrator/transcript');
  assert.equal(selectTranscript([human], a, reopened.bots).messages.length, 0);
  assert.equal(selectTranscript([human], reopened.bots.find(bot=>bot.id===b.id), reopened.bots).messages.length, 1);
});

test('replacing an executor host persists collaborator only in that room and its later snapshots', async (t) => {
  const f = fixture(t), store = await f.open();
  const [first, second] = store.bots;
  store.saveBot({ ...first, role: '执行者', customRole: false, persona: 'Keep these instructions' });
  const original = store.saveRoom({ ...store.rooms[0], botIds: [first.id, second.id], moderatorBotId: first.id });
  const other = store.saveRoom({ name: 'Other role room', botIds: original.botIds, moderatorBotId: second.id });
  const side = store.createSideChat(original.id);
  const changed = store.saveRoom({ ...original, moderatorBotId: second.id });
  assert.equal(store.roomMembers(changed).find(bot => bot.id === first.id).role, '协作者');
  assert.equal(store.roomMembers(changed).find(bot => bot.id === first.id).customRole, false);
  assert.equal(store.roomMembers(changed).find(bot => bot.id === first.id).persona, 'Keep these instructions');
  assert.equal(store.bots.find(bot => bot.id === first.id).role, '执行者');
  assert.equal(store.roomMembers(other).find(bot => bot.id === first.id).role, '执行者');
  assert.equal(store.roomMembers(side).find(bot => bot.id === first.id).role, '主持人');
  const reopened = await f.open();
  const persisted = reopened.rooms.find(room => room.id === original.id);
  assert.equal(reopened.roomMembers(persisted).find(bot => bot.id === first.id).role, '协作者');
  const newSide = reopened.createSideChat(persisted.id);
  assert.equal(reopened.roomMembers(newSide).find(bot => bot.id === first.id).role, '协作者');
  reopened.saveBot({ ...reopened.bots.find(bot => bot.id === first.id), role: '审查者' });
  const edited = reopened.saveRoom({ ...persisted, memberRoles: { ...persisted.memberRoles, [first.id]: null } });
  assert.equal(reopened.roomMembers(edited).find(bot => bot.id === first.id).role, '审查者');
  assert.equal(reopened.roomMembers(newSide).find(bot => bot.id === first.id).role, '协作者');
  const sideEdit = reopened.saveRoomMember(newSide.id, { id: first.id, role: '研究者' });
  assert.equal(reopened.roomMembers(sideEdit.room).find(bot => bot.id === first.id).role, '研究者');
  assert.equal(reopened.roomMembers(edited).find(bot => bot.id === first.id).role, '审查者');
  reopened.addMessage(edited.id, { id: 'role-fork', roomId: edited.id, status: 'done', text: 'checkpoint' });
  const branch = reopened.forkRoomAt(edited.id, 'role-fork');
  assert.equal(reopened.roomMembers(branch).find(bot => bot.id === first.id).role, '审查者');
  assert.throws(() => reopened.saveRoom({ ...edited, memberRoles: { [first.id]: { role: 123 } } }), /角色/);
});

test('member editor preserves explicit shared roles and isolates host checkbox demotions', async (t) => {
  const vm = require('node:vm');
  const code = fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8');
  for (const local of [false, true]) {
    const f = fixture(t), store = await f.open(), [first, second] = store.bots;
    store.saveBot({ ...first, role: '执行者' });
    const parent = store.saveRoom({ ...store.rooms[0], botIds: [first.id, second.id], moderatorBotId: first.id });
    const other = store.saveRoom({ name: 'Another shared room', botIds: [first.id, second.id], moderatorBotId: second.id });
    const room = local ? store.createSideChat(parent.id) : parent;
    const fields = new Map();
    const context = { botSaving: false, botEditVersion: 1, RoomProfiles: require('../src/shared/roomProfiles'),
      RoomUI: { ownsMembers: () => false },
      state: { rooms: structuredClone(store.rooms), bots: structuredClone(store.bots), editingBotRoomId: room.id, currentRoomId: room.id },
      $: selector => { if (!fields.has(selector)) fields.set(selector, {}); return fields.get(selector); },
      roomMembers: item => store.roomMembers(item),
      window: { api: { saveBot: async payload => store.saveBot(payload),
        saveRoomMember: async (id, payload) => store.saveRoomMember(id, payload),
        saveRoom: async payload => store.saveRoom(payload) } },
      I18n: { t: text => text, write: (node, render) => { node.textContent = render(); } },
      hideModal() {}, renderBots() {}, renderTopbar() {}, renderRooms() {}, renderBotManagement() {}, SideChatUI: { refresh() {} },
    };
    vm.createContext(context);
    vm.runInContext(code.slice(code.indexOf('async function saveBot()'), code.indexOf('\nasync function deleteBot()')), context);
    const save = async (id, role, moderator, edited = false) => {
      const profile = store.roomMembers(store.rooms.find(item => item.id === room.id)).find(bot => bot.id === id);
      context.state.editingBotId = id; context.state.botRoleEdited = edited;
      context.$('#f_name').value = profile.name; context.$('#f_moderator').checked = moderator;
      context.botFormPayload = () => ({ ...profile, role, customRole: false });
      await context.saveBot();
      assert.equal(context.$('#f_error').hidden, true, context.$('#f_error').textContent);
    };
    await save(second.id, '主持人', true);
    assert.equal(store.roomMembers(store.rooms.find(item => item.id === room.id)).find(bot => bot.id === first.id).role, '协作者');
    await save(first.id, '协作者', false);
    assert.equal(store.roomMembers(store.rooms.find(item => item.id === room.id)).find(bot => bot.id === first.id).role, '协作者');
    await save(first.id, '审查者', false, true);
    assert.equal(store.roomMembers(store.rooms.find(item => item.id === room.id)).find(bot => bot.id === first.id).role, '审查者');
    assert.equal(store.roomMembers(other).find(bot => bot.id === first.id).role, local ? '执行者' : '审查者');
    assert.equal(store.rooms.find(item => item.id === room.id).memberRoles?.[first.id], undefined);
    // An explicit role selection can demote the host and must retain that choice.
    await save(first.id, '主持人', true, true);
    await save(first.id, '研究者', false, true);
    assert.equal(store.roomMembers(store.rooms.find(item => item.id === room.id)).find(bot => bot.id === first.id).role, '研究者');
    // A checkbox-only demotion requests collaborator locally, preserving the shared role.
    await save(first.id, '主持人', true);
    await save(first.id, '协作者', false);
    assert.equal(store.roomMembers(store.rooms.find(item => item.id === room.id)).find(bot => bot.id === first.id).role, '协作者');
    const reopened = await f.open();
    assert.equal(reopened.roomMembers(reopened.rooms.find(item => item.id === room.id)).find(bot => bot.id === first.id).role, '协作者');
    assert.equal(reopened.bots.find(bot => bot.id === first.id).role, local ? '执行者' : '研究者');
  }
});

test('moderator checkbox resets prior role-edit intent so unchecking requests a local collaborator', () => {
  const vm = require('node:vm'), fields = new Map();
  const context = { state: { botRoleEdited: true }, window: {}, document: { addEventListener() {} },
    $: selector => {
      if (!fields.has(selector)) fields.set(selector, { events: {}, addEventListener(type, listener) { this.events[type] = listener; } });
      return fields.get(selector);
    } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/bot-ui.js'), 'utf8'), context);
  context.updatePersonaPlaceholder = () => {};
  context.wireBotProfile();
  context.$('#f_moderator').checked = false;
  context.$('#f_moderator').events.change();
  assert.equal(context.state.botRoleEdited, false);
  assert.equal(context.$('#f_rolePreset').value, '协作者');
  context.$('#f_rolePreset').value = '审查者';
  context.$('#f_rolePreset').events.change();
  assert.equal(context.state.botRoleEdited, true);
  assert.equal(context.$('#f_moderator').checked, false);
});

test('JSON read only defaults for missing files; corrupt data remains an error', (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, 'record.json');
  assert.deepEqual(readJson(file, []), []);
  fs.writeFileSync(file, '\uFEFF{"ok":true}');
  assert.deepEqual(readJson(file, null), { ok: true });
  fs.writeFileSync(file, '{broken');
  assert.throws(() => readJson(file, []), /JSON|读取/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});

test('startup rejects corrupt or structurally invalid records without overwriting them', async (t) => {
  for (const [filename, content] of [
    ['bots.json', '{broken'], ['bots.json', '{}'], ['rooms.json', 'null'],
    ['settings.json', '[]'], ['sessions.json', '[]'],
  ]) {
    const f = fixture(t);
    await f.open();
    const file = path.join(f.dir, filename);
    fs.writeFileSync(file, content);
    await assert.rejects(f.open());
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  }
});

test('missing bot registry must not replace existing room history with a new seed', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const roomId = store.rooms[0].id;
  fs.unlinkSync(path.join(f.dir, 'bots.json'));
  await assert.rejects(f.open());
  assert.equal(readJson(path.join(f.dir, 'rooms.json'), [])[0].id, roomId);
});

test('known legacy title migration preserves a backup, identity and user-defined names', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const legacy = '\u4e3b\u623f\u95f4\uff08\u5df2\u6062\u590d\uff09';
  const original = store.saveRoom({ ...store.rooms[0], name: legacy, recovered: true });
  const custom = store.saveRoom({ name: '我的工作间', recovered: true });
  store.addMessage(original.id, { id: 'title_fixture', roomId: original.id, text: 'retained' });
  const reopened = await f.open();
  assert.equal(reopened.rooms.find((room) => room.id === original.id).name, '主房间');
  assert.equal(reopened.rooms.find((room) => room.id === custom.id).name, '我的工作间');
  assert.equal(reopened.getMessages(original.id)[0].text, 'retained');
  const backup = path.join(f.dir, 'rooms-before-title-migration.json');
  assert.equal(readJson(backup, [])[0].name, legacy);
  const contents = fs.readFileSync(backup, 'utf8');
  await f.open();
  assert.equal(fs.readFileSync(backup, 'utf8'), contents);
});

test('accepted messages and terminal results survive restart without a timer flush', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const roomId = store.rooms[0].id;
  store.addMessage(roomId, { id: 'human', roomId, text: 'question', status: 'done' });
  store.addMessage(roomId, { id: 'reply', roomId, text: '', status: 'streaming' });
  store.updateMessage(roomId, 'reply', { text: 'answer', status: 'done' });
  const reopened = await f.open();
  assert.deepEqual(reopened.getMessages(roomId).map((m) => m.text), ['question', 'answer']);
});

test('persisted streaming messages recover as interrupted without losing text', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const roomId = store.rooms[0].id;
  store.addMessage(roomId, { id: 'reply', roomId, text: 'partial', status: 'streaming' });
  store.flushSync();
  const reopened = await f.open();
  assert.equal(reopened.getMessage(roomId, 'reply').status, 'aborted');
  assert.equal(reopened.getMessage(roomId, 'reply').text, 'partial');
});

test('deleted rooms stay deleted after restart and preserve their latest transcript in trash', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const roomId = store.rooms[0].id;
  store.addMessage(roomId, { id: 'reply', roomId, text: 'old', status: 'done' });
  store.flushSync();
  store.updateMessage(roomId, 'reply', { text: 'latest' });
  store.setSession(JSON.stringify([roomId, 'bot']), 'session');
  store.deleteRoom(roomId);
  store.flushSync();
  const reopened = await f.open();
  assert.equal(reopened.rooms.some((r) => r.id === roomId), false);
  assert.equal(reopened.dirty.has(roomId), false);
  assert.equal(reopened.getSessions()[JSON.stringify([roomId, 'bot'])], undefined);
  const trash = reopened.listTrash();
  assert.equal(trash.length, 1);
  const restored = reopened.restoreTrash(trash[0].key);
  assert.equal(reopened.getMessage(restored, 'reply').text, 'latest');
});

test('restoring a trash collision rewrites transcript room IDs', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const room = store.rooms[0];
  store.addMessage(room.id, { id: 'reply', roomId: room.id, text: 'kept', status: 'done' });
  store.deleteRoom(room.id);
  store.saveRoom(room);
  const restored = store.restoreTrash(store.listTrash()[0].key);
  assert.notEqual(restored, room.id);
  assert.equal(store.getMessage(restored, 'reply').roomId, restored);
});

test('clearing and archiving a room reset its CLI sessions only', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const roomId = store.rooms[0].id;
  store.setSession(JSON.stringify([roomId, 'bot']), 'stale');
  store.setSession(JSON.stringify(['other', 'bot']), 'keep');
  store.clearRoom(roomId);
  assert.equal(store.getSessions()[JSON.stringify([roomId, 'bot'])], undefined);
  assert.equal(store.getSessions()[JSON.stringify(['other', 'bot'])], 'keep');
  store.setSession(JSON.stringify([roomId, 'bot']), 'stale-again');
  store.addMessage(roomId, { id: 'reply', roomId, text: 'archive', status: 'done' });
  const archive = store.archiveCurrent(roomId);
  assert.equal(store.getSessions()[JSON.stringify([roomId, 'bot'])], undefined);
  store.restoreArchive(roomId, archive.id);
  assert.equal(store.getMessage(roomId, 'reply').text, 'archive');
});

test('failed settings/session writes leave previously committed memory intact', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const initialSettings = { ...store.getSettings() };
  const initialBot = { ...store.bots[0] };
  const initialRoom = { ...store.rooms[0] };
  const original = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('fixture write failure'), { code: 'EIO' }); };
  try {
    assert.throws(() => store.saveSettings({ tokenBudgetPerRun: 1 }), /fixture write failure/);
    assert.deepEqual(store.getSettings(), initialSettings);
    assert.throws(() => store.setSession('room:bot', 'new-session'), /fixture write failure/);
    assert.equal(store.getSessions()['room:bot'], undefined);
    assert.throws(() => store.saveBot({ id: initialBot.id, name: 'changed' }), /fixture write failure/);
    assert.deepEqual(store.bots[0], initialBot);
    assert.throws(() => store.saveRoom({ id: initialRoom.id, name: 'changed' }), /fixture write failure/);
    assert.deepEqual(store.rooms[0], initialRoom);
  } finally { fs.renameSync = original; }
  assert.equal(fs.readdirSync(f.dir).some((name) => name.includes('.tmp-')), false);
});

test('interrupted room deletion remains deleted and purging its trash cannot resurrect it', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const roomId = store.rooms[0].id;
  store.addMessage(roomId, { id: 'reply', roomId, text: 'kept in trash', status: 'done' });
  store.updateMessage(roomId, 'reply', { text: 'latest' });
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'messages', `${roomId}.json`)) throw new Error('fixture write failure');
    return original(from, to);
  };
  try { assert.throws(() => store.deleteRoom(roomId), /fixture write failure/); }
  finally { fs.renameSync = original; }
  store.flushSync();
  const reopened = await f.open();
  assert.equal(reopened.rooms.some((room) => room.id === roomId), false);
  reopened.purgeTrash(reopened.listTrash()[0].key);
  assert.equal((await f.open()).rooms.some((room) => room.id === roomId), false);
});

test('corrupt message content blocks startup and remains untouched', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const file = path.join(f.dir, 'messages', `${store.rooms[0].id}.json`);
  fs.writeFileSync(file, '{corrupt');
  await assert.rejects(f.open(), /JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt');
});

test('dirty flush continues other rooms, retains failed writes, and reports failure', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const first = store.rooms[0].id;
  const second = store.saveRoom({ name: 'second' }).id;
  for (const roomId of [first, second]) {
    store.addMessage(roomId, { id: roomId, roomId, text: 'initial', status: 'done' });
    store.updateMessage(roomId, roomId, { text: 'latest' });
  }
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'messages', `${first}.json`)) throw new Error('fixture write failure');
    return original(from, to);
  };
  try { assert.throws(() => store.flushSync(), /fixture write failure|持久化/); }
  finally { fs.renameSync = original; }
  assert.equal(store.dirty.has(first), true);
  assert.equal(store.dirty.has(second), false);
  assert.equal(readJson(path.join(f.dir, 'messages', `${second}.json`), [])[0].text, 'latest');
  store.flushSync();
  assert.equal(store.dirty.size, 0);
});

test('atomic write never damages a prior value when replacement fails', (t) => {
  const f = fixture(t);
  const file = path.join(f.dir, 'value.json');
  writeJsonAtomic(file, { old: true });
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('fixture write failure'); };
  try { assert.throws(() => writeJsonAtomic(file, { old: false }), /fixture write failure/); }
  finally { fs.renameSync = original; }
  assert.deepEqual(readJson(file, null), { old: true });
  assert.deepEqual(fs.readdirSync(f.dir), ['value.json']);
});

test('whole-room archive survives restart with identity, messages, members and sessions intact', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const room = { ...store.rooms[0] };
  const sessionKey = JSON.stringify([room.id, room.botIds[0]]);
  store.addMessage(room.id, { id: 'kept', roomId: room.id, text: 'history', status: 'done' });
  store.setSession(sessionKey, { id: 'cli-session', lastMessageId: 'kept' });
  const archived = store.setRoomArchived(room.id, true);
  assert.ok(archived.archivedAt > 0);
  assert.deepEqual({ ...archived, archivedAt: undefined }, { ...room, archivedAt: undefined });
  const reopened = await f.open();
  assert.equal(reopened.listRooms().length, 1);
  assert.equal(reopened.getInitial().rooms[0].id, room.id);
  assert.equal(reopened.getInitial().messagesByRoom[room.id][0].text, 'history');
  assert.deepEqual(reopened.getSessions()[sessionKey], { id: 'cli-session', lastMessageId: 'kept' });
  const active = reopened.setRoomArchived(room.id, false);
  assert.equal(active.archivedAt, null);
  assert.equal(active.name, room.name);
});

test('room archive rejects unknown IDs and failed writes leave memory unchanged', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  assert.throws(() => store.setRoomArchived('missing', true), /房间/);
  const before = { ...store.rooms[0] };
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('fixture write failure'); };
  try { assert.throws(() => store.setRoomArchived(before.id, true), /fixture write failure/); }
  finally { fs.renameSync = original; }
  assert.deepEqual(store.rooms[0], before);
});

async function roomWithArchive(f) {
  const store = await f.open();
  const room = store.rooms[0];
  store.addMessage(room.id, { id: 'old', roomId: room.id, text: 'old chat', status: 'done', createdAt: 1 });
  const arc = store.archiveCurrent(room.id);
  store.addMessage(room.id, { id: 'new', roomId: room.id, text: 'new chat', status: 'done', createdAt: 2 });
  return { store, room, arc };
}

test('delete and restore carry chat archives with the room, restoring archived rooms as active', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  store.setRoomArchived(room.id, true);
  store.deleteRoom(room.id);
  assert.equal(store.listArchives(room.id).length, 0);
  const reopened = await f.open();
  const trash = reopened.listTrash()[0];
  assert.equal(trash.archiveCount, 1);
  const restored = reopened.restoreTrash(trash.key);
  assert.equal(restored, room.id);
  assert.equal(reopened.listRooms()[0].archivedAt, null);
  assert.equal(reopened.getMessage(restored, 'new').text, 'new chat');
  assert.equal(reopened.getArchive(restored, arc.id).messages[0].text, 'old chat');
  reopened.restoreArchive(restored, arc.id);
  assert.deepEqual(reopened.getMessages(restored).map((m) => m.id), ['old', 'new']);
  assert.equal(reopened.listArchives(restored).length, 0);
});

test('trash ID collisions migrate archive and message room IDs without changing another room', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  store.saveRoom({ ...room, name: 'Research' });
  store.deleteRoom(room.id);
  store.saveRoom({ ...room, name: 'research' });
  const restored = store.restoreTrash(store.listTrash()[0].key);
  assert.notEqual(restored, room.id);
  assert.equal(store.rooms.find((r) => r.id === restored).name, 'Research (2)');
  const archive = store.getArchive(restored, arc.id);
  assert.equal(archive.roomId, restored);
  assert.equal(archive.messages[0].roomId, restored);
  assert.equal(store.getMessage(restored, 'new').roomId, restored);
  assert.equal(store.rooms.find((r) => r.id === room.id).name, 'research');
});

test('legacy trash without bundled archives restores old archives left in their original directory', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  const archive = store.getArchive(room.id, arc.id);
  store.deleteRoom(room.id);
  const trash = store.listTrash()[0];
  const bundle = path.join(f.dir, 'trash', trash.key, 'archives.json');
  if (fs.existsSync(bundle)) fs.unlinkSync(bundle);
  writeJsonAtomic(path.join(f.dir, 'archives', room.id, `${arc.id}.json`), archive);
  const restored = store.restoreTrash(trash.key);
  assert.equal(store.getArchive(restored, arc.id).messages[0].text, 'old chat');
});

test('failed archive snapshot preserves the active room and original history', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.basename(to) === 'archives.json') throw new Error('fixture archive snapshot failure');
    return original(from, to);
  };
  try { assert.throws(() => store.deleteRoom(room.id), /fixture archive snapshot failure/); }
  finally { fs.renameSync = original; }
  assert.equal(store.listRooms()[0].id, room.id);
  assert.equal(store.getArchive(room.id, arc.id).messages[0].text, 'old chat');
  assert.equal(store.getMessage(room.id, 'new').text, 'new chat');
  assert.equal(store.listTrash().length, 0);
});

test('restore write failure preserves bundled archives for a later retry', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  store.deleteRoom(room.id);
  const key = store.listTrash()[0].key;
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (path.basename(to) === `${arc.id}.json`) throw new Error('fixture archive restore failure');
    return original(from, to);
  };
  try { assert.throws(() => store.restoreTrash(key), /fixture archive restore failure/); }
  finally { fs.renameSync = original; }
  const reopened = await f.open();
  assert.equal(reopened.listTrash().length, 1);
  const restored = reopened.restoreTrash(key);
  assert.equal(reopened.getArchive(restored, arc.id).messages[0].text, 'old chat');
});

test('case-insensitive migration and orphan recovery use neutral names', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const first = { ...store.rooms[0], name: 'Case' };
  writeJsonAtomic(path.join(f.dir, 'rooms.json'), [first, { ...first, id: 'other', name: 'case' }]);
  writeJsonAtomic(path.join(f.dir, 'messages', 'orphan.json'), [{ id: 'orphan-message', text: 'kept' }]);
  const reopened = await f.open();
  assert.deepEqual(reopened.listRooms().map((r) => r.name), ['Case', 'case (2)', '房间']);
  assert.equal(reopened.listRooms().find((r) => r.id === 'orphan').recovered, true);
});

test('interrupted archive cleanup after deletion keeps a recoverable complete trash snapshot', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  const original = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === path.join(f.dir, 'archives', room.id, `${arc.id}.json`)) throw new Error('fixture cleanup failure');
    return original(target, options);
  };
  try { assert.throws(() => store.deleteRoom(room.id), /fixture cleanup failure/); }
  finally { fs.rmSync = original; }
  const reopened = await f.open();
  assert.equal(reopened.rooms.length, 0);
  const restored = reopened.restoreTrash(reopened.listTrash()[0].key);
  assert.equal(reopened.getArchive(restored, arc.id).messages[0].text, 'old chat');
});

test('failed restore commit retries with the same target ID after restart', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  store.deleteRoom(room.id);
  store.saveRoom(room); // Force a new target ID.
  const key = store.listTrash()[0].key;
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'rooms.json')) throw new Error('fixture commit failure');
    return original(from, to);
  };
  try { assert.throws(() => store.restoreTrash(key), /fixture commit failure/); }
  finally { fs.renameSync = original; }
  const targetId = readJson(path.join(f.dir, 'trash', key, 'restore.json'), null).id;
  const reopened = await f.open();
  assert.equal(reopened.rooms.length, 1);
  assert.equal(reopened.restoreTrash(key), targetId);
  assert.equal(reopened.getArchive(targetId, arc.id).roomId, targetId);
  assert.equal(reopened.rooms.length, 2);
});

test('restore cleanup failure retries without duplicating rooms or overwriting newer messages', async (t) => {
  const f = fixture(t);
  const { store, room } = await roomWithArchive(f);
  store.deleteRoom(room.id);
  const key = store.listTrash()[0].key;
  const original = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (target === path.join(f.dir, 'trash', key)) throw new Error('fixture cleanup failure');
    return original(target, options);
  };
  try { assert.throws(() => store.restoreTrash(key), /fixture cleanup failure/); }
  finally { fs.rmSync = original; }
  store.addMessage(room.id, { id: 'newer', roomId: room.id, text: 'after restore', status: 'done' });
  const reopened = await f.open();
  assert.equal(reopened.restoreTrash(key), room.id);
  assert.equal(reopened.rooms.length, 1);
  assert.equal(reopened.getMessage(room.id, 'newer').text, 'after restore');
  assert.equal(reopened.listTrash().length, 0);
});

test('purging a failed restore also clears staged target archives without touching live rooms', async (t) => {
  const f = fixture(t);
  const { store, room } = await roomWithArchive(f);
  store.deleteRoom(room.id);
  store.saveRoom(room);
  const key = store.listTrash()[0].key;
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'rooms.json')) throw new Error('fixture commit failure');
    return original(from, to);
  };
  try { assert.throws(() => store.restoreTrash(key), /fixture commit failure/); }
  finally { fs.renameSync = original; }
  const targetId = readJson(path.join(f.dir, 'trash', key, 'restore.json'), null).id;
  store.purgeTrash(key);
  const reopened = await f.open();
  assert.equal(reopened.rooms.length, 1);
  assert.equal(reopened.rooms[0].id, room.id);
  assert.equal(reopened.listArchives(targetId).length, 0);
});

test('permanent deletion removes live room, sessions and archived chats after restart', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  store.setSession(JSON.stringify([room.id, 'bot']), 'session');
  store.permanentDeleteRoom(room.id);
  const reopened = await f.open();
  assert.equal(reopened.listRooms().some((item) => item.id === room.id), false);
  assert.equal(reopened.getArchive(room.id, arc.id), null);
  assert.equal(reopened.listTrash().length, 0);
  assert.equal(reopened.getSessions()[JSON.stringify([room.id, 'bot'])], undefined);
});

test('failed permanent purge retains its complete snapshot for restoration', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  const original = fs.rmSync;
  fs.rmSync = (target, options) => {
    if (path.dirname(target) === path.join(f.dir, 'trash')) throw new Error('fixture purge failure');
    return original(target, options);
  };
  try { assert.throws(() => store.permanentDeleteRoom(room.id), /fixture purge failure/); }
  finally { fs.rmSync = original; }
  const reopened = await f.open();
  const trash = reopened.listTrash();
  assert.equal(trash.length, 1);
  const restored = reopened.restoreTrash(trash[0].key);
  assert.equal(reopened.getArchive(restored, arc.id).messages[0].text, 'old chat');
});

test('display order persists separately from dispatch order and rejects invalid members', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const room = store.rooms[0];
  const originalOrder = [...room.botIds];
  const displayOrder = [...originalOrder].reverse();
  store.setMemberDisplayOrder(room.id, displayOrder);
  assert.deepEqual(store.rooms[0].botIds, originalOrder);
  assert.deepEqual((await f.open()).rooms[0].memberDisplayOrder, displayOrder);
  assert.throws(() => store.setMemberDisplayOrder(room.id, ['foreign']), /排序/);
  assert.throws(() => store.setMemberDisplayOrder(room.id, [originalOrder[0], originalOrder[0]]), /排序/);
  assert.throws(() => store.setMemberDisplayOrder('missing', []), /房间/);
  assert.deepEqual(store.rooms[0].memberDisplayOrder, displayOrder);
});

test('bot profile preserves explicit persona, defaults empty persona at use time and validates pricing', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const bot = store.bots[0];
  const saved = store.saveBot({ id: bot.id, role: '研究者', persona: '',
    avatar: { type: 'text', text: '研' },
    pricing: { enabled: true, model: 'local-model', inputPerMillion: 0, outputPerMillion: 2 } });
  assert.equal(saved.persona, '');
  assert.equal(getDefaultPersona(saved.role), ROLE_PRESETS.find((item) => item.value === '研究者').persona);
  assert.equal(normalizeBotProfile({ role: '研究者', persona: 'explicit' }).persona, 'explicit');
  assert.deepEqual((await f.open()).bots[0].pricing, saved.pricing);
  for (const invalid of [NaN, Infinity, -1, '1', null]) {
    assert.throws(() => store.saveBot({ id: bot.id,
      pricing: { enabled: true, model: 'x', inputPerMillion: invalid, outputPerMillion: 1 } }), /单价/);
  }
  assert.throws(() => store.saveBot({ id: bot.id, role: {} }), /角色/);
  assert.throws(() => store.saveBot({ id: bot.id, persona: [] }), /指令/);
  assert.deepEqual(store.bots[0], saved);
});

test('avatar contract accepts bounded image data and rejects URL, HTML and mismatched image type', () => {
  const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP1cAAAAASUVORK5CYII=';
  assert.equal(normalizeBotProfile({ avatar: { type: 'image', dataUrl } }).avatar.dataUrl, dataUrl);
  assert.deepEqual(normalizeBotProfile({ avatar: { type: 'provider', provider: 'codex' } }).avatar,
    { type: 'provider', provider: 'codex' });
  for (const avatar of [
    { type: 'image', dataUrl: 'https://example.test/avatar.png' },
    { type: 'image', dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { type: 'image', dataUrl: dataUrl.replace('png', 'webp') },
    { type: 'provider', provider: 'foreign' }, { type: 'text', text: '123456789' },
    { type: 'image', dataUrl: 'data:image/png;base64,' + Buffer.alloc(MAX_AVATAR_BYTES + 1).toString('base64') },
  ]) assert.throws(() => normalizeBotProfile({ avatar }), /头像/);
});

test('rewind edits the selected human in place, discards later chat and resets sessions without new archives', async (t) => {
  const f = fixture(t);
  const { store, room, arc } = await roomWithArchive(f);
  store.addMessage(room.id, { id: 'question', roomId: room.id, authorType: 'human', text: '@A original', status: 'done',
    audienceBotIds: ['a'], targetBotId: 'a', modeTargetIds: ['a'], roundRun: { id: 'old-run' } });
  store.addMessage(room.id, { id: 'answer', roomId: room.id, authorType: 'bot', text: 'future', status: 'done' });
  store.setSession(JSON.stringify([room.id, 'bot']), { id: 'future-session' });
  const result = store.rewindRoom(room.id, 'question', 'edited');
  assert.deepEqual(result.map((message) => message.id), ['new', 'question']);
  assert.equal(result.at(-1).text, 'edited');
  assert.ok(result.at(-1).updatedAt);
  assert.equal(result.at(-1).audienceBotIds, undefined);
  assert.equal(result.at(-1).targetBotId, undefined);
  assert.equal(result.at(-1).roundRun, undefined);
  assert.equal(store.getSessions()[JSON.stringify([room.id, 'bot'])], undefined);
  assert.deepEqual(store.listArchives(room.id).map((record) => record.id), [arc.id]);
  const reopened = await f.open();
  assert.equal(reopened.getMessage(room.id, 'answer'), null);
  assert.equal(reopened.getMessage(room.id, 'question').text, 'edited');
  assert.throws(() => reopened.rewindRoom(room.id, 'new', 'x'), /人类消息/);
  assert.throws(() => reopened.rewindRoom(room.id, 'question', ' '), /不能为空/);
});

test('failed rewind retains transcript but invalidates stale CLI sessions before retry', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const room = store.rooms[0];
  store.addMessage(room.id, { id: 'human', text: 'original', authorType: 'human', status: 'done' });
  store.addMessage(room.id, { id: 'later', text: 'later', status: 'done' });
  store.setSession(JSON.stringify([room.id, 'bot']), 'stale');
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'messages', `${room.id}.json`)) throw new Error('fixture rewind failure');
    return original(from, to);
  };
  try { assert.throws(() => store.rewindRoom(room.id, 'human', 'edited'), /fixture rewind failure/); }
  finally { fs.renameSync = original; }
  assert.equal(store.getMessage(room.id, 'human').text, 'original');
  assert.ok(store.getMessage(room.id, 'later'));
  assert.equal(store.getSessions()[JSON.stringify([room.id, 'bot'])], undefined);
});

test('fork creates independent IDs and remaps references while preserving original room and sessions', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const room = store.rooms[0];
  store.addMessage(room.id, { id: 'human', roomId: room.id, text: 'question', authorType: 'human', status: 'done' });
  store.addMessage(room.id, { id: 'bot', roomId: room.id, text: 'answer', status: 'done', roundId: 'human', replyToId: 'human', supersededBy: 'later' });
  store.addMessage(room.id, { id: 'later', roomId: room.id, text: 'later', status: 'done' });
  store.addAnnotation(room.id, 'human', { start: 0, end: 4, quote: 'ques', note: 'private' });
  store.setSession(JSON.stringify([room.id, room.botIds[0]]), 'original-session');
  const branch = store.forkRoomAt(room.id, 'bot');
  assert.notEqual(branch.id, room.id);
  assert.deepEqual(branch.botIds, room.botIds);
  const messages = store.getMessages(branch.id);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => !['human', 'bot', 'later'].includes(message.id) && message.roomId === branch.id));
  assert.equal(messages[1].roundId, messages[0].id);
  assert.equal(messages[1].replyToId, messages[0].id);
  assert.equal(messages[1].supersededBy, undefined);
  assert.equal(messages[0].annotations[0].messageId, messages[0].id);
  assert.equal(store.getSessions()[JSON.stringify([branch.id, room.botIds[0]])], undefined);
  assert.equal(store.getSessions()[JSON.stringify([room.id, room.botIds[0]])], 'original-session');
  assert.equal(store.getMessages(room.id).length, 3);
  assert.equal((await f.open()).getMessages(branch.id).length, 2);
});

test('annotations validate selected original text, persist immediately and remain private metadata', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const room = store.rooms[0];
  store.addMessage(room.id, { id: 'human', text: '中文 example', authorType: 'human', status: 'done' });
  for (const bad of [
    { start: -1, end: 2, quote: '中文', note: 'x' },
    { start: 0, end: 2, quote: 'wrong', note: 'x' },
    { start: 0, end: 2, quote: '中文', note: '' },
  ]) assert.throws(() => store.addAnnotation(room.id, 'human', bad), /批注/);
  const note = store.addAnnotation(room.id, 'human', { start: 0, end: 2, quote: '中文', note: 'private' });
  const reopened = await f.open();
  assert.equal(reopened.getMessage(room.id, 'human').annotations[0].note, 'private');
  assert.equal(reopened.getMessage(room.id, 'human').text, '中文 example');
  reopened.rewindRoom(room.id, 'human', 'changed');
  assert.equal(reopened.getMessage(room.id, 'human').annotations[0].detached, true);
  assert.equal(reopened.removeAnnotation(room.id, 'human', note.id), true);
  assert.equal(reopened.removeAnnotation(room.id, 'human', note.id), false);
  assert.deepEqual((await f.open()).getMessage(room.id, 'human').annotations, []);
});

test('failed fork commit leaves original history and no spurious branch after restart', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const room = store.rooms[0];
  store.addMessage(room.id, { id: 'human', text: 'source', authorType: 'human', status: 'done' });
  const original = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to === path.join(f.dir, 'rooms.json')) throw new Error('fixture fork failure');
    return original(from, to);
  };
  try { assert.throws(() => store.forkRoomAt(room.id, 'human'), /fixture fork failure/); }
  finally { fs.renameSync = original; }
  const reopened = await f.open();
  assert.equal(reopened.rooms.length, 1);
  assert.equal(reopened.getMessage(room.id, 'human').text, 'source');
});

test('annotation write failure never reports an in-memory annotation as saved', async (t) => {
  const f = fixture(t);
  const store = await f.open();
  const room = store.rooms[0];
  store.addMessage(room.id, { id: 'human', text: 'source', status: 'done' });
  const original = fs.renameSync;
  fs.renameSync = () => { throw new Error('fixture annotation failure'); };
  try {
    assert.throws(() => store.addAnnotation(room.id, 'human', { start: 0, end: 6, quote: 'source', note: 'note' }),
      /fixture annotation failure/);
  } finally { fs.renameSync = original; }
  assert.equal(store.getMessage(room.id, 'human').annotations, undefined);
});

test('bot profile browser script exposes the same persona and avatar contract', () => {
  const vm = require('node:vm');
  const context = { atob: (value) => Buffer.from(value, 'base64').toString('binary') };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/shared/botProfile.js'), 'utf8'), context);
  assert.equal(context.BotProfile.getDefaultPersona('审查者'), getDefaultPersona('审查者'));
  assert.equal(context.BotProfile.normalizeAvatar({ type: 'provider', provider: 'claude' }).provider, 'claude');
});

test('bot profile rejects malformed model identifiers before persistence', () => {
  const { normalizeBotProfile } = require('../src/shared/botProfile');
  for (const model of [17, null, 'model & command', 'with space', '-flag', 'x'.repeat(201)]) {
    assert.throws(() => normalizeBotProfile({ model }), /模型标识/);
  }
  assert.equal(normalizeBotProfile({ model: 'provider/model-v1:latest' }).model, 'provider/model-v1:latest');
});


test('reported soft budget limits validate before persistence and survive restart', async t => {
  const f = fixture(t), store = await f.open();
  store.saveSettings({ tokenBudgetPerRun: 12345, costBudgetPerRun: 0.125 });
  for (const patch of [{ tokenBudgetPerRun: -1 }, { tokenBudgetPerRun: 1.5 }, { tokenBudgetPerRun: 1e13 },
    { costBudgetPerRun: Infinity }, { costBudgetPerRun: -1 }, { costBudgetPerRun: '1' }]) assert.throws(() => store.saveSettings(patch));
  const reopened = await f.open();
  assert.equal(reopened.getSettings().tokenBudgetPerRun, 12345); assert.equal(reopened.getSettings().costBudgetPerRun, 0.125);
  reopened.saveSettings({ tokenBudgetPerRun: null, costBudgetPerRun: 0 });
  assert.equal(reopened.getSettings().tokenBudgetPerRun, 0);
});
