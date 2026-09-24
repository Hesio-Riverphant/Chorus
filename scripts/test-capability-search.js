'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const references = require('../src/main/skills/skillReferences');
const { prepare } = require('../src/main/nativeCapabilities');

function fixture() {
  const context = { window: {}, state: { importedSkills: [
    { name: 'Writing assistant', alias: 'writer', description: '改善中文表达 style review', cliTypes: ['codex'] },
    { name: 'Visual review', alias: 'visual-check', description: '界面设计检查', cliTypes: ['claude'] },
    { name: 'Writing assistant', alias: 'writer', description: 'Polish prose', cliTypes: ['claude'] },
  ] } };
  vm.createContext(context);
  require('./renderer-test-i18n')(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/commands.js'), 'utf8') +
    '\n;globalThis.slash = ComposerSlash;', context);
  return context;
}

test('/skill lists registered references; substring and description terms search the same shared catalog', () => {
  const { slash } = fixture();
  assert.deepEqual(Array.from(slash.items('room', 'skill'), x => x.name), ['writer', 'visual-check']);
  assert.equal(slash.items('room', 'skill 中文 style')[0].name, 'writer');
  assert.equal(slash.items('room', 'skill visual')[0].name, 'visual-check');
  assert.equal(slash.items('room', 'skill wri')[0].name, 'writer');
  assert.equal(slash.items('room', 'writing')[0].name, 'writer');
  assert.equal(slash.items('room', 'skill no-match').length, 0);
  assert.ok(slash.items('room', 'model').some(x => x.command));
  assert.deepEqual(Array.from(slash.items('room', 'skill')[0].cliTypes), ['codex', 'claude']);
  assert.equal(slash.items('room', 'skill polish')[0].name, 'writer');
});

test('old references reuse matching metadata from an explicit library scan without reading sources', () => {
  const f = fixture();
  f.state.importedSkills = [{ name: 'Legacy', alias: 'old', sourcePath: 'C:/SKILLS/Old', cliTypes: ['codex'] }];
  assert.equal(f.slash.items('room', 'skill 中文').length, 0);
  f.state.externalSkills = [{ sourcePath: 'c:/skills/old', description: '改善中文表达' }];
  assert.equal(f.slash.items('room', 'skill 中文')[0].name, 'old');
  assert.equal(f.state.importedSkills[0].description, undefined, 'search does not mutate stored references');
});

test('completion selects the full skill query without eating earlier message text or URL paths', () => {
  const { slash } = fixture();
  const text = '@Bot 请用 /skill 中文 style';
  const found = slash.detect(text);
  assert.equal(found.query, 'skill 中文 style');
  assert.equal(text.slice(found.start, found.end), '/skill 中文 style');
  assert.equal(text.slice(0, found.start), '@Bot 请用 ');
  assert.equal(slash.detect('https://example.test/skill'), null);
  assert.equal(slash.detect('/skill\n正文'), null);
  assert.equal(slash.detect('/skill ' ).query, 'skill ');
  assert.equal(slash.detect('/context').query, 'context');
});

test('reference descriptions persist as metadata; old records remain readable and invalid descriptions cannot overwrite', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-skill-search-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'skill'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'SKILL.md'), 'PRIVATE_BODY');
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  const saved = references.register(data, { name: 'Writing', alias: 'writer', sourcePath: source,
    cliTypes: ['codex'], description: '改善中文表达' });
  assert.equal(references.list(data)[0].description, '改善中文表达');
  const filename = path.join(data, 'skill-references.json'), before = fs.readFileSync(filename, 'utf8');
  assert.ok(!before.includes('PRIVATE_BODY'));
  assert.throws(() => references.register(data, { name: 'Writing', sourcePath: source, cliTypes: ['codex'], description: {} }), /说明/);
  assert.equal(fs.readFileSync(filename, 'utf8'), before);
  delete saved.description; fs.writeFileSync(filename, JSON.stringify([saved]));
  assert.equal(references.list(data)[0].alias, 'writer');
});

test('unconfigured capability policy inherits without consulting inventory or constructing overrides', async () => {
  for (const cliType of ['codex', 'claude', 'other']) {
    const result = await prepare({ cliType }, process.cwd(), { discovery: () => { throw new Error('must not scan'); } });
    assert.deepEqual(result.nativeArgs, []); assert.equal(result.nativeConfig, null); result.cleanup();
  }
});


