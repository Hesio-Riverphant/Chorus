'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const Navigation = require('../src/renderer/navigation-ui');
const Persistence = require('../src/main/store/persistence').constructor;

test('navigation groups rooms by effective project path and keeps independent side chats nested', () => {
  const rooms = [
    { id: 'a', cwd: 'D:\\Project\\one' },
    { id: 'b', cwd: 'd:/Project/two/../one/' },
    { id: 'side', parentRoomId: 'a', cwd: 'D:\\Project\\one' },
    { id: 'default', cwd: '' },
    { id: 'archived', cwd: 'D:/other', archivedAt: 10 },
  ];
  const groups = Navigation.groups(rooms, { defaultCwd: 'D:/default' }, 'D:/app');
  assert.equal(groups.length, 2);
  assert.equal(groups[0].label, 'one');
  assert.deepEqual(groups[0].entries.map(entry => [entry.room.id, entry.depth]), [['a', 0], ['side', 1], ['b', 0]]);
  assert.equal(groups[1].path, 'D:/default');
  assert.equal(Navigation.groups([{ id: 'fallback' }], {}, 'D:/app')[0].path, 'D:/app');
  assert.equal(Navigation.pathKey('C:\\'), Navigation.pathKey('c:/'));
  assert.notEqual(Navigation.pathKey('/src/Project'), Navigation.pathKey('/src/project'));
});

test('pinned category has each pinned room once, preserving unpinned children and orphan side chats', () => {
  const rooms = [
    { id: 'a', cwd: 'D:/project', pinnedAt: 1 },
    { id: 'side', parentRoomId: 'a', cwd: 'D:/project' },
    { id: 'pinnedSide', parentRoomId: 'a', cwd: 'D:/project', pinnedAt: 2 },
    { id: 'b', cwd: 'D:/project' },
    { id: 'c', cwd: 'D:/old', archivedAt: 1 },
    { id: 'orphan', parentRoomId: 'c', cwd: 'D:/old' },
  ];
  const groups = Navigation.groups(rooms);
  assert.equal(groups[0].id, 'pinned');
  assert.deepEqual(groups[0].entries.map(entry => entry.room.id), ['a', 'side', 'pinnedSide']);
  assert.deepEqual(groups.flatMap(group => group.entries).map(entry => entry.room.id).sort(), ['a', 'b', 'orphan', 'pinnedSide', 'side']);
  assert.equal(groups.at(-1).entries[0].room.id, 'orphan');
  assert.equal(groups.at(-1).entries[0].depth, 0);
});

