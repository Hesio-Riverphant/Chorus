'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const RELEASE_POLICY = require('./release-policy.json');
const { allowedRuntimeFile, verifyRuntimeDependencies } = require('./runtime-files');

const APP_ROOT_FILES = ['LICENSE', 'README.md', 'README.en.md', 'THIRD_PARTY.md'];
const SOURCE_ROOT_FILES = ['package.json', 'package-lock.json', '.gitignore', ...APP_ROOT_FILES];
const SOURCE_DOCS = ['docs/RELEASE.md', 'docs/ARCHITECTURE.md', 'docs/PLAN.md', 'docs/REFERENCES.md', 'docs/CLI.md'];
const SOURCE_WORKFLOWS = ['.github/workflows/windows.yml', '.github/workflows/desktop.yml'];
const FORBIDDEN_COMPONENT = /^(?:data|logs|handoffs|workspace|\.git|\.codex|\.claude|\.kimi|\.kimi-code|\.agents|\.gemini|\.qwen|\.copilot|\.cursor|\.factory|\.zcode|\.trae|\.codebuddy|node_modules)$/i;
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\..*)?|auth\.json|credentials[^/]*|sessions\.json|rooms\.json|bots\.json|settings\.json)$|\.(?:key|pem|p12|pfx|jsonl|sqlite(?:3)?|db|log)$/i;
const TEXT_EXTENSIONS = /\.(?:[cm]?js|json|html|css|md|txt|svg|ya?ml|ps1|cmd|sh|nsh)$/i;
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const slash = value => value.split(path.sep).join('/');

