'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.listeners = {}; this.style = {};
    this.classes = new Set(); this.attributes = {}; this.isConnected = true;
    this.classList = { add: (...names) => names.forEach((name) => this.classes.add(name)),
      remove: (...names) => names.forEach((name) => this.classes.delete(name)) };
  }
  append(...nodes) { nodes.forEach((node) => this.appendChild(node)); }
  appendChild(node) { this.children.push(node); node.parentElement = this; return node; }
  insertBefore(node, target) {
    this.children = this.children.filter((item) => item !== node);
    const index = target ? this.children.indexOf(target) : this.children.length;
    this.children.splice(index, 0, node);
  }
  get nextSibling() { return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null; }
  closest(selector) { return selector === '.side-section' ? this : null; }
  querySelectorAll() { return this.children; }
  querySelector() { return this.children[0]; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(type, handler, capture) { (this.listeners[type] ||= []).push({ handler, capture }); }
  removeEventListener(type, handler, capture) {
    this.listeners[type] = (this.listeners[type] || []).filter((listener) => listener.handler !== handler || listener.capture !== capture);
  }
  async event(type, overrides = {}) {
    const event = { button: 0, pointerId: 1, pointerType: 'mouse', clientX: 0, clientY: 15,
      target: this, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...overrides };
    event.stopPropagation = () => { event.propagationStopped = true; };
    if (this.ownerDocument) {
      for (const listener of [...(this.ownerDocument.listeners[type] || [])]) await listener.handler(event);
    }
    for (const listener of this.listeners[type] || []) { await listener.handler(event); if (event.stopped) break; }
    return event;
  }
  focus() { this.focused = true; }
  setPointerCapture(id) { this.capture = id; }
  hasPointerCapture(id) { return this.capture === id; }
  releasePointerCapture() { this.capture = null; }
  getBoundingClientRect() {
    if (!this.parentElement) return { top: 0, bottom: 120, height: 120 };
    const top = this.parentElement.children.indexOf(this) * 30;
    return { top, bottom: top + 30, height: 30 };
  }
  showModal() {} close() {} remove() {}
}

function fixture({ fail = false } = {}) {
  const document = new Element('document');
  const list = new Element(); list.scrollTop = 0;
  const members = ['a', 'b', 'c'].map((id) => ({ id }));
  const room = { id: 'room1', botIds: ['a', 'b', 'c'], memberDisplayOrder: ['a', 'b', 'c'] };
  const rows = members.map((bot) => { const row = new Element(); row.ownerDocument = document; row.dataset.botId = bot.id; list.appendChild(row); return row; });
  const timers = new Map(), frames = new Map(), calls = [];
  let sequence = 0;
  const context = {
    document,
    window: { api: { setMemberDisplayOrder: async (payload) => {
      calls.push(payload); if (fail) throw new Error('save failed'); return { memberDisplayOrder: payload.ids };
    } } },
    $: () => list, $$: () => list.children, roomMembers: () => [...members], CSS: { escape: (s) => s },
    setTimeout: (fn) => { timers.set(++sequence, fn); return sequence; }, clearTimeout: (id) => timers.delete(id),
    requestAnimationFrame: (fn) => { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame: (id) => frames.delete(id),
    openBotEdit: () => { throw new Error('drag must not open editor'); },
    renderBots: () => { list.children = room.memberDisplayOrder.map((id) => rows.find((row) => row.dataset.botId === id)); },
  };
  vm.createContext(context);
  require('./renderer-test-i18n')(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/bot-ui.js'), 'utf8'), context);
  rows.forEach((row, i) => context.wireMemberOrder(row, members[i], room));
  return { context, document, rows, list, room, calls, timers, frames };
}

test('mouse threshold starts drag immediately, shows insertion marker, and persists display order only', async () => {
  const f = fixture(); const row = f.rows[0];
  await row.event('pointerdown');
  await row.event('pointermove', { clientY: 18 });
  assert.equal(row.dataset.dragged, undefined);
  await row.event('pointermove', { clientY: 85 });
  assert.equal(row.dataset.dragged, 'true');
  assert.ok(f.rows[2].classes.has('member-drop-after'));
  assert.equal(f.calls.length, 0);
  assert.equal((await row.event('click')).stopped, true);
  await row.event('pointerup', { clientY: 85 });
  assert.equal(JSON.stringify(f.calls), JSON.stringify([{ roomId: 'room1', ids: ['b', 'c', 'a'] }]));
  assert.deepEqual(f.room.botIds, ['a', 'b', 'c']);
  assert.equal(f.frames.size, 0);
  await row.event('pointerdown');
  await row.event('pointerup');
  assert.equal((await row.event('click')).stopped, undefined, 'next click must work without a second click');
});

test('cancel restores unchanged order and failed saves render the stored order', async () => {
  const cancelled = fixture();
  assert.equal(cancelled.context.memberOrderInteractionActive(null), false);
  await cancelled.rows[0].event('pointerdown');
  await cancelled.rows[0].event('pointermove', { clientY: 85 });
  const escape = await cancelled.rows[0].event('keydown', { key: 'Escape' });
  assert.equal(escape.propagationStopped, true);
  await cancelled.rows[0].event('pointerup');
  assert.equal(cancelled.calls.length, 0);
  assert.deepEqual(cancelled.list.children.map((row) => row.dataset.botId), ['a', 'b', 'c']);
  const failed = fixture({ fail: true });
  await failed.rows[0].event('pointerdown');
  await failed.rows[0].event('pointermove', { clientY: 85 });
  await assert.rejects(failed.rows[0].event('pointerup', { clientY: 85 }), /save failed/);
  assert.deepEqual(failed.list.children.map((row) => row.dataset.botId), ['a', 'b', 'c']);
});

test('pointerup on another row finishes the original gesture and removes document listeners', async () => {
  const f = fixture();
  await f.rows[0].event('pointerdown');
  await f.rows[0].event('pointermove', { clientY: 85 });
  await f.rows[2].event('pointerup', { pointerId: 2, clientY: 85 });
  assert.equal(f.calls.length, 0, 'another pointer must not finish the active gesture');
  await f.rows[2].event('pointerup', { clientY: 85 });
  assert.equal(JSON.stringify(f.calls[0].ids), JSON.stringify(['b', 'c', 'a']));
  assert.equal(f.context.memberOrderInteractionActive('room1'), false);
  for (const type of ['pointermove', 'pointerup', 'pointercancel']) assert.equal(f.document.listeners[type].length, 0);
  await f.rows[2].event('pointerup', { clientY: 85 });
  assert.equal(f.calls.length, 1, 'late events must not save twice');
});

test('touch requires long press and Alt arrow preserves keyboard reordering', async () => {
  const f = fixture();
  await f.rows[0].event('pointerdown', { pointerType: 'touch' });
  assert.equal(f.rows[0].dataset.dragged, undefined);
  [...f.timers.values()][0]();
  assert.equal(f.rows[0].dataset.dragged, 'true');
  await f.rows[0].event('pointercancel');
  await f.rows[0].event('keydown', { altKey: true, key: 'ArrowDown' });
  assert.equal(JSON.stringify(f.calls[0].ids), JSON.stringify(['b', 'a', 'c']));
});

test('touch movement before long press scrolls instead of reordering or opening the editor', async () => {
  const f = fixture();
  await f.rows[0].event('pointerdown', { pointerType: 'touch', clientY: 80 });
  await f.rows[0].event('pointermove', { pointerType: 'touch', clientY: 50 });
  assert.equal(f.list.scrollTop, 30);
  assert.equal(f.timers.size, 0);
  await f.rows[0].event('pointerup', { pointerType: 'touch', clientY: 50 });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.rows[0].event('click')).stopped, true);
});