test('room moves preserve project, parent, pinned state and other category order', () => {
  const rooms = [
    { id: 'a', cwd: 'D:/one' }, { id: 'b', cwd: 'D:/one' },
    { id: 'c', cwd: 'D:/two' },
    { id: 'side1', cwd: 'D:/one', parentRoomId: 'a' }, { id: 'side2', cwd: 'D:/one', parentRoomId: 'a' },
    { id: 'pin1', cwd: 'D:/two', pinnedAt: 1 }, { id: 'pin2', cwd: 'D:/one', pinnedAt: 2 },
  ];
  const original = JSON.stringify(rooms);
  const roomDisplayOrder = Navigation.move(rooms, {}, '', 'b', 'a');
  assert.deepEqual(roomDisplayOrder.slice(0, 3), ['b', 'a', 'c']);
  assert.equal(Navigation.move(rooms, {}, '', 'a', 'c'), null);
  assert.equal(Navigation.move(rooms, {}, '', 'a', 'pin1'), null);
  assert.equal(Navigation.move(rooms, {}, '', 'a', 'side1'), null);
  assert.equal(Navigation.move(rooms, {}, '', 'missing', 'a'), null);
  const sideOrder = Navigation.move(rooms, { roomDisplayOrder }, '', 'side2', 'side1');
  const sideEntries = Navigation.groups(rooms, { roomDisplayOrder: sideOrder }).flatMap(group => group.entries).filter(entry => entry.depth);
  assert.deepEqual(sideEntries.map(entry => entry.room.id), ['side2', 'side1']);
  const pinOrder = Navigation.move(rooms, {}, '', 'pin1', 'pin2', true);
  assert.deepEqual(Navigation.groups(rooms, { roomDisplayOrder: pinOrder })[0].entries.map(entry => entry.room.id), ['pin2', 'pin1']);
  assert.equal(JSON.stringify(rooms), original);
  const interleaved = [{ id: 'x', cwd: 'D:/first' }, { id: 'y', cwd: 'D:/second' }, { id: 'z', cwd: 'D:/first' }];
  const reordered = Navigation.move(interleaved, {}, '', 'x', 'z', true);
  assert.deepEqual(Navigation.groups(interleaved, { roomDisplayOrder: reordered }).map(group => group.path), ['D:/first', 'D:/second']);
});

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-navigation-'));
  const stores = [];
  const open = async () => {
    const store = new Persistence(); stores.push(store);
    await store.init({ isPackaged: true, getPath: () => dir });
    clearInterval(store.timer); return store;
  };
  t.after(() => {
    for (const store of stores) clearInterval(store.timer);
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('convoke-navigation-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, open, store: await open() };
}

test('navigation changes persist across restart without changing rooms, members, messages or runtime settings', async t => {
  const f = await fixture(t), { store } = f;
  const first = store.rooms[0], second = store.saveRoom({ name: 'Two', cwd: 'D:/two' });
  store.addMessage(first.id, { id: 'm', text: 'retained', status: 'done' });
  const snapshot = JSON.stringify({ rooms: store.rooms, bots: store.bots, sessions: store.sessions, messages: store.getMessages(first.id) });
  const oldCatchup = store.settings.catchupMessages;
  store.saveNavigation({ roomDisplayOrder: [second.id, first.id], navigationCollapsedGroups: ['pinned', 'project:d:/two'] });
  assert.equal(JSON.stringify({ rooms: store.rooms, bots: store.bots, sessions: store.sessions, messages: store.getMessages(first.id) }), snapshot);
  assert.equal(store.settings.catchupMessages, oldCatchup);
  const reopened = await f.open();
  assert.deepEqual(reopened.settings.roomDisplayOrder, [second.id, first.id]);
  assert.deepEqual(reopened.settings.navigationCollapsedGroups, ['pinned', 'project:d:/two']);
  assert.equal(reopened.getMessages(first.id)[0].text, 'retained');
  assert.deepEqual(reopened.rooms.map(room => room.id), [first.id, second.id]);
});

test('navigation rejects unknown room IDs, duplicates and attempts to change execution settings atomically', async t => {
  const { store, dir } = await fixture(t);
  const previous = fs.readFileSync(path.join(dir, 'settings.json'), 'utf8');
  const first = store.rooms[0].id;
  for (const invalid of [
    null, [], { catchupMessages: 0 }, { roomDisplayOrder: [first, first] }, { roomDisplayOrder: ['unknown'] },
    { navigationCollapsedGroups: ['pinned', 'pinned'] }, { navigationCollapsedGroups: ['parent:any'] },
    { navigationCollapsedGroups: ['project:x\0y'] }, { navigationCollapsedGroups: ['project:' + 'x'.repeat(32769)] },
  ]) assert.throws(() => store.saveNavigation(invalid));
  assert.equal(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'), previous);
});

test('saving a partial order includes newly created rooms and preserves other display preferences', async t => {
  const { store } = await fixture(t);
  const first = store.rooms[0].id;
  store.saveNavigation({ navigationCollapsedGroups: ['pinned'] });
  const second = store.saveRoom({ name: 'Second' }).id;
  assert.deepEqual(store.saveNavigation({ roomDisplayOrder: [second] }).roomDisplayOrder, [second, first]);
  assert.deepEqual(store.settings.navigationCollapsedGroups, ['pinned']);
  store.saveSettings({ costMode: 'none' });
  assert.deepEqual(store.settings.roomDisplayOrder, [second, first]);
});

test('project pinning persists and orders projects without moving any room or cwd', async t => {
  const { store, open } = await fixture(t);
  const a = store.saveRoom({ name: 'A', cwd: 'D:/one' }), b = store.saveRoom({ name: 'B', cwd: 'D:/two' });
  store.saveNavigation({ pinnedProjects: ['project:d:/two'] });
  const reopened = await open();
  assert.equal(Navigation.groups([a, b], reopened.settings)[0].path, 'D:/two');
  assert.equal(reopened.rooms.find(room => room.id === a.id).cwd, 'D:/one');
  for (const value of ['bad', ['x'], ['project:a', 'project:a']]) assert.throws(() => store.saveNavigation({ pinnedProjects: value }));
});

test('project archive commits as one registry update and failed write preserves all active rooms', async t => {
  const { store, dir } = await fixture(t);
  const parent = store.rooms[0], side = store.createSideChat(parent.id);
  const original = JSON.stringify(store.rooms), rename = fs.renameSync;
  fs.renameSync = (from, to) => { if (to === path.join(dir, 'rooms.json')) throw new Error('fixture write failure'); return rename(from, to); };
  try { assert.throws(() => store.archiveRooms([parent.id, side.id]), /fixture write failure/); }
  finally { fs.renameSync = rename; }
  assert.equal(JSON.stringify(store.rooms), original);
  store.archiveRooms([parent.id, side.id]);
  assert.ok(store.rooms.filter(room => [parent.id, side.id].includes(room.id)).every(room => room.archivedAt));
});
