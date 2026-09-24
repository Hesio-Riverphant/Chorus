'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discoverClis, locateCliExecutable } = require('../src/main/cliDiscovery');
const { resolveEnabledCliIds, normalizeEnabledCliIds, requireEnabled } = require('../src/main/cliRegistry');

test('discovery distinguishes installation from user selection and never scans network or relative PATH entries', async () => {
  const visited = [];
  const profiles = await discoverClis({ enabledCliIds: ['codex'] }, {
    env: { Path: 'relative;\\\\server\\share;C:\\tools;C:\\tools', APPDATA: 'C:\\User\\AppData\\Roaming' },
    homeDir: 'C:\\User', platform: 'win32',
    stat: async filename => { visited.push(filename); return { isFile: () => ['C:\\tools\\claude.bat', 'C:\\tools\\codex.cmd', 'C:\\User\\.local\\bin\\pi.exe'].includes(filename) }; },
  });
  assert.equal(profiles.find(p => p.id === 'claude').installed, true);
  assert.equal(profiles.find(p => p.id === 'claude').enabled, false);
  assert.equal(profiles.find(p => p.id === 'codex').enabled, true);
  assert.equal(profiles.find(p => p.id === 'pi').installed, true);
  assert.equal(profiles.find(p => p.id === 'opencode').installed, false);
  assert.ok(visited.every(filename => filename.startsWith('C:\\')));
  assert.equal(visited.length, new Set(visited).size);
});

test('legacy selection keeps only actual member providers and explicit empty selection stays empty', () => {
  const bots = [{ cliType: 'codex' }, { cliType: 'codex' }, { cliType: 'claude' }, { cliType: 'missing' }];
  assert.deepEqual(resolveEnabledCliIds({}, bots), ['codex', 'claude']);
  assert.deepEqual(resolveEnabledCliIds({ enabledCliIds: [] }, bots), []);
  assert.throws(() => normalizeEnabledCliIds(['invented']));
  assert.throws(() => normalizeEnabledCliIds('codex'));
  assert.throws(() => requireEnabled('codex', { enabledCliIds: [] }), /启用/);
});

test('discovery reads configured executable metadata only and does not grant custom history capability', async () => {
  const id = 'custom_' + 'a'.repeat(32);
  const settings = { enabledCliIds: [id], cliProfiles: [{ id, label: 'Fixture', command: 'C:\\Agent\\agent.exe', args: [], promptMode: 'stdin', outputMode: 'text' }] };
  const result = await discoverClis(settings, { env: {}, homeDir: '', platform: 'win32', stat: async filename => ({ isFile: () => filename === settings.cliProfiles[0].command }) });
  assert.deepEqual(result.at(-1), { ...settings.cliProfiles[0], historyArgs: [], builtin: false, historyModeSupport: 'unknown', enabled: true, installed: true, executablePath: settings.cliProfiles[0].command });
});

test('launcher and settings discovery use the same common-directory executable search', () => {
  const found = locateCliExecutable('claude', {}, { env: { PATH: '' }, homeDir: 'C:\\User', platform: 'win32',
    stat: filename => ({ isFile: () => filename === 'C:\\User\\.local\\bin\\claude.bat' }) });
  assert.equal(found, 'C:\\User\\.local\\bin\\claude.bat');
});

test('Kimi native installation is found outside PATH on Windows and Linux', () => {
  for (const [platform, homeDir, file] of [['win32', 'C:\\User', 'C:\\User\\.kimi-code\\bin\\kimi.exe'],
    ['linux', '/home/user', '/home/user/.kimi-code/bin/kimi']]) {
    assert.equal(locateCliExecutable('kimi', {}, { env: {}, platform, homeDir, stat: name => ({ isFile: () => name === file }) }), file);
  }
});

test('Cursor native agent alias and Droid user bin are discovered in official Windows install locations', () => {
  const options = { env: { LOCALAPPDATA: 'C:\\User\\AppData\\Local' }, homeDir: 'C:\\User', platform: 'win32' };
  for (const [id, file] of [['cursor', 'C:\\User\\AppData\\Local\\cursor-agent\\agent.exe'], ['droid', 'C:\\User\\bin\\droid.exe']]) {
    assert.equal(locateCliExecutable(id, {}, { ...options, stat: candidate => ({ isFile: () => candidate === file }) }), file);
  }
  assert.equal(locateCliExecutable('cursor', {}, { env: { PATH: '/home/user/.local/bin' }, homeDir: '/home/user', platform: 'linux',
    stat: candidate => ({ isFile: () => candidate === '/home/user/.local/bin/agent' }) }), '/home/user/.local/bin/agent');
});
