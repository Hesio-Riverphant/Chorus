'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeProfiles, listProfiles, requireAppOnly } = require('../src/main/cliRegistry');
const { listModels } = require('../src/main/modelCatalog');
const custom = { id: 'custom_' + 'a'.repeat(32), label: 'My Agent', command: 'C:\\Tools\\agent.exe', args: ['--model', '{model}'], promptMode: 'stdin', outputMode: 'text' };

test('custom CLI settings preserve literal argv, stable IDs and models without granting history capability', () => {
  const settings = { cliProfiles: normalizeProfiles([{ ...custom, historyArgs: ['--no-history'] }]) };
  assert.deepEqual(settings.cliProfiles[0].args, custom.args);
  assert.equal(listProfiles(settings).at(-1).historyModeSupport, 'unknown');
  assert.equal(requireAppOnly(custom.id, settings).historyModeSupport, 'unknown');
  assert.deepEqual(listModels(custom.id, { settings, bots: [{ cliType: custom.id, model: 'provider/model' }] }).models.map(m => m.id), ['provider/model']);
});

test('CLI metadata rejects malformed or secret-bearing profiles at the persistence boundary', () => {
  for (const patch of [
    { id: 'codex' }, { command: 'agent.exe & echo x' }, { command: '\\\\server\\share\\a.exe' },
    { args: ['--api-key', 'example'] }, { args: ['--model={model}'] }, { args: ['x\ny'] },
    { promptMode: 'arg', args: [] }, { outputMode: 'invented' },
    { args: ['{prompt}'] }, { historyArgs: ['{model}'] },
  ]) assert.throws(() => normalizeProfiles([{ ...custom, ...patch }]));
  assert.throws(() => normalizeProfiles([custom, custom]));
});

test('custom Agent can use a Linux executable path and appears alongside built-in Agents', () => {
  const profile = { ...custom, label: 'AA', command: '/home/user/.local/bin/aa' };
  const settings = { cliProfiles: normalizeProfiles([profile]) };
  assert.equal(listProfiles(settings).find(item => item.label === 'AA').command, profile.command);
  assert.ok(listProfiles(settings).some(item => item.id === 'codebuddy'));
  assert.throws(() => normalizeProfiles([{ ...profile, command: '//server/share/agent' }]));
});

test('known providers prefer no-save flags while unknown history remains available', () => {
  for (const id of ['claude', 'codex', 'pi']) assert.equal(requireAppOnly(id).id, id);
  for (const id of ['kimi', 'opencode', 'hermes']) assert.equal(requireAppOnly(id).id, id);
  assert.throws(() => requireAppOnly('__proto__'), /不存在/);
});

test('Pi rejects unsupported workspace permissions and limits read-only tools', () => {
  const { EXTRA_SPECS } = require('../src/main/adapters/extraCliSpecs');
  assert.throws(() => EXTRA_SPECS.pi.args({ permissionMode: 'workspace' }, null, 'hello'), /隔离/);
  const args = EXTRA_SPECS.pi.args({ permissionMode: 'read_only' }, null, 'hello');
  assert.equal(args[args.indexOf('--tools') + 1], 'read,grep,find,ls');
  assert.ok(args.indexOf('--tools') < args.indexOf('--'));
});
