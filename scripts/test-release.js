'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { build, bootstrapSource, runtimeFilesForPackaging } = require('./package-desktop');
const { auditSource, auditBundle, scanFiles, checkDocumentLinks } = require('./check-release');
const { allowedRuntimeFile } = require('./runtime-files');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-release-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['src/main', 'scripts', 'docs', 'data', 'logs', 'handoffs']) fs.mkdirSync(path.join(root, directory), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'convoke', version: '0.2.0', main: 'src/main/main.js', devDependencies: { electron: '44.4.5' } }));
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: { '': { devDependencies: { electron: '44.4.5' } }, 'node_modules/electron': { version: '44.4.5' } } }));
  fs.writeFileSync(path.join(root, 'src/main/main.js'), "'use strict';\n");
  fs.writeFileSync(path.join(root, 'README.md'), '# Convoke\n');
  fs.writeFileSync(path.join(root, 'LICENSE'), 'MIT fixture\n');
  fs.writeFileSync(path.join(root, 'data/rooms.json'), '[{"private":"fixture"}]');
  fs.writeFileSync(path.join(root, 'logs/debug.log'), 'private fixture');
  fs.writeFileSync(path.join(root, 'handoffs/private.md'), 'private fixture');
  return root;
}

test('source release copies only its allowlist and detects post-build modifications', t => {
  const root = fixture(t);
  const result = build({ sourceRoot: root, sourceOnly: true, strict: true });
  assert.equal(auditBundle(result.output).ok, true);
  for (const directory of ['data', 'logs', 'handoffs']) assert.equal(fs.existsSync(path.join(result.output, directory)), false);
  fs.appendFileSync(path.join(result.output, 'README.md'), 'modified');
  assert.equal(auditBundle(result.output).ok, false);
});

test('source release retains linked public documentation and its Windows CI definition', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'README.md'), '[Plan](docs/PLAN.md)\n[Release](docs/RELEASE.md)\n');
  fs.writeFileSync(path.join(root, 'docs/PLAN.md'), '# Plan\n[Home](../README.md)\n');
  fs.writeFileSync(path.join(root, 'docs/RELEASE.md'), '# Release\n[Web](https://example.invalid)\n');
  fs.mkdirSync(path.join(root, '.github/workflows'), { recursive: true });
  fs.writeFileSync(path.join(root, '.github/workflows/windows.yml'), 'name: fixture\n');
  const result = build({ sourceRoot: root, sourceOnly: true, strict: true });
  assert.equal(auditBundle(result.output).ok, true);
  for (const file of ['docs/PLAN.md', 'docs/RELEASE.md', '.github/workflows/windows.yml']) assert.equal(fs.existsSync(path.join(result.output, file)), true);
});

test('release link checks reject existing local files that are intentionally excluded from the bundle', t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, 'README.md'), '[Private](handoffs/private.md)');
  const findings = checkDocumentLinks(root, ['README.md']);
  assert.equal(findings[0].code, 'unbundled-document-link');
  assert.equal(auditSource(root, { checkGit: false }).ok, false);
});

test('static source gate rejects unlocked runtime and machine-specific publication paths', t => {
  const root = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  manifest.devDependencies.electron = '^44.0.0'; fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  fs.rmSync(path.join(root, 'package-lock.json'));
  fs.writeFileSync(path.join(root, 'README.md'), 'Example C:\\Users\\fixture-account\\private');
  const result = auditSource(root, { checkGit: false });
  assert.deepEqual(new Set(result.failures.map(item => item.code)), new Set(['personal-document-path', 'unpinned-runtime', 'missing-lockfile']));
  assert.throws(() => build({ sourceRoot: root, sourceOnly: true, strict: true }), /checks failed/);
});

test('privacy reports never repeat credential-shaped contents', t => {
  const root = fixture(t);
  const value = ['sk', 'x'.repeat(40)].join('-');
  fs.writeFileSync(path.join(root, 'README.md'), value);
  const result = scanFiles(root, ['README.md']);
  assert.equal(result[0].code, 'credential-shaped-content');
  assert.equal(JSON.stringify(result).includes(value), false);
});

test('publication refuses native state and conversation databases inside source trees', t => {
  const root = fixture(t);
  const inputs = ['src/.kimi-code/config.json', 'scripts/.gemini/config.json',
    'src/.agents/local.md', 'src/.cursor/settings.json', 'src/.factory/config.json', 'src/.qwen/settings.json',
    'src/.copilot/session.json', 'src/history.jsonl', 'src/chat.sqlite', 'src/runtime.log'];
  for (const file of inputs) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), 'private synthetic fixture');
  }
  const findings = scanFiles(root, inputs);
  assert.equal(findings.length, inputs.length);
  assert.ok(findings.every(item => item.code === 'private-path'));
  assert.throws(() => build({ sourceRoot: root, sourceOnly: true, strict: true }), /checks failed/);
});

