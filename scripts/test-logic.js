'use strict';

// Minimal dependency-free logic tests for shared modules and routing.
// Run: node scripts/test-logic.js
const assert = require('assert');
const { parseMentions } = require('../src/shared/mention');
const { resolveTargets } = require('../src/main/orchestrator/router');
const { RoutingMode, SpeakMode, PermissionMode } = require('../src/shared/constants');

const bots = [
  { id: 'bA', name: '主持人', cliType: 'claude', enabled: true, permissionMode: PermissionMode.WORKSPACE },
  { id: 'bB', name: '执行者', cliType: 'codex', enabled: true, permissionMode: PermissionMode.WORKSPACE },
  { id: 'bC', name: 'a', cliType: 'kimi', enabled: true, permissionMode: PermissionMode.READ_ONLY },
  { id: 'bD', name: '禁用者', cliType: 'claude', enabled: false, permissionMode: PermissionMode.WORKSPACE },
];

const room = {
  id: 'r1', moderatorBotId: 'bA', routingMode: RoutingMode.MODERATOR, speakMode: SpeakMode.PARALLEL,
};

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

check('@all matches', () => {
  assert.deepStrictEqual(parseMentions('@全体 开始吧', bots), ['all']);
  assert.deepStrictEqual(parseMentions('@all go', bots), ['all']);
});

check('single mention', () => {
  const r = parseMentions('@执行者 你来', bots);
  assert.ok(r.includes('bB'));
  assert.ok(!r.includes('all'));
});

check('mention needs boundary after name (no @a inside @apple)', () => {
  const r = parseMentions('buy @apple stock', bots);
  assert.deepStrictEqual(r, []);
});

check('mention needs whitespace/start before @ (email-like prefix)', () => {
  const r = parseMentions('x@执行者', bots);
  assert.deepStrictEqual(r, []);
});

check('mention followed by punctuation is valid', () => {
  const r = parseMentions('@执行者，开始', bots);
  assert.ok(r.includes('bB'));
});

check('routing: no @ -> moderator only', () => {
  const { targets, via } = resolveTargets({ text: '大家好', bots, room });
  assert.deepStrictEqual(targets.map((t) => t.id), ['bA']);
  assert.strictEqual(via, 'moderator');
});

check('routing: explicit @ wins in any speak mode', () => {
  const hostRoom = { ...room, speakMode: SpeakMode.HOST };
  const { targets } = resolveTargets({ text: '@执行者 去做', bots, room: hostRoom });
  assert.deepStrictEqual(targets.map((t) => t.id), ['bB']);
});

check('routing: @all covers enabled only', () => {
  const { targets } = resolveTargets({ text: '@全体', bots, room });
  assert.deepStrictEqual(targets.map((t) => t.id).sort(), ['bA', 'bB', 'bC']);
});

check('routing: routingMode all -> everyone', () => {
  const { targets } = resolveTargets({ text: 'hi', bots, room: { ...room, routingMode: RoutingMode.ALL } });
  assert.strictEqual(targets.length, 3);
});

console.log(`\n${passed} checks passed.`);