function filesUnder(root, relative = '') {
  const directory = fs.lstatSync(path.join(root, relative));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error(`Release input directory must not be a symbolic link: ${slash(relative)}`);
  const result = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const name = path.join(relative, entry.name);
    const stat = fs.lstatSync(path.join(root, name));
    if (stat.isSymbolicLink()) throw new Error(`Symbolic links are excluded from release: ${slash(name)}`);
    if (stat.isDirectory()) result.push(...filesUnder(root, name));
    else if (stat.isFile()) result.push(slash(name));
    else throw new Error(`Unsupported release file: ${slash(name)}`);
  }
  return result;
}
function publicationFiles(root) {
  const files = ['src', 'scripts'].flatMap(dir => fs.existsSync(path.join(root, dir)) ? filesUnder(root, dir) : []);
  for (const file of [...SOURCE_ROOT_FILES, ...SOURCE_DOCS, ...SOURCE_WORKFLOWS]) if (fs.existsSync(path.join(root, file))) files.push(file);
  return [...new Set(files)].sort();
}
function scanFiles(root, files) {
  const findings = [];
  for (const file of files) {
    if (file.split('/').some(part => FORBIDDEN_COMPONENT.test(part)) || SECRET_FILE.test(file)) {
      findings.push({ file, code: 'private-path', detail: 'Runtime or credential files are excluded from publication.' }); continue;
    }
    if (!TEXT_EXTENSIONS.test(file)) continue;
    const stat = fs.statSync(path.join(root, file));
    if (stat.size > 4 * 1024 * 1024) { findings.push({ file, code: 'oversize-text', detail: 'Text file requires separate review.' }); continue; }
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{30,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/.test(line)) {
        findings.push({ file, line: index + 1, code: 'credential-shaped-content', detail: 'Review required; matched content is not printed.' });
      }
      if (/\.(?:md|txt|html)$/i.test(file) && /(?:[A-Za-z]:[\\/](?:Users[\\/][^\\/\s`<>]+|GitHub[\\/]|Obsidian-Vault[\\/]|AI-Tools-Map[\\/]))/.test(line)) {
        findings.push({ file, line: index + 1, code: 'personal-document-path', detail: 'Replace machine-specific paths with portable instructions.' });
      }
    }
  }
  return findings;
}
function checkDocumentLinks(root, files) {
  const available = new Set(files);
  const findings = [];
  for (const file of files.filter(file => /\.md$/i.test(file))) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    const links = text.matchAll(/!?\[[^\]]*\]\((?:<([^>]+)>|([^\s)]+))(?:\s+"[^"]*")?\)/g);
    for (const match of links) {
      const href = match[1] || match[2];
      if (href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      let target;
      try { target = decodeURIComponent(href.split(/[?#]/)[0]); } catch (_) { target = ''; }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      if (!target || target.startsWith('/') || target.includes('\\') || !available.has(resolved)) {
        findings.push({ file, line: text.slice(0, match.index).split('\n').length, code: 'unbundled-document-link', detail: 'A relative documentation link points outside the release file list.' });
      }
    }
  }
  return findings;
}
function auditSource(root, { checkGit = true, syntax = true } = {}) {
  const failures = [], warnings = [];
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files = publicationFiles(root);
  failures.push(...scanFiles(root, files));
  failures.push(...checkDocumentLinks(root, files));
  const electron = manifest.devDependencies?.electron;
  if (!/^\d+\.\d+\.\d+$/.test(electron || '')) failures.push({ file: 'package.json', code: 'unpinned-runtime', detail: 'Pin Electron to the exact tested version.' });
  const major = Number((electron || '').match(/\d+/)?.[0]);
  if (Number.isFinite(major) && major < RELEASE_POLICY.latestStableMajor - RELEASE_POLICY.supportedMajorCount + 1) {
    failures.push({ file: 'package.json', code: 'unsupported-electron-major', detail: `Electron ${major} is outside the officially supported majors in the ${RELEASE_POLICY.checkedAt} policy snapshot; upgrade and rerun runtime tests before public release.` });
  }
  const lockFile = path.join(root, 'package-lock.json');
  if (!fs.existsSync(lockFile)) failures.push({ file: 'package-lock.json', code: 'missing-lockfile', detail: 'Commit a reviewed lockfile so npm ci can reproduce dependencies.' });
  else {
    try {
      const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
      if (lock.packages?.['']?.devDependencies?.electron !== electron || lock.packages?.['node_modules/electron']?.version !== electron) {
        failures.push({ file: 'package-lock.json', code: 'runtime-lock-mismatch', detail: 'The manifest and locked Electron version must match.' });
      }
    } catch (_) { failures.push({ file: 'package-lock.json', code: 'invalid-lockfile', detail: 'Lockfile is not valid JSON.' }); }
  }
  if (fs.existsSync(lockFile)) {
    try { verifyRuntimeDependencies(root); }
    catch (error) { failures.push({ file: 'package-lock.json', code: 'runtime-dependency-policy', detail: error.message }); }
  }
  if (syntax) for (const file of files.filter(file => /\.[cm]?js$/.test(file))) {
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) failures.push({ file, code: 'syntax-error', detail: 'JavaScript syntax check failed; run node --check on this file.' });
  }
  if (checkGit) {
    try {
      const candidates = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).split('\0').filter(Boolean);
      for (const file of candidates) if ((file.split('/').some(part => FORBIDDEN_COMPONENT.test(part)) && !/^(?:data|logs|workspace)\/\.gitkeep$/.test(file)) || SECRET_FILE.test(file)) {
        failures.push({ file, code: 'git-publication-path', detail: 'Private file is tracked or visible to git add; ignore or untrack it before publication.' });
      }
      // Tracked docs beyond the curated archive deserve the same privacy check.
      failures.push(...scanFiles(root, candidates.filter(file => /^docs\/.+\.(?:md|txt)$/i.test(file) && fs.existsSync(path.join(root, file)) && !files.includes(file))));
    } catch (_) { warnings.push({ code: 'git-inventory-unavailable', detail: 'Git publication inventory could not be checked.' }); }
  }
  warnings.push({ code: 'runtime-validation', detail: 'Static checks do not replace unit/UI tests, packaged startup, real CLI connection tests, or long-session acceptance.' });
  return { ok: failures.length === 0, files: files.length, runtimePolicyCheckedAt: RELEASE_POLICY.checkedAt, failures, warnings };
}
function auditBundle(directory) {
  const failures = [];
  const filename = path.join(directory, 'RELEASE-MANIFEST.json');
  if (!fs.existsSync(filename)) return { ok: false, failures: [{ code: 'missing-release-manifest' }] };
  const manifest = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!manifest || !Array.isArray(manifest.files)) return { ok: false, failures: [{ code: 'invalid-release-manifest' }] };
  const actual = filesUnder(directory).filter(file => file !== 'RELEASE-MANIFEST.json');
  const expected = new Set();
  for (const item of manifest.files) {
    if (!item || typeof item.path !== 'string' || item.path.includes('\\') || path.posix.isAbsolute(item.path) || item.path.split('/').some(part => !part || part === '..' || part === '.') || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      failures.push({ code: 'invalid-file-record' }); continue;
    }
    expected.add(item.path);
    const target = path.join(directory, item.path);
    if (!fs.existsSync(target) || sha256(fs.readFileSync(target)) !== item.sha256) failures.push({ file: item.path, code: 'hash-mismatch' });
  }
  for (const file of actual) if (!expected.has(file)) failures.push({ file, code: 'unexpected-file' });
  const app = path.join(directory, 'resources', 'app');
  if (manifest.kind === 'desktop') {
    if (!fs.existsSync(path.join(directory, manifest.platform === 'linux' ? 'chorus' : 'Chorus.exe')) || !fs.existsSync(path.join(app, 'desktop-bootstrap.js'))) failures.push({ code: 'missing-desktop-entry' });
    for (const license of ['LICENSE.electron.txt', 'LICENSES.chromium.html']) {
      if (!fs.existsSync(path.join(directory, license))) failures.push({ file: license, code: 'missing-runtime-license' });
    }
    if (fs.existsSync(app)) {
      const appFiles = filesUnder(app);
      const allowedRoots = new Set(['src', 'package.json', 'desktop-bootstrap.js', ...APP_ROOT_FILES]);
      for (const file of appFiles) if (!allowedRoots.has(file.split('/')[0]) && !SOURCE_DOCS.includes(file) && !allowedRuntimeFile(file)) failures.push({ file: `resources/app/${file}`, code: 'unexpected-app-file' });
      const ownFiles = appFiles.filter(file => !allowedRuntimeFile(file));
      failures.push(...scanFiles(app, ownFiles));
      failures.push(...checkDocumentLinks(app, ownFiles));
    }
  } else if (manifest.kind === 'source') failures.push(...scanFiles(directory, actual), ...checkDocumentLinks(directory, actual));
  else failures.push({ code: 'invalid-release-kind' });
  return { ok: failures.length === 0, kind: manifest.kind, files: actual.length, failures };
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    const bundleIndex = args.indexOf('--bundle');
    const rootIndex = args.indexOf('--root');
    const result = bundleIndex >= 0 ? auditBundle(path.resolve(args[bundleIndex + 1])) : auditSource(rootIndex >= 0 ? path.resolve(args[rootIndex + 1]) : path.resolve(__dirname, '..'));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) { console.error(JSON.stringify({ ok: false, error: error.code || error.message })); process.exitCode = 1; }
}
module.exports = { APP_ROOT_FILES, SOURCE_DOCS, filesUnder, publicationFiles, scanFiles, checkDocumentLinks, auditSource, auditBundle, sha256 };
