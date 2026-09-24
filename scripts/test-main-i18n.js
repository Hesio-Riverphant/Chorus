'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const I18n = require('../src/shared/i18n');
const store = require('../src/main/store/persistence');

test('saved language drives actual IPC validation while preserving user messages and native text', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-i18n-'));
  t.after(() => { clearInterval(store.timer); I18n.setLanguage('zh-CN'); fs.rmSync(directory, { recursive: true, force: true }); });
  await store.init({ isPackaged: true, getPath: () => directory });
  const room = store.listRooms()[0];
  store.addMessage(room.id, { id: 'unchanged', authorType: 'human', text: '房间不存在：用户原文', status: 'done', createdAt: 1 });
  store.flushSync();
  const messageFile = path.join(directory, 'messages', room.id + '.json');
  const bytes = fs.readFileSync(messageFile);
  const handlers = new Map(), win = { webContents: { mainFrame: {}, send() {} }, isDestroyed: () => false };
  const loader = Module._load;
  Module._load = function(name, ...args) { return name === 'electron' ? { ipcMain: { handle: (key, fn) => handlers.set(key, fn) } } : loader.call(this, name, ...args); };
  try { require('../src/main/ipc').registerIpc(win, store); } finally { Module._load = loader; }
  const event = { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  const call = async (name, payload) => handlers.get(name)(event, payload);
  await call('settings:save', { language: 'en' });
  assert.equal(I18n.language, 'en');
  await assert.rejects(call('bot:save', { name: '', cliType: 'claude' }), /Enter a member name/);
  await assert.rejects(call('room:save', { name: room.name }), /already exists/);
  await assert.rejects(call('bot:save', { name: '成员', cliType: 'bad-cli' }), /CLI integration not found/);
  assert.deepEqual(fs.readFileSync(messageFile), bytes);
  const raw = '原生错误 / 用户路径 D:/中文项目';
  assert.equal(I18n.tpl`无法发送提示词：${raw}`, 'Cannot send the prompt: ' + raw);
  await call('settings:save', { language: 'zh-CN' });
  await assert.rejects(call('bot:save', { name: '', cliType: 'claude' }), /请填写成员名称/);
  store.saveSettings({ language: 'en' }); clearInterval(store.timer);
  await store.init({ isPackaged: true, getPath: () => directory });
  assert.equal(I18n.language, 'en');
  assert.equal(store.getMessages(room.id)[0].text, '房间不存在：用户原文');
});

test('worker warnings use application language without changing archive contents or names', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-i18n-worker-'));
  t.after(() => { I18n.setLanguage('zh-CN'); fs.rmSync(directory, { recursive: true, force: true }); });
  const archives = path.join(directory, 'archives', 'fixture'); fs.mkdirSync(archives, { recursive: true });
  const file = path.join(archives, 'broken.json'); fs.writeFileSync(file, 'malformed');
  I18n.setLanguage('en');
  const result = await require('../src/main/store/archiveSearch').searchArchives(directory, [{ id: 'fixture', name: '原房间' }], 'query');
  assert.match(result.warnings[0], /原房间.*archive is damaged or unreadable/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'malformed');
});

test('system notice metadata can change presentation language without rewriting stored source text', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'chorus-i18n-notice-'));
  t.after(() => { clearInterval(store.timer); I18n.setLanguage('zh-CN'); fs.rmSync(directory, { recursive: true, force: true }); });
  await store.init({ isPackaged: true, getPath: () => directory });
  const roomId = store.listRooms()[0].id;
  const native = '模型返回的原文';
  const metadata = { parts: ['运行异常已中止：', ''], values: [native] };
  require('../src/main/orchestrator/orchestrator').systemNote({ roomId, roundId: 'fixture' }, metadata);
  const message = store.getMessages(roomId).at(-1), original = JSON.stringify(message);
  I18n.setLanguage('en');
  assert.equal(I18n.parts(message.i18n.parts, message.i18n.values), 'Execution stopped after an error: ' + native);
  assert.equal(JSON.stringify(message), original);
  assert.equal(message.text, '运行异常已中止：' + native);
});
