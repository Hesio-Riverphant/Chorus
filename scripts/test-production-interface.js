'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Queries = require('../src/renderer/conversation-ui');
const Navigation = require('../src/renderer/navigation-ui');
const Persistence = require('../src/main/store/persistence').constructor;

test('conversation search finds body text across main, side and archived rooms with exact message identities', () => {
  const rooms = [{ id: 'main', name: 'Main' }, { id: 'side', name: 'Side', parentRoomId: 'main' }, { id: 'old', name: 'Old', archivedAt: 1 }];
  const data = { main: [{ id: 'a', text: 'Needle needle', createdAt: 1 }], side: [{ id: 'b', text: 'needle', createdAt: 3 }], old: [{ id: 'c', text: 'NEEDLE', createdAt: 2 }] };
  assert.deepEqual(Queries.search(rooms, data, ' Needle ').map(hit => [hit.roomId, hit.messageId]), [['side', 'b'], ['old', 'c'], ['main', 'a']]);
  assert.equal(Queries.search(rooms, data, 'needle', 2).length, 2);
  assert.equal(Queries.search(rooms, data, '') .length, 0);
  assert.equal(Queries.search(rooms, data, '<script>') .length, 0);
  assert.equal(data.main[0].text, 'Needle needle');
});

test('timing uses real start/end boundaries, never accumulates offline time or fabricates historical duration', () => {
  const human = { id: 'h', roundRun: { startedAt: 1000, endedAt: 62000, status: 'stopped' } };
  assert.equal(Queries.timing(human, null, 900000).label, '用时 01:01 · 已取消');
  assert.equal(Queries.timing(human, { roundId: 'h', startedAt: 1000, status: 'running' }, 4000).label, '用时 00:03 · 运行中');
  assert.equal(Queries.timing(human, { roundId: 'other', startedAt: 0, status: 'running' }, 4000).label, '用时 01:01 · 已取消');
  assert.match(Queries.timing({ id: 'old' }).label, /耗时未记录/);
  assert.equal(Queries.timing({ roundRun: { startedAt: 1, endedAt: null, status: 'interrupted' } }, null, 10000).label, '未记录完整耗时 · 意外中断');
});

test('public progress remains searchable after phase separation without searching hidden tool payloads', () => {
  const rooms = [{ id: 'r', name: 'Room' }];
  const data = { r: [{ id: 'answer', text: 'Final answer', activities: [
    { phase: 'commentary', detail: 'public-progress-needle', order: 0 },
    { kind: 'tool', detail: 'internal-tool-needle', order: 1 },
  ] }] };
  assert.equal(Queries.search(rooms, data, 'public-progress-needle')[0].processMatch, true);
  assert.equal(Queries.search(rooms, data, 'Final answer')[0].processMatch, false);
  assert.equal(Queries.search(rooms, data, 'internal-tool-needle').length, 0);
});

test('project display names survive restart without changing cwd and malformed names fail atomically', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-interface-'));
  const stores = [];
  t.after(() => { for (const store of stores) clearInterval(store.timer); assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
  const open = async () => { const store = new Persistence(); stores.push(store); await store.init({ isPackaged: true, getPath: () => directory }); clearInterval(store.timer); return store; };
  const store = await open();
  const room = store.saveRoom({ name: 'Room', cwd: 'D:/demo' });
  store.saveNavigation({ projectDisplayNames: { 'project:d:/demo': 'My project' } });
  store.saveSettings({ autoCollapseProcess: false });
  assert.throws(() => store.saveSettings({ autoCollapseProcess: 'false' }));
  store.addMessage(room.id, { id: 'unfinished', authorType: 'human', status: 'done', text: 'retained', roundRun: { startedAt: 100, status: 'running', endedAt: null } });
  const settingsBefore = JSON.stringify(store.settings);
  for (const names of [[], { 'pinned': 'Oops' }, { 'project:x': '' }, { 'project:x': 'a\nb' }, { 'project:x': 'x'.repeat(121) }]) {
    assert.throws(() => store.saveNavigation({ projectDisplayNames: names }));
    assert.equal(JSON.stringify(store.settings), settingsBefore);
  }
  const reopened = await open();
  assert.equal(reopened.settings.autoCollapseProcess, false);
  assert.equal(reopened.rooms.find(item => item.id === room.id).cwd, 'D:/demo');
  assert.equal(Navigation.groups([room], reopened.settings)[0].label, 'My project');
  assert.equal(reopened.getMessage(room.id, 'unfinished').roundRun.status, 'interrupted');
  assert.equal(reopened.getMessage(room.id, 'unfinished').roundRun.endedAt, null);
});


test('public output can fold only after a conclusion and respects the saved preference and manual choice', () => {
  const message = { roundId: 'r', authorType: 'bot', status: 'streaming', text: 'partial', activities: [{ phase: 'commentary', detail: 'process' }] };
  assert.deepEqual(Queries.processState('r', [message], true, false), { canCollapse: false, open: true });
  message.finalAnswer = true;
  assert.deepEqual(Queries.processState('r', [message], true), { canCollapse: true, open: false });
  assert.deepEqual(Queries.processState('r', [message], false), { canCollapse: true, open: true });
  assert.deepEqual(Queries.processState('r', [message], true, true), { canCollapse: true, open: true });
  assert.deepEqual(Queries.processState('r', [message], false, false), { canCollapse: true, open: false });
  assert.deepEqual(Queries.processState('r', [message, { ...message, finalAnswer: false }], true), { canCollapse: false, open: true });
  message.finalAnswer = false; message.status = 'error';
  assert.deepEqual(Queries.processState('r', [message], true), { canCollapse: false, open: true });
  message.status = 'done';
  assert.deepEqual(Queries.processState('r', [message], true), { canCollapse: true, open: false });
});


test('tool-only native rounds can collapse after completion and keep running tools visible', () => {
  const message = { roundId: 'r', authorType: 'bot', status: 'done', text: 'Conclusion', activities: [{ id: 't', kind: 'tool', status: 'done' }] };
  assert.deepEqual(Queries.processState('r', [message], true), { canCollapse: true, open: false });
  message.status = 'streaming';
  assert.deepEqual(Queries.processState('r', [message], true, false), { canCollapse: false, open: true });
});
