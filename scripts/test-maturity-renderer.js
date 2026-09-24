'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Small DOM boundary for command dispatch and native input state; no browser,
// provider, disk persistence or real CLI invocation is needed for these flows.
class Element {
  constructor(tagName) { this.tagName = tagName; this.children = []; this.value = ''; this.className = ''; }
  append(...children) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this);
  }
  querySelectorAll(selector) {
    const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]);
    return descendants.filter(child => selector.startsWith('.') ? child.className.split(' ').includes(selector.slice(1)) : child.tagName === selector);
  }
  addEventListener() {}
  showModal() { this.open = true; }
  close() { this.open = false; }
}

function fixture() {
  const main = new Element('div'), side = new Element('div'), body = new Element('body');
  const state = { currentRoomId: 'main', bots: [{ id: 'parent_bot', cliType: 'codex', name: 'Parent' },
    { id: 'side_bot', cliType: 'claude', name: 'Side' }], rooms: [{ id: 'main', botIds: ['parent_bot'] },
    { id: 'side', botIds: ['side_bot'], parentRoomId: 'main' }], importedSkills: [
    { alias: 'fixture-skill', name: 'fixture-skill', cliTypes: ['codex'] },
    { alias: 'fixture-skill', name: 'fixture-skill', cliTypes: ['claude'] },
  ] };
  const calls = [];
  const api = { respondNativeInput: async payload => { calls.push(payload); return true; }, stopRun: async () => {} };
  const context = {
    document: { createElement: tag => new Element(tag), body,
      getElementById: id => ({ messages: main, sideChatMessages: side })[id] },
    window: { api }, state, SideChatUI: { getRoom: () => state.rooms[1] },
    roomMembers: room => state.bots.filter(bot => room?.botIds.includes(bot.id)),
  };
  vm.createContext(context);
  require('./renderer-test-i18n')(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/commands.js'), 'utf8') +
    '\n;globalThis.commandModule={RoomCommands,NativeInputUI};', context);
  return { main, side, calls, api, state, context, ...context.commandModule };
}

test('side slash catalog includes commands and deduplicated skills with distinct actions', async () => {
  const f = fixture();
  const items = f.context.window.getComposerSlashItems('side');
  assert.ok(items.some(item => item.name === 'model' && item.command));
  assert.ok(items.some(item => item.name === 'plan' && item.command));
  assert.equal(items.filter(item => item.name === 'fixture-skill').length, 1);
  const skill = items.find(item => item.name === 'fixture-skill');
  assert.notEqual(skill.command, true);
  const tokens = [];
  await f.context.window.chooseComposerSlash(skill, { roomId: 'side', start: 2, end: 5,
    composer: { replaceToken: (...args) => tokens.push(args) } });
  assert.deepEqual(tokens, [[2, 5, 'skill', 'fixture-skill']]);
});

test('awaited slash command clears only the original conversation draft', async () => {
  const f = fixture();
  let finish;
  f.api.stopRun = () => new Promise(resolve => { finish = resolve; });
  const drafts = { main: '/stop', side: 'keep side draft' };
  const composer = { current: 'main', clearSent(roomId, text) { if (drafts[roomId] === text) drafts[roomId] = ''; },
    set value(text) { drafts[this.current] = text; } };
  const stopping = f.RoomCommands.intercept('/stop', 'main', composer);
  composer.current = 'side';
  finish();
  assert.equal(await stopping, true);
  assert.equal(drafts.main, '');
  assert.equal(drafts.side, 'keep side draft');
});

test('native side questions keep typed answers across renders and submit through their original room', async () => {
  const f = fixture();
  const request = { kind: 'input_request', roomId: 'side', botId: 'side_bot', messageId: 'message_1',
    requestId: 'request_1', questions: [{ id: 'choice', question: 'Select fixture', options: [{ label: 'A', description: 'first fixture' }] }] };
  f.NativeInputUI.event(request);
  assert.equal(f.main.children.length, 0);
  assert.equal(f.side.querySelectorAll('.native-question').length, 1);
  const input = f.side.querySelectorAll('input')[0];
  input.value = 'typed fixture'; input.oninput();
  f.NativeInputUI.render('side');
  assert.equal(f.side.querySelectorAll('input')[0].value, 'typed fixture');
  const form = f.side.querySelectorAll('.native-question')[0];
  await form.onsubmit({ preventDefault() {} });
  assert.equal(f.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(f.calls[0])), { roomId: 'side', messageId: 'message_1',
    requestId: 'request_1', answers: { choice: { answers: ['typed fixture'] } } });
  assert.equal(f.side.querySelectorAll('.native-question').length, 0);
  f.NativeInputUI.render('side');
  assert.equal(f.side.querySelectorAll('.native-question').length, 0);
});

test('native question rejection preserves the form and stop clears stale input', async () => {
  const f = fixture();
  f.api.respondNativeInput = async () => { throw new Error('fixture rejected'); };
  f.NativeInputUI.event({ kind: 'input_request', roomId: 'side', botId: 'side_bot', messageId: 'm',
    requestId: 'q', questions: [{ id: 'a', question: 'Fixture?' }] });
  const form = f.side.querySelectorAll('.native-question')[0];
  await form.onsubmit({ preventDefault() {} });
  assert.equal(f.side.querySelectorAll('.native-question').length, 1);
  assert.equal(form.querySelectorAll('button').at(-1).disabled, false);
  assert.equal(form.querySelectorAll('p')[0].textContent, 'fixture rejected');
  f.NativeInputUI.event({ kind: 'run_update', roomId: 'side', run: { status: 'stopped' } });
  assert.equal(f.side.querySelectorAll('.native-question').length, 0);
});