test('unsupported Electron can form a local candidate but cannot pass the production release gate', t => {
  const root = fixture(t);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  manifest.devDependencies.electron = '37.10.3'; fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  lock.packages[''].devDependencies.electron = '37.10.3'; lock.packages['node_modules/electron'].version = '37.10.3';
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify(lock));
  assert.equal(auditSource(root, { checkGit: false }).failures[0].code, 'unsupported-electron-major');
  assert.throws(() => build({ sourceRoot: root, sourceOnly: true, strict: true }), /checks failed/);
  const candidate = build({ sourceRoot: root, sourceOnly: true });
  assert.equal(candidate.staticChecksPassed, false);
  assert.equal(candidate.pending[0].code, 'unsupported-electron-major');
});

test('bundle validation rejects unrecorded files and unsafe manifest paths', t => {
  const root = fixture(t);
  const result = build({ sourceRoot: root, sourceOnly: true, strict: true });
  fs.writeFileSync(path.join(result.output, 'surprise.txt'), 'unexpected');
  assert.ok(auditBundle(result.output).failures.some(item => item.code === 'unexpected-file'));
  const filename = path.join(result.output, 'RELEASE-MANIFEST.json');
  const manifest = JSON.parse(fs.readFileSync(filename));
  manifest.files.push({ path: '../outside', sha256: 'a'.repeat(64) });
  fs.writeFileSync(filename, JSON.stringify(manifest));
  assert.ok(auditBundle(result.output).failures.some(item => item.code === 'invalid-file-record'));
});

test('packaged bootstrap is valid JavaScript and places isolation before application startup', () => {
  const source = bootstrapSource();
  assert.doesNotThrow(() => new Function(source));
  assert.ok(source.indexOf("app.setPath('userData', directory)") < source.indexOf("require('./src/main/main.js')"));
  assert.match(source, /convoke-smoke-token/);
  assert.match(source, /agent-room/);
});

test('packaged runtime permits only declared terminal files and rejects unrelated runtime contents', () => {
  assert.equal(allowedRuntimeFile('node_modules/node-pty/prebuilds/win32-x64/conpty.node'), true);
  assert.equal(allowedRuntimeFile('node_modules/@xterm/xterm/lib/xterm.js'), true);
  assert.equal(allowedRuntimeFile('node_modules/node-pty/lib/windowsPtyAgent.js'), true);
  for (const file of ['node_modules/node-pty/auth.json', 'node_modules/node-pty/lib/agent.test.js', 'node_modules/node-pty/prebuilds/darwin-x64/pty.node', 'node_modules/unreviewed/index.js']) assert.equal(allowedRuntimeFile(file), false);
});

test('Linux terminal packaging copies native runtime files without traversing build intermediates', t => {
  const root = fixture(t);
  const base = 'node_modules/node-pty';
  for (const file of ['package.json', 'LICENSE', 'lib/unixTerminal.js', 'build/Release/pty.node', 'build/Release/spawn-helper',
    'build/Release/obj.target/compiler.o', 'prebuilds/win32-x64/conpty.node']) {
    fs.mkdirSync(path.dirname(path.join(root, base, file)), { recursive: true });
    fs.writeFileSync(path.join(root, base, file), 'fixture');
  }
  const files = runtimeFilesForPackaging(root, 'node-pty', 'linux');
  assert.ok(files.includes(base + '/build/Release/pty.node'));
  assert.ok(files.includes(base + '/build/Release/spawn-helper'));
  assert.equal(files.some(file => file.includes('obj.target') || file.includes('win32')), false);
  assert.equal(allowedRuntimeFile(base + '/build/Release/pty.node', 'win32'), false);
});

test('installer packaging enforces native platform and keeps app data on uninstall', async () => {
  const { builderConfiguration, packageInstallers } = require('./package-installers');
  const config = builderConfiguration(path.resolve(__dirname, '..'), 'fixture-output');
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.nsis.runAfterFinish, false);
  assert.deepEqual(config.win.target, ['nsis', 'zip']);
  assert.deepEqual(config.linux.target, ['deb', 'zip']);
  await assert.rejects(packageInstallers({ platform: 'darwin' }), /native|Build Windows/);
});


test('installer configuration validates against the pinned builder schema', async () => {
  const { builderConfiguration } = require('./package-installers');
  const { validateConfiguration } = require('app-builder-lib/out/util/config/config');
  const config = builderConfiguration(path.resolve(__dirname, '..'), path.join(__dirname, 'fixture-output'));
  await validateConfiguration(config, { isEnabled: false });
});
