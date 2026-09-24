'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const scanner = require('../src/main/skills/skillScanner');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-skills-'));
try {
  const store = path.join(root, 'skills');
  const source = path.join(root, 'fixture.md');
  fs.writeFileSync(source, '---\nname: fixture\ndescription: test fixture\n---\nSafe test instructions');
  scanner.importSkill(store, source, 'fixture');
  const expected = scanner.readSkillBody(store, 'fixture');
  assert.ok(expected.includes('Safe test'));
  for (const name of ['..', '../outside', 'x/y', 'x\\y', '', 'C:outside', 'NUL', 'trailing.']) {
    assert.throws(() => scanner.importSkill(store, source, name));
    assert.throws(() => scanner.removeImported(store, name));
  }
  assert.throws(() => scanner.importSkill(store, path.join(root, 'missing.md'), 'fixture'));
  assert.equal(scanner.readSkillBody(store, 'fixture'), expected);
  assert.throws(() => scanner.importSkill(store, root, 'parent'));
  assert.deepEqual(scanner.listImported(store).map((s) => s.name), ['fixture']);
  // Simulate both installation and rollback being blocked by the filesystem.
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (['skill', 'previous'].includes(path.basename(from))) throw Object.assign(new Error('locked'), { code: 'EACCES' });
    return rename(from, to);
  };
  try { assert.throws(() => scanner.importSkill(store, source, 'fixture'), /旧副本已保留/); }
  finally { fs.renameSync = rename; }
  const recovery = fs.readdirSync(store).find((name) => name.startsWith('.import-'));
  assert.equal(fs.readFileSync(path.join(store, recovery, 'previous', 'SKILL.md'), 'utf8'), expected);
  console.log('PASS skills: import, invalid names, failed replacement preserves prior copy');

  // Discovery runs against fixtures only; known machine roots are intercepted
  // before any filesystem read. No personal/shared skill bodies are accessed.
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const custom = path.join(root, 'custom');
  const body = 'PRIVATE BODY MUST NOT BE READ\n';
  const make = (dir, name = 'same-name', description = 'Fixture metadata') => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'SKILL.md');
    fs.writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
    return file;
  };
  const personal = make(path.join(home, '.codex', 'skills', '.system', 'fixture'));
  const projectFile = make(path.join(project, '.agents', 'skills', 'fixture'));
  const customFile = make(path.join(custom, 'group', 'fixture'));
  const appCopy = path.join(custom, 'copies');
  make(appCopy, 'excluded');
  const promptDir = path.join(home, '.codex', 'prompts');
  fs.mkdirSync(promptDir, { recursive: true });
  fs.copyFileSync(personal, path.join(promptDir, 'fixture.md'));
  const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(customFile)).digest('hex');
  const scannerFile = require.resolve('../src/main/skills/skillScanner');
  const moduleObject = { exports: {} };
  const code = fs.readFileSync(scannerFile, 'utf8');
  const opened = new Map();
  const reads = [];
  let readBytes = 0;
  let readDirs = 0;
  let deny = null;
  let pretendLink = null;
  const blocked = (p) => {
    const absolute = path.resolve(p);
    if (deny && absolute === deny) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
    if (absolute !== root && !absolute.startsWith(root + path.sep) && !root.startsWith(absolute + path.sep)) {
      throw Object.assign(new Error('outside fixture'), { code: 'ENOENT' });
    }
  };
  const fixtureFs = new Proxy(fs, { get(target, property) {
    if (['lstatSync', 'opendirSync', 'openSync'].includes(property)) return (...args) => {
      blocked(args[0]);
      if (property === 'lstatSync' && path.resolve(args[0]) === pretendLink) return { isSymbolicLink: () => true };
      if (property === 'opendirSync') readDirs += 1;
      const value = target[property](...args);
      if (property === 'openSync') opened.set(value, { path: args[0], bytes: 0 });
      return value;
    };
    if (property === 'readSync') return (fd, ...args) => {
      const n = target.readSync(fd, ...args);
      opened.get(fd).bytes += n;
      readBytes += n;
      return n;
    };
    if (property === 'closeSync') return (fd) => {
      reads.push(opened.get(fd));
      opened.delete(fd);
      return target.closeSync(fd);
    };
    if (property === 'readFileSync') return () => { throw new Error('Discovery must not read a whole skill body'); };
    return target[property];
  } });
  vm.runInNewContext(code, {
    require: (name) => name === 'fs' ? fixtureFs : name === 'os' ? { homedir: () => home } : require('node:module').createRequire(scannerFile)(name),
    module: moduleObject, __dirname: path.dirname(scannerFile), Buffer,
    process: { platform: process.platform, env: {} },
  });
  const isolated = moduleObject.exports;
  let report = isolated.discoverExternalDetailed({ cwd: project, roots: [custom, custom], skillsDir: appCopy });
  assert.equal(report.skills.filter((s) => s.name === 'same-name').length, 4);
  assert.equal(new Set(report.skills.map((s) => s.sourcePath)).size, 4);
  assert.ok(report.skills.some((s) => s.sourcePath.includes('.system')));
  assert.ok(report.skills.every((s) => s.description === 'Fixture metadata'));
  assert.ok(!report.skills.some((s) => s.name === 'excluded'));
  assert.ok(report.warnings.some((w) => w.includes('应用技能副本')));
  assert.ok(report.roots.some((r) => r.path.endsWith(path.join('.kimi', 'skills')) && r.status === 'missing'));
  for (const info of reads) {
    const content = fs.readFileSync(info.path);
    assert.ok(info.bytes <= content.indexOf(Buffer.from(body)), 'discovery read instruction body');
  }
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(customFile)).digest('hex'), sourceHash);
  const importedCopy = path.join(root, 'copy-test');
  scanner.importSkill(importedCopy, path.dirname(customFile), 'fixture-copy');
  scanner.removeImported(importedCopy, 'fixture-copy');
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(customFile)).digest('hex'), sourceHash);
  assert.equal(isolated.discoverExternal({ cwd: project, roots: [custom], skillsDir: appCopy }).length, 4);
  make(path.join(home, '.claude', 'skills', 'claude-fixture'), 'claude-fixture');
  for (const category of ['claude', 'codex', 'other']) {
    const scoped = isolated.discoverExternalDetailed({ cwd: project, roots: [custom], skillsDir: appCopy, category });
    assert.ok(scoped.skills.length > 0);
    assert.ok(scoped.skills.every(skill => skill.category === category));
    assert.ok(scoped.roots.every(root => isolated.sourceScope(root.path).category === category));
  }
  assert.equal(isolated.sourceScope(path.join(custom, 'codex-writing')).nativeCliType, null);
  assert.throws(() => isolated.discoverExternalDetailed({ category: 'invalid' }), /分类/);
  const kimiFile = make(path.join(project, '.kimi-code', 'skills', 'writer'), 'kimi-writer');
  const pluginFile = make(path.join(home, '.codex', 'plugins', 'cache', 'vendor', 'plugin', 'version', 'skills', 'writer'), 'plugin-writer');
  const kimiResult = isolated.discoverExternalDetailed({ cwd: project, roots: [path.dirname(kimiFile)], category: 'kimi', categories: ['kimi', 'codex'] });
  assert.equal(kimiResult.skills.length, 2);
  assert.ok(kimiResult.skills.some(skill => skill.sourcePath === path.dirname(projectFile) && skill.nativeCliTypes.includes('kimi')));
  assert.equal(kimiResult.skills[0].nativeCliType, 'kimi');
  const pluginResult = isolated.discoverExternalDetailed({ category: 'codex' });
  assert.ok(pluginResult.skills.some(skill => skill.sourcePath === path.dirname(pluginFile) && skill.nativeCliType === 'codex'));
  const customId = 'custom_' + 'a'.repeat(32);
  const customOwned = isolated.discoverExternalDetailed({ roots: [custom], category: customId, categories: [customId], owners: { [custom]: customId }, skillsDir: appCopy });
  assert.equal(customOwned.skills.length, 1);
  assert.equal(customOwned.skills[0].category, customId);
  const general = isolated.discoverExternalDetailed({ cwd: project, roots: [custom], category: 'other', owners: { [custom]: customId }, skillsDir: appCopy });
  assert.equal(general.skills.length, 0);
  deny = custom;
  report = isolated.discoverExternalDetailed({ roots: [custom, 'relative/path'] });
  assert.equal(report.roots.find((r) => r.path === custom).status, 'error');
  assert.ok(report.warnings.some((w) => w.includes('EACCES')));
  assert.ok(report.warnings.some((w) => w.includes('非绝对路径')));
  deny = null;
  pretendLink = custom;
  report = isolated.discoverExternalDetailed({ roots: [custom] });
  assert.equal(report.roots.find((r) => r.path === custom).status, 'skipped_link');
  assert.ok(!report.skills.some((s) => s.sourcePath === path.dirname(customFile)));
  pretendLink = null;
  const deep = path.join(root, 'deep');
  make(path.join(deep, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), 'too-deep');
  report = isolated.discoverExternalDetailed({ roots: [deep] });
  assert.equal(report.truncated, true);
  assert.ok(report.warnings.some((w) => w.includes('深度')));
  assert.ok(!report.skills.some((s) => s.name === 'too-deep'));

  const filtered = path.join(root, 'filtered');
  const staleFile = make(path.join(filtered, 'old', 'local'), 'shared-name');
  const freshFile = make(path.join(filtered, 'new', 'local'), 'shared-name');
  fs.utimesSync(staleFile, 100, 100); fs.utimesSync(freshFile, 200, 200);
  const ignored = ['rollback', '.rollback', 'rollbacks', 'fallback-old', '.fallback', 'handoff', 'handoffs',
    '.handoffs', 'snapshot-20260924', '.snapshot', 'backups', '.candidate-build', '.venv', 'venv',
    'virtualenv', 'site-packages', '__pycache__', 'node_modules', '.git'];
  for (const dir of ignored) make(path.join(filtered, dir, 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), 'ignored');
  const runtime = path.join(filtered, 'python-runtime');
  make(path.join(runtime, 'lib', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'), 'ignored');
  fs.writeFileSync(path.join(runtime, 'pyvenv.cfg'), '');
  make(path.join(filtered, '.claude', 'skills', 'shared'), 'shared-name');
  make(path.join(filtered, '.codex', 'skills', 'shared'), 'shared-name');
  reads.length = 0;
  report = isolated.discoverExternalDetailed({ roots: [filtered], category: 'other' });
  assert.equal(report.truncated, false, 'ignored deep copies must not consume scan depth');
  assert.equal(report.skills.length, 1);
  assert.equal(report.skills[0].sourcePath, path.dirname(freshFile));
  assert.equal(report.skills[0].modifiedAt, 200000);
  assert.equal(reads.length, 2, 'excluded skill metadata must not be read');
  report = isolated.discoverExternalDetailed({ roots: [filtered] });
  assert.equal(report.skills.filter(skill => skill.name === 'shared-name').length, 3, 'native same-name sources stay separate');
  report = isolated.discoverExternalDetailed({ roots: [path.join(filtered, 'rollback')], category: 'other' });
  assert.equal(report.roots[0].status, 'filtered');
  assert.equal(report.skills.length, 0);
  console.log('PASS discovery: ignored backups/dependencies, newest shared source, native applicability');

  const active = path.join(root, 'active-skill-names');
  for (const name of ['backup-database', 'rollback-strategy', 'candidate-evaluation']) make(path.join(active, name), name);
  for (const name of ['.rollback-copy', 'backup', 'snapshot-20260924', 'fallback-old']) make(path.join(active, name), 'excluded-backup');
  report = isolated.discoverExternalDetailed({ roots: [active], category: 'other' });
  assert.deepEqual(Array.from(report.skills, skill => skill.name).sort(), ['backup-database', 'candidate-evaluation', 'rollback-strategy']);
  const explicit = isolated.discoverExternalDetailed({ roots: [path.join(active, 'backup-database')], category: 'other' });
  assert.equal(explicit.skills[0].name, 'backup-database');
  assert.equal(explicit.roots[0].status, 'ok');
  console.log('PASS discovery: active descriptive skills survive backup filtering and direct selection');

  const referenceData = path.join(root, 'reference-scope-data');
  fs.mkdirSync(referenceData);
  fs.writeFileSync(path.join(referenceData, 'settings.json'), JSON.stringify({ enabledCliIds: ['claude', 'codex'] }));
  const nativeDeploy = path.dirname(make(path.join(root, '.claude', 'skills', 'deploy'), 'deploy'));
  const sharedDeploy = path.dirname(make(path.join(root, 'shared', 'deploy'), 'deploy'));
  const references = require('../src/main/skills/skillReferences');
  const nativeReference = references.registerDiscovered(referenceData, { name: 'deploy', sourcePath: nativeDeploy }, { enabledCliIds: ['claude', 'codex'] });
  const sharedReference = references.registerDiscovered(referenceData, { name: 'deploy', sourcePath: sharedDeploy }, { enabledCliIds: ['claude', 'codex'] });
  assert.notEqual(sharedReference.alias, nativeReference.alias);
  assert.equal(references.resolve(referenceData, { alias: nativeReference.alias, cliType: 'claude' }).sourcePath, nativeDeploy);
  for (const cliType of ['claude', 'codex']) assert.equal(references.resolve(referenceData, { alias: sharedReference.alias, cliType }).sourcePath, sharedDeploy);
  console.log('PASS references: shared same-name registration keeps native alias and resolves for every enabled Agent');

  const wide = path.join(root, 'wide');
  fs.mkdirSync(wide);
  for (let i = 0; i < 1050; i++) fs.mkdirSync(path.join(wide, `d${i}`));
  readDirs = 0;
  report = isolated.discoverExternalDetailed({ roots: [wide] });
  assert.equal(report.truncated, true);
  assert.ok(readDirs <= 1024);
  const huge = path.join(root, 'huge');
  make(huge);
  fs.writeFileSync(path.join(huge, 'SKILL.md'), '---\nname: huge\ndescription: ' + 'x'.repeat(20000));
  readBytes = 0;
  report = isolated.discoverExternalDetailed({ roots: [huge] });
  assert.equal(report.truncated, true);
  assert.ok(report.warnings.some((w) => w.includes('8192')));
  assert.ok(readBytes < 9000);
  // Explicit selection must remain reachable even when a default root alone
  // fills the global candidate limit.
  for (let i = 0; i < 530; i++) make(path.join(home, '.codex', 'skills', `bulk-${i}`), `bulk-${i}`);
  report = isolated.discoverExternalDetailed({ roots: [path.dirname(customFile)] });
  assert.equal(report.skills[0].sourcePath, path.dirname(customFile));
  assert.equal(report.roots[0].path, path.dirname(customFile));
  assert.equal(report.truncated, true);
  assert.ok(report.skills.length <= 512);
  console.log('PASS discovery: known roots, hidden system skills, same-name sources, bounded metadata, errors, bounds, source isolation');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
