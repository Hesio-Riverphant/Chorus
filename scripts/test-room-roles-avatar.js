'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const RoomProfiles = require('../src/shared/roomProfiles');
const BotProfile = require('../src/shared/botProfile');
test('host roles are room-local projections and preserve other roles, personas and snapshots', () => {
  const bots = [{ id: 'a', cliType: 'claude', role: '主持人', persona: 'user instructions' },
    { id: 'b', cliType: 'codex', role: '审查者', customRole: false },
    { id: 'c', cliType: 'kimi', role: 'Specialist', customRole: true }];
  const before = JSON.stringify(bots);
  const first = { botIds: ['a', 'b', 'c'], moderatorBotId: 'b' }, other = { ...first, moderatorBotId: 'a' };
  assert.deepEqual(RoomProfiles.members(first, bots).map(b => b.role), ['协作者', '主持人', 'Specialist']);
  assert.deepEqual(RoomProfiles.members(other, bots).map(b => b.role), ['主持人', '审查者', 'Specialist']);
  assert.equal(RoomProfiles.members(first, bots)[0].persona, 'user instructions');
  assert.equal(RoomProfiles.members(first, bots)[2].customRole, true);
  const side = { ...first, parentRoomId: 'room', memberProfiles: Object.fromEntries(bots.map(bot => [bot.id, { ...bot }])) };
  const sideBefore = JSON.stringify(side);
  assert.deepEqual(RoomProfiles.members(side, bots).map(b => b.role), ['协作者', '主持人', 'Specialist']);
  assert.equal(JSON.stringify(side), sideBefore); assert.equal(JSON.stringify(bots), before);
});
test('empty text and an unselected image are valid avatar fallback states, malformed images remain rejected', () => {
  assert.deepEqual(BotProfile.normalizeAvatar({ type: 'text', text: '  ' }), { type: 'text', text: '' });
  assert.deepEqual(BotProfile.normalizeAvatar({ type: 'image', dataUrl: '' }), { type: 'image', dataUrl: '' });
  assert.throws(() => BotProfile.normalizeAvatar({ type: 'image', dataUrl: 'https://example.invalid/x.png' }));
  assert.throws(() => BotProfile.normalizeAvatar({ type: 'text', text: '123456789' }));
});
test('every built-in CLI has an identifiable avatar and fixed legacy providers follow current CLI', () => {
  const code = fs.readFileSync(path.join(__dirname, '../src/renderer/bot-ui.js'), 'utf8');
  const context = { state: { cliProfiles: [{ id: 'custom_test', label: 'Local Agent' }] }, I18n: { t: x => x }, esc: x => String(x).replace(/[<>&"]/g, '') };
  vm.createContext(context); vm.runInContext(code.slice(code.indexOf('const CLI_AVATARS'), code.indexOf('\nfunction displayMembers')), context);
  for (const profile of require('../src/main/cliRegistry').BUILTINS) {
    const html = context.avatarHtml({ name: 'Bot', cliType: profile.id });
    assert.ok(!html.includes('>CLI<'), profile.id);
    for (const match of html.matchAll(/src="assets\/([^"\/]+)"/g)) assert.ok(fs.existsSync(path.join(__dirname, '../src/renderer/assets', match[1])));
  }
  assert.match(context.avatarHtml({ cliType: 'gemini', avatar: { type: 'provider', provider: 'claude' } }), /gemini.svg/);
  assert.match(context.avatarHtml({ cliType: 'codex', avatar: { type: 'text', text: '' } }), /deepseek.svg/);
  assert.match(context.avatarHtml({ cliType: 'custom_test', avatar: { type: 'image', dataUrl: '' } }), /Local Agent/);
});