test('dragging near the scroll edge advances scroll position without additional pointer movement', async () => {
  const f = fixture();
  await f.rows[0].event('pointerdown');
  await f.rows[0].event('pointermove', { clientY: 115 });
  [...f.frames.values()][0]();
  assert.ok(f.list.scrollTop > 0);
  await f.rows[0].event('pointercancel');
});

function messageFixture() {
  const body = new Element('body');
  const calls = [];
  const context = { document: { createElement: (tag) => new Element(tag), querySelectorAll: () => [], body },
    SideChatUI: { refreshMessages() {}, getRoom: () => null },
    AppDialog: { confirm: () => { throw new Error('unexpected second confirmation'); } },
    roomIsBusy: () => false, state: { currentRoomId: 'r1', dataByRoom: {} },
    ACTIVE_RUN: new Set(), runByRoom: new Map(), sendingRooms: new Set(),
    renderMessages() {}, window: { api: {
      rewindRoom: async (payload) => { calls.push(['rewind', payload]); return []; },
      continueHuman: async (payload) => calls.push(['continue', payload]),
      forkRoomAt: async (payload) => { calls.push(['fork', payload]); return { id: 'r2' }; },
    } }, reloadFromMain: async () => {}, switchRoom: (id) => calls.push(['switch', id]),
    fmtTime: () => '', fmtDateTime: () => '', navigator: {},
  };
  vm.createContext(context);
  require('./renderer-test-i18n')(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/message-ui.js'), 'utf8'), context);
  return { context, body, calls };
}

test('rewind save and regenerate perform the selected action with no second confirmation', async () => {
  for (const regenerate of [false, true]) {
    const f = messageFixture(); f.context.textEditor = async () => ({ text: 'edited', regenerate });
    await f.context.editAndRewind('r1', { id: 'm1', text: 'old' });
    assert.equal(f.calls[0][0], 'rewind');
    assert.equal(f.calls.length, regenerate ? 2 : 1);
  }
});

test('fork action directly creates branch without confirmation', async () => {
  const f = messageFixture(); const row = new Element(); row.appendChild(new Element());
  f.context.renderActivities = () => {}; f.context.renderAnnotations = () => {};
  f.context.addMessageActions(row, { id: 'm1', roomId: 'r1', status: 'done', authorType: 'bot', createdAt: 1 });
  const fork = row.children[0].children[0].children[1];
  await fork.event('click');
  assert.equal(f.calls[0][0], 'fork');
});

test('annotation editor labels selected original text and note input separately', () => {
  const f = messageFixture();
  f.context.textEditor({ title: '添加批注', description: '为下面选中的原文添加批注。', quote: '下，没有其他 Agent 会', inputLabel: '批注内容' });
  const dialog = f.body.children[0];
  const preview = dialog.children.find((node) => node.className === 'annotation-selection-preview');
  assert.equal(preview.children[0].textContent, '选中文本');
  assert.equal(preview.children[1].textContent, '下，没有其他 Agent 会');
  assert.equal(dialog.children.find((node) => node.tagName === 'label').textContent, '批注内容');
});
