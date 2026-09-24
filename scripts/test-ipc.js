'use strict';
const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const handlers = new Map();
const active = [{ roomId: 'room_a', status: 'running' }];
const mutations = [];
const referenceRecords = [];
const rooms = [{ id: 'room_a', botIds: ['bot_a'] }, { id: 'room_archive', archivedAt: 1 }];
const sourcePath = path.resolve('fixture-skills', 'sample');
let scanOptions;
const scanner = {
  discoverExternalDetailed: (options) => {
    scanOptions = options;
    return { skills: [{ name: 'sample', sourcePath }], roots: [], warnings: [], truncated: false };
  },
  listImported: () => [{ name: 'sample' }],
  sourceScope: () => ({ category: 'other', nativeCliType: null }),
  importSkill: (...args) => { mutations.push(args); return { name: args[2] }; },
};
const win = { webContents: { mainFrame: {}, send() {} }, isDestroyed: () => false };
const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
const store = {
  getInitial: () => ({ rooms: [{ id: 'room_a' }] }),
  listRooms: () => rooms,
  listBots: () => [],
  getSettings: () => ({}),
  getSkillsDir: () => path.resolve('fixture-data', 'skills'),
  getDataPath: () => path.resolve('fixture-data'),
  permanentDeleteRoom: (id) => mutations.push({ permanent: id }),
  setMemberDisplayOrder: (roomId, ids) => ({ roomId, ids }),
  rewindRoom: (roomId, messageId, text) => ({ roomId, messageId, text }),
  forkRoomAt: (roomId, messageId) => ({ roomId, messageId }),
  addAnnotation: (roomId, messageId) => ({ roomId, messageId }),
  removeAnnotation: () => true,
  setRoomArchived: (id, archived) => mutations.push({ id, archived }),
  saveSettings: (settings) => settings,
  clearRoom: (id) => mutations.push(id),
  saveBot: (bot) => mutations.push(bot),
  purgeTrash: (key) => mutations.push(key),
};
const original = Module._load;
Module._load = function (name, ...args) {
  if (name === 'electron') return { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } };
  if (name === './connectionTest') return { test: (payload) => payload, cancel() {} };
  if (name === './skills/skillReferences') return {
    list: () => referenceRecords, register: (_dir, payload) => payload, remove: (_dir, id) => id,
  };
  if (name === './skills/skillScanner') return scanner;
  if (name === './skills/skillDiscovery') return { scan: async (options) => scanner.discoverExternalDetailed(options) };
  if (name === './orchestrator/orchestrator') return {
    setEmitter() {}, isBusy: (id) => active.some((r) => r.roomId === id), getActiveRuns: () => active,
  };
  return original.call(this, name, ...args);
};
try { require('../src/main/ipc').registerIpc(win, store); } finally { Module._load = original; }
const call = (key, data, source = event) => handlers.get(key)(source, data);
assert.equal(call('app:getInitial').activeRuns[0].roomId, 'room_a');
assert.throws(() => call('room:clear', 'room_a'), /先停止/);
assert.throws(() => call('bot:save', { id: 'bot_a' }), /先停止/);
assert.throws(() => call('trash:purge', '../data'), /标识/);
assert.throws(() => call('archive:get', { roomId: '../data', archiveId: 'arc_1' }), /标识/);
assert.throws(() => call('room:clear', 'room_b', { sender: {} }), /来源/);
for (const channel of ['room:rewind', 'room:fork', 'message:annotate', 'message:removeAnnotation']) {
  assert.throws(() => call(channel, { roomId: 'room_a', messageId: 'msg_a' }), /先停止/);
}
assert.deepEqual(call('skills:imported'), [], 'legacy copies are absent from the active slash catalog');
referenceRecords.push({ name: 'Writing', alias: 'same', cliTypes: ['codex'], description: '中文表达' },
  { name: 'Editor', alias: 'same', cliTypes: ['claude'], description: 'Polish prose' });
assert.deepEqual(call('skills:imported'), referenceRecords, 'same alias must retain every source name, description and CLI for search');
referenceRecords.length = 0;
assert.throws(() => call('skills:referenceRemove', '../bad'), /标识/);
assert.throws(() => call('skills:referenceRegister', { sourcePath, alias: 'sample', cliTypes: ['claude'] }), /重新扫描/);
assert.deepEqual(call('room:displayOrder', { roomId: 'room_a', ids: ['bot_a'] }), { roomId: 'room_a', ids: ['bot_a'] });
assert.equal(mutations.length, 0);
call('room:clear', 'room_b');
assert.deepEqual(mutations, ['room_b']);
assert.throws(() => call('room:archive', { roomId: 'room_a', archived: true }), /先停止/);
assert.throws(() => call('room:archive', { roomId: 'room_archive', archived: 'yes' }), /状态/);
assert.throws(() => call('chat:human', { roomId: 'room_archive', text: 'hello' }), /恢复归档/);
assert.throws(() => call('chat:retry', { roomId: 'room_archive', messageId: 'msg_a' }), /恢复归档/);
call('room:archive', { roomId: 'room_archive', archived: false });
assert.deepEqual(mutations.at(-1), { id: 'room_archive', archived: false });

assert.throws(() => call('skills:import', { sourcePath, name: 'sample' }), /重新扫描/);
(async () => {
await assert.rejects(call('skills:discoverDetailed', { roots: ['relative'] }), /绝对路径/);
const found = await call('skills:discoverDetailed');
assert.equal(found.skills[0].sourcePath, sourcePath);
assert.equal(call('skills:referenceRegister', { sourcePath, alias: 'sample', cliTypes: ['claude'] }).alias, 'sample');
call('room:delete', 'room_archive');
assert.deepEqual(mutations.at(-1), { permanent: 'room_archive' });
assert.equal(scanOptions.cwd, path.resolve(__dirname, '..'));
assert.equal(scanOptions.skillsDir, store.getSkillsDir());
assert.throws(() => call('skills:import', { sourcePath, name: 'SAMPLE' }), /确认替换/);
assert.throws(() => call('skills:import', { sourcePath, name: 'some name' }), /空白/);
assert.equal(call('skills:import', { sourcePath, name: 'sample', overwrite: true }).name, 'sample');
assert.equal(call('skills:import', { sourcePath, name: 'sample-copy' }).name, 'sample-copy');
active.length = 0;
assert.throws(() => call('settings:save', { skillScanRoots: ['relative'] }), /绝对路径/);
assert.deepEqual(call('settings:save', { skillScanRoots: [sourcePath, sourcePath] }).skillScanRoots, [sourcePath]);
console.log('PASS IPC: busy/archive boundaries, scoped skill discovery, explicit replacement, sender and path checks');
})().catch((error) => { console.error(error); process.exitCode = 1; });

assert.throws(() => call('project:rooms', { action: 'delete', roomIds: ['room_archive', 'room_a'] }), /先停止/);
assert.throws(() => call('project:rooms', { action: 'archive', roomIds: ['../bad'] }), /标识/);
assert.throws(() => call('project:rooms', { action: 'archive', roomIds: ['missing'] }), /房间已变化/);
assert.throws(() => call('project:rooms', { action: 'unsupported', roomIds: ['room_archive'] }), /项目操作/);
