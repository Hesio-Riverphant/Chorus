'use strict';
// This test may install software only in a disposable hosted CI runner.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted' || !process.env.RUNNER_TEMP) {
  throw new Error('Windows hosted CI runner required; no local installation is performed.');
}
const run = (exe, args, options = {}) => {
  const result = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...options });
  if (result.error || result.status !== 0) throw new Error(`${path.basename(exe)} failed: ${result.error?.message || result.status}\n${result.stdout || ''}\n${result.stderr || ''}`);
  return result.stdout || '';
};
const registrations = () => JSON.parse(run('powershell.exe', ['-NoProfile', '-Command',
  "ConvertTo-Json -InputObject @(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^Chorus(?: |$)' } | Select-Object DisplayName,UninstallString) -Compress"]));
(async () => {
  if (registrations().length) throw new Error('Existing Chorus installation must not be changed by this test.');
  const runner = fs.realpathSync(process.env.RUNNER_TEMP);
  const fixture = fs.mkdtempSync(path.join(runner, 'chorus-install-check-'));
  const target = path.join(fixture, 'app');
  // Match the packaged bootstrap's strict temporary-directory isolation gate.
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-release-smoke-'));
  if (/\s/.test(target)) throw new Error('CI install fixture must have an unambiguous NSIS destination.');
  const current = JSON.parse(fs.readFileSync('dist/CURRENT-RELEASE.json'));
  const installer = current.artifacts.find(item => item.path.endsWith('-setup.exe'));
  if (!installer) throw new Error('No current Windows installer.');
  const binary = path.resolve('dist', installer.path);
  if (crypto.createHash('sha256').update(fs.readFileSync(binary)).digest('hex') !== installer.sha256) throw new Error('Installer checksum mismatch.');
  run(binary, ['/S', '/currentuser', `/D=${target}`]);
  const uninstaller = path.join(target, 'Uninstall Chorus.exe');
  if (!fs.existsSync(uninstaller) || registrations().length !== 1 || !registrations()[0].UninstallString.includes(uninstaller)) throw new Error('Installation is not bound to the exact fixture.');
  const inspection = JSON.parse(run('powershell.exe', ['-NoProfile', '-File', path.join(target, 'uninstall-chorus.ps1'), '-Inspect', '-Update']));
  if (inspection.mode !== 'installed' || !inspection.update || inspection.sharedData !== null) throw new Error('Installed removal plan is not scoped to this upgrade.');
  const token = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(data, '.convoke-smoke-token'), token);
  const env = { ...process.env, CONVOKE_RELEASE_SMOKE_DIR: data }; delete env.ELECTRON_RUN_AS_NODE;
  const output = run(path.join(target, 'Chorus.exe'), [`--convoke-release-smoke=${token}`], { cwd: target, env, timeout: 45000 });
  if (!output.includes('CONVOKE_RELEASE_SMOKE_OK') || !output.includes('CONVOKE_RELEASE_TERMINAL_OK') || !fs.existsSync(path.join(data, 'rooms.json'))) throw new Error('Installed app startup/terminal check failed.');
  // Exercise real NSIS/self-removal while preserving shared data. Interactive
  // complete-data removal is covered separately by scoped fixture tests.
  run(uninstaller, ['/S', '/currentuser', '--updated'], { cwd: fixture });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && (fs.existsSync(target) || registrations().length)) await new Promise(resolve => setTimeout(resolve, 500));
  if (fs.existsSync(target) || registrations().length) {
    const remaining = fs.existsSync(target) ? fs.readdirSync(target) : [];
    throw new Error(`Real NSIS removal incomplete: ${JSON.stringify({ remaining, registrations: registrations() })}`);
  }
  if (!fs.existsSync(path.join(data, 'rooms.json'))) throw new Error('Update-mode removal deleted separate fixture data.');
  console.log(JSON.stringify({ installed: true, isolatedStartup: true, terminal: true, nsisRemoval: true, registrationRemoved: true, updateModeRetainsData: true, interactiveFullRemoval: false }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