test('every /skill prefix keeps candidates and incompatible room types are labeled before dispatch', () => {
  const f = fixture();
  for (const prefix of ['s', 'sk', 'ski', 'skil', 'skill']) {
    assert.deepEqual(Array.from(f.slash.items('room', prefix).filter(x => !x.command), x => x.name), ['writer', 'visual-check']);
  }
  assert.ok(f.slash.items('room', 's').some(x => x.command && x.name === 'stop'));
  f.state.rooms = [{ id: 'room', botIds: ['b'] }]; f.state.bots = [{ id: 'b', cliType: 'codex' }];
  const items = f.slash.items('room', 'skill');
  assert.equal(items.find(x => x.name === 'writer').unavailableInRoom, false);
  assert.equal(items.find(x => x.name === 'visual-check').unavailableInRoom, true);
  assert.match(items.find(x => x.name === 'visual-check').description, /无适用 Agent/);
});

test('native skill paths constrain new and legacy references; shared sources remain reusable', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-skill-scope-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, '.codex', 'skills', '.system', 'fixture'); fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, 'SKILL.md'), 'fixture');
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  assert.throws(() => references.register(data, { name: 'fixture', sourcePath: source, cliTypes: ['claude', 'codex'] }), /只能登记/);
  const saved = references.register(data, { name: 'fixture', sourcePath: source, cliTypes: ['codex'] });
  assert.equal(saved.nativeCliType, 'codex');
  // A pre-fix record cannot pretend a Codex system skill is installed in Claude.
  saved.cliTypes = ['codex', 'claude']; fs.writeFileSync(path.join(data, 'skill-references.json'), JSON.stringify([saved]));
  assert.deepEqual(references.list(data)[0].cliTypes, ['codex']);
  assert.throws(() => references.resolve(data, { alias: 'fixture', cliType: 'claude' }), /不适用于 claude/);
  const shared = path.join(root, 'shared'); fs.mkdirSync(shared); fs.writeFileSync(path.join(shared, 'SKILL.md'), 'fixture');
  references.register(data, { name: 'shared', sourcePath: shared, cliTypes: ['claude', 'codex'] });
  assert.equal(references.resolve(data, { alias: 'shared', cliType: 'claude' }).category, 'other');
});

test('direct registration is idempotent, scopes native/custom sources, and shares general sources with newly enabled Agents', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-direct-skill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  const candidate = relative => {
    const sourcePath = path.join(root, relative); fs.mkdirSync(sourcePath, { recursive: true });
    fs.writeFileSync(path.join(sourcePath, 'SKILL.md'), 'Actual fixture instructions');
    return { name: 'same-name', sourcePath };
  };
  const kimi = candidate('.kimi/skills/writer');
  const native = references.registerDiscovered(data, kimi, { enabledCliIds: ['claude', 'kimi'] });
  assert.deepEqual(native.cliTypes, ['kimi']);
  assert.equal(native.category, 'kimi');
  assert.equal(references.registerDiscovered(data, kimi, { enabledCliIds: ['kimi'] }).id, native.id);
  const shared = references.registerDiscovered(data, candidate('shared/writer'), { enabledCliIds: ['claude', 'kimi'] });
  assert.notEqual(shared.alias, native.alias);
  assert.equal(shared.sharedForAll, true);
  fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ enabledCliIds: ['claude', 'kimi', 'codex'] }));
  assert.equal(references.resolve(data, { alias: shared.alias, cliType: 'codex' }).id, shared.id);
  const customId = 'custom_' + 'a'.repeat(32);
  const custom = candidate('custom-agent/skills/writer');
  const customRecord = references.registerDiscovered(data, custom, { enabledCliIds: [customId, 'codex'], owners: { [path.join(root, 'custom-agent')]: customId } });
  assert.deepEqual(references.list(data).find(item => item.id === customRecord.id).cliTypes, [customId]);
  assert.throws(() => references.resolve(data, { alias: customRecord.alias, cliType: 'claude' }), /不适用于/);
  assert.throws(() => references.registerDiscovered(data, candidate('.codex/skills/disabled'), { enabledCliIds: ['kimi'] }), /先在 Agent/);
  references.remove(data, shared.id);
  assert.equal(references.list(data).some(item => item.id === shared.id), false);
  assert.ok(fs.existsSync(shared.skillFile));
});
