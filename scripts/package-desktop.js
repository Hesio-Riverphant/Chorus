'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { APP_ROOT_FILES, SOURCE_DOCS, filesUnder, publicationFiles, scanFiles, auditSource, auditBundle, sha256 } = require('./check-release');
const { allowedRuntimeFile, verifyRuntimeDependencies } = require('./runtime-files');

const RUNTIME_FILES = new Set(['electron.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll',
  'dxcompiler.dll', 'dxil.dll', 'ffmpeg.dll', 'icudtl.dat', 'libEGL.dll', 'libGLESv2.dll', 'LICENSE', 'LICENSES.chromium.html',
  'electron', 'chrome-sandbox', 'chrome_crashpad_handler', 'libEGL.so', 'libGLESv2.so', 'libffmpeg.so', 'libvk_swiftshader.so', 'libvulkan.so.1', 'vulkan_icd.json',
  'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'version', 'vk_swiftshader_icd.json', 'vk_swiftshader.dll', 'vulkan-1.dll']);

function bootstrapSource() {
  return `'use strict';
const { app, BrowserWindow, dialog } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
app.setName('Chorus');
const smokeArg = process.argv.find(arg => arg.startsWith('--convoke-release-smoke='));
let smoke = false;
if (smokeArg) {
  const nonce = smokeArg.slice('--convoke-release-smoke='.length);
  const directory = process.env.CONVOKE_RELEASE_SMOKE_DIR;
  if (!/^[a-f0-9]{32}$/.test(nonce) || typeof directory !== 'string' ||
      !path.isAbsolute(directory) || path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('convoke-release-smoke-') ||
      fs.lstatSync(directory).isSymbolicLink() ||
      fs.readFileSync(path.join(directory, '.convoke-smoke-token'), 'utf8') !== nonce) {
    app.exit(2); throw new Error('Invalid isolated release smoke directory');
  }
  app.setPath('userData', directory);
  app.setPath('sessionData', directory);
  app.setAppLogsPath(path.join(directory, 'logs'));
  const setPath = app.setPath.bind(app);
  app.setPath = (name, value) => {
    if (['userData', 'sessionData'].includes(name) && path.resolve(value) !== path.resolve(directory)) {
      process.stdout.write('CONVOKE_RELEASE_SMOKE_FAILED\\n'); app.exit(2);
      throw new Error('Release smoke data isolation was overridden');
    }
    return setPath(name, value);
  };
  smoke = true;
} else {
  // Product branding changes independently of the existing packaged data path.
  app.setPath('userData', path.join(app.getPath('appData'), 'agent-room'));
}
if (smoke) {
  dialog.showErrorBox = () => { process.stdout.write('CONVOKE_RELEASE_SMOKE_FAILED\\n'); app.exit(2); };
  BrowserWindow.prototype.show = function () {};
  let finished = false;
  const timeout = setTimeout(() => { process.stdout.write('CONVOKE_RELEASE_SMOKE_FAILED\\n'); app.exit(2); }, 20000);
  app.on('browser-window-created', (_event, win) => {
    win.webContents.on('did-finish-load', async () => {
      if (finished) return;
      try {
        const ready = await win.webContents.executeJavaScript(
          '(async () => { const initial = await window.api.getInitial(); for (let i = 0; i < 30; i++) { if (document.querySelector("#roomList .side-item") && document.getElementById("input")) return Array.isArray(initial.rooms) && initial.rooms.length > 0; await new Promise(resolve => setTimeout(resolve, 100)); } return false; })()'
        );
        if (!ready || !app.isPackaged) throw new Error('Packaged UI or IPC not ready');
        const terminalReady = await win.webContents.executeJavaScript('typeof Terminal === "function" && typeof FitAddon.FitAddon === "function" && !!document.getElementById("workbenchDock")');
        if (!terminalReady) throw new Error('Packaged workbench assets not ready');
        const nativePty = require('node-pty');
        const { TerminalService } = require('./src/main/workbench/terminals');
        await new Promise((resolve, reject) => {
          let text = '', finished = false;
          const finish = error => { if (finished) return; finished = true; clearTimeout(timer); service.dispose(); error ? reject(error) : resolve(); };
          const service = new TerminalService({
            ptyModule: { spawn: (executable, args, options) => nativePty.spawn(executable, process.platform === 'win32' ? ['-NoProfile', ...args] : args, options) },
            emit: event => { if (event.kind === 'terminal-data') { text = (text + event.data).slice(-8192); service.acknowledge(event.id, event.data.length); if (text.includes('CONVOKE_PACKAGED_PTY_OK')) finish(); } },
          });
          const timer = setTimeout(() => finish(new Error('Packaged terminal timed out')), 10000);
          try {
            service.create({ id: 'release_terminal', roomId: 'fixture', cwd: app.getPath('userData'), cols: 80, rows: 24 });
            service.ready('release_terminal');
            service.resize('release_terminal', { cols: 100, rows: 30 });
            service.write('release_terminal', process.platform === 'win32' ? "Write-Output ('CONVOKE_' + 'PACKAGED_PTY_OK')\\r" : "printf '%s%s\\\\n' 'CONVOKE_' 'PACKAGED_PTY_OK'\\n");
          } catch (error) { finish(error); }
        });
        process.stdout.write('CONVOKE_RELEASE_TERMINAL_OK\\n');
        finished = true; clearTimeout(timeout);
        process.stdout.write('CONVOKE_RELEASE_SMOKE_OK\\n');
        app.quit();
      } catch (_) { finished = true; clearTimeout(timeout); process.stdout.write('CONVOKE_RELEASE_SMOKE_FAILED\\n'); app.exit(2); }
    });
  });
}
require('./src/main/main.js');
`;
}
function copyFile(sourceRoot, outputRoot, relative, outputRelative = relative) {
  const source = path.join(sourceRoot, relative);
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Release input is not a regular file: ${relative}`);
  const target = path.join(outputRoot, outputRelative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
}
function runtimeFilesForPackaging(root, name, platform) {
  const base = 'node_modules/' + name;
  // Enumerate only shipped runtime directories: node-gyp build trees can contain
  // host-local symlinks and compiler intermediates that must never be copied.
  const candidates = [base + '/package.json', base + '/LICENSE'];
  const directories = [base + '/lib'];
  if (name === '@xterm/xterm') directories.push(base + '/css');
  if (name === 'node-pty') {
    directories.push(base + '/prebuilds/' + platform + '-x64');
    if (platform === 'linux') candidates.push(base + '/build/Release/pty.node', base + '/build/Release/spawn-helper');
  }
  for (const directory of directories) if (fs.existsSync(path.join(root, directory))) candidates.push(...filesUnder(root, directory));
  return candidates.filter(file => fs.existsSync(path.join(root, file)) && allowedRuntimeFile(file, platform));
}
function build({ sourceRoot = path.resolve(__dirname, '..'), outputRoot = path.join(sourceRoot, 'dist'), electronRoot, sourceOnly = false, strict = false } = {}) {
  sourceRoot = path.resolve(sourceRoot); outputRoot = path.resolve(outputRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(manifest.version)) throw new Error('Package version must be a semantic version');
  const runtimePackages = verifyRuntimeDependencies(sourceRoot, { installed: !sourceOnly });
  const snapshot = new Map(publicationFiles(sourceRoot).map(file => [file, sha256(fs.readFileSync(path.join(sourceRoot, file)))]));
  const sourceAudit = auditSource(sourceRoot, { checkGit: false, syntax: true });
  const blocking = sourceAudit.failures.filter(item => !['unpinned-runtime', 'missing-lockfile', 'runtime-lock-mismatch', 'unsupported-electron-major'].includes(item.code));
  if (blocking.length || (strict && !sourceAudit.ok)) {
    const error = new Error('Release source checks failed'); error.findings = strict ? sourceAudit.failures : blocking; throw error;
  }
  let runtimePath, runtimeVersion;
  if (!sourceOnly) {
    if (!['win32', 'linux'].includes(process.platform) || process.arch !== 'x64') throw new Error('Desktop packages require a native Windows or Linux x64 build host');
    const runtimePackage = electronRoot ? path.join(path.resolve(electronRoot), 'package.json') : require.resolve('electron/package.json', { paths: [sourceRoot] });
    runtimePath = path.join(path.dirname(runtimePackage), 'dist');
    runtimeVersion = JSON.parse(fs.readFileSync(runtimePackage, 'utf8')).version;
    if (fs.readFileSync(path.join(runtimePath, 'version'), 'utf8').trim() !== runtimeVersion) throw new Error('Electron package and runtime versions differ');
    if (/^\d+\.\d+\.\d+$/.test(manifest.devDependencies?.electron || '') && manifest.devDependencies.electron !== runtimeVersion) throw new Error('Installed Electron differs from the pinned tested version');
  }
  fs.mkdirSync(outputRoot, { recursive: true });
  const kind = sourceOnly ? 'source' : 'desktop';
  const prefix = sourceOnly ? `Chorus-${manifest.version}-source-` : `Chorus-${manifest.version}-${process.platform}-x64-`;
  const output = fs.mkdtempSync(path.join(outputRoot, prefix));
  // mkdtemp defaults to 0700. FPM preserves this directory as root-owned
  // /opt/Chorus, so desktop distributions must be traversable by normal users.
  if (!sourceOnly && process.platform === 'linux') fs.chmodSync(output, 0o755);
  if (sourceOnly) {
    for (const file of publicationFiles(sourceRoot)) copyFile(sourceRoot, output, file);
  } else {
    const runtimeFiles = filesUnder(runtimePath).filter(file => RUNTIME_FILES.has(file) || /^locales\/[^/]+\.pak$/.test(file));
    for (const required of [process.platform === 'win32' ? 'electron.exe' : 'electron', 'resources.pak', 'icudtl.dat', 'LICENSE', 'LICENSES.chromium.html']) if (!runtimeFiles.includes(required)) throw new Error(`Electron runtime is incomplete: ${required}`);
    for (const file of runtimeFiles) copyFile(runtimePath, output, file,
      file === 'electron.exe' ? 'Chorus.exe' : file === 'electron' ? 'chorus' : file === 'LICENSE' ? 'LICENSE.electron.txt' : file);
    if (process.platform === 'win32') {
      for (const file of ['Uninstall Chorus.cmd', 'uninstall-chorus.ps1']) copyFile(sourceRoot, output, `scripts/${file}`, file);
      const iconResult = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File',
        path.join(sourceRoot, 'scripts/set-windows-icon.ps1'), '-Executable', path.join(output, 'Chorus.exe'),
        '-Icon', path.join(sourceRoot, 'src/renderer/assets/convoke.ico')], { windowsHide: true, timeout: 30000, encoding: 'utf8' });
      if (iconResult.error || iconResult.status !== 0 || !iconResult.stdout.includes('CONVOKE_ICON_VERIFIED')) {
        throw new Error(`Windows icon update failed: ${iconResult.error?.message || iconResult.stderr || iconResult.status}`);
      }
    } else {
      // The Debian target installs this reviewed, path-scoped Ubuntu profile.
      // Include it before hashing so installer and zip contain identical inputs.
      copyFile(sourceRoot, output, 'scripts/convoke-apparmor', 'resources/apparmor-profile');
    }
    const appRoot = path.join(output, 'resources', 'app');
    fs.mkdirSync(appRoot, { recursive: true });
    for (const file of filesUnder(sourceRoot, 'src')) copyFile(sourceRoot, appRoot, file);
    for (const name of runtimePackages) {
      const relative = 'node_modules/' + name;
      const packageFiles = runtimeFilesForPackaging(sourceRoot, name, process.platform);
      for (const required of [relative + '/package.json', relative + '/LICENSE']) {
        if (!packageFiles.includes(required)) throw new Error(`Runtime package is incomplete: ${required}`);
      }
      for (const file of packageFiles) copyFile(sourceRoot, appRoot, file);
    }
    if (process.platform === 'linux' && runtimePackages.includes('node-pty') &&
        !fs.existsSync(path.join(appRoot, 'node_modules/node-pty/build/Release/pty.node')) &&
        !fs.existsSync(path.join(appRoot, 'node_modules/node-pty/prebuilds/linux-x64/pty.node'))) {
      throw new Error('Linux node-pty native module missing; run npm ci on the Linux build host with Python and a C++ toolchain');
    }
    for (const file of [...APP_ROOT_FILES, ...SOURCE_DOCS]) if (fs.existsSync(path.join(sourceRoot, file))) copyFile(sourceRoot, appRoot, file);
    fs.writeFileSync(path.join(appRoot, 'package.json'), JSON.stringify({ name: 'agent-room', productName: 'Chorus', desktopName: 'chorus.desktop', version: manifest.version,
      description: manifest.description, main: 'desktop-bootstrap.js', license: manifest.license || 'MIT', dependencies: manifest.dependencies || {} }, null, 2) + '\n', { flag: 'wx' });
    fs.writeFileSync(path.join(appRoot, 'desktop-bootstrap.js'), bootstrapSource(), { flag: 'wx' });
    const findings = scanFiles(appRoot, filesUnder(appRoot).filter(file => !allowedRuntimeFile(file)));
    if (findings.length) { const error = new Error('Packaged app privacy checks failed'); error.findings = findings; throw error; }
  }
  const files = filesUnder(output).map(file => {
    const bytes = fs.readFileSync(path.join(output, file));
    return { path: file, bytes: bytes.length, sha256: sha256(bytes) };
  });
  const finalInputs = publicationFiles(sourceRoot);
  if (finalInputs.length !== snapshot.size || finalInputs.some(file => snapshot.get(file) !== sha256(fs.readFileSync(path.join(sourceRoot, file))))) {
    throw new Error(`Source changed during packaging; rebuild from a stable state. Incomplete candidate: ${output}`);
  }
  fs.writeFileSync(path.join(output, 'RELEASE-MANIFEST.json'), JSON.stringify({ format: 1, product: 'Chorus', version: manifest.version,
    kind, platform: sourceOnly ? null : process.platform, arch: sourceOnly ? null : 'x64', electronVersion: runtimeVersion || null,
    unsigned: !sourceOnly, sourceStaticChecksPassed: sourceAudit.ok, builtAt: new Date().toISOString(), files }, null, 2) + '\n', { flag: 'wx' });
  const verified = auditBundle(output);
  if (!verified.ok) { const error = new Error('Built release verification failed'); error.findings = verified.failures; throw error; }
  return { output, kind, version: manifest.version, electronVersion: runtimeVersion || null, files: files.length,
    staticChecksPassed: sourceAudit.ok, pending: sourceAudit.failures, unsigned: !sourceOnly };
}
async function smoke(directory) {
  const verified = auditBundle(directory);
  if (!verified.ok || verified.kind !== 'desktop') throw new Error('Packaged directory must pass bundle verification before smoke');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-release-smoke-'));
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(scratch, '.convoke-smoke-token'), token, { flag: 'wx' });
  const env = { ...process.env, CONVOKE_RELEASE_SMOKE_DIR: scratch };
  delete env.ELECTRON_RUN_AS_NODE;
  let child, timer, success = false, terminal = false, timedOut = false;
  try {
    const exitCode = await new Promise((resolve, reject) => {
      child = spawn(path.join(directory, process.platform === 'linux' ? 'chorus' : 'Chorus.exe'), [`--convoke-release-smoke=${token}`], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let marker = '';
      child.stdout.on('data', chunk => { marker = (marker + chunk.toString()).slice(-1024); if (marker.includes('CONVOKE_RELEASE_SMOKE_OK')) success = true; if (marker.includes('CONVOKE_RELEASE_TERMINAL_OK')) terminal = true; });
      child.stderr.on('data', () => {});
      timer = setTimeout(() => {
        timedOut = true;
        if (Number.isInteger(child.pid) && process.platform === 'win32') {
          const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill();
      }, 30000);
      child.on('error', reject); child.on('close', resolve);
    });
    if (!success || !terminal || exitCode !== 0 || timedOut) throw new Error(`Packaged startup failed (code=${exitCode}, marker=${success}, terminal=${terminal}, timeout=${timedOut})`);
    if (!fs.existsSync(path.join(scratch, 'rooms.json')) || !fs.existsSync(path.join(scratch, 'settings.json'))) throw new Error('Packaged app did not initialize isolated fixture data');
    return { ok: true, packaged: true, isolatedData: true, renderer: true, ipc: true, xterm: true, interactiveTerminal: terminal, realModelCalls: false };
  } finally {
    clearTimeout(timer);
    // This exact directory was freshly created above; no user path can enter removal.
    if (path.dirname(scratch) === path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('convoke-release-smoke-')) fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const read = name => { const index = args.indexOf(name); if (index < 0) return undefined; if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value: ${name}`); return args[index + 1]; };
    const existing = read('--smoke-existing');
    if (existing) console.log(JSON.stringify(await smoke(path.resolve(existing)), null, 2));
    else {
      const result = build({ sourceRoot: read('--root'), outputRoot: read('--out'), electronRoot: read('--electron-root'), sourceOnly: args.includes('--source'), strict: args.includes('--strict') });
      if (args.includes('--smoke')) result.smoke = await smoke(result.output);
      console.log(JSON.stringify(result, null, 2));
    }
  })().catch(error => { console.error(JSON.stringify({ ok: false, error: error.message, findings: error.findings || [] }, null, 2)); process.exitCode = 1; });
}
module.exports = { build, smoke, bootstrapSource, runtimeFilesForPackaging };
