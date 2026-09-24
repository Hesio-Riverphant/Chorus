'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { build: buildDesktop, smoke } = require('./package-desktop');
const { auditBundle, publicationFiles, sha256 } = require('./check-release');

function builderConfiguration(sourceRoot, output) {
  return {
    appId: 'org.convoke.desktop',
    productName: 'Chorus',
    copyright: 'Chorus contributors',
    directories: { output, buildResources: path.join(sourceRoot, 'src/renderer/assets') },
    electronVersion: JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'))).devDependencies.electron,
    executableName: 'chorus',
    asar: false,
    npmRebuild: false,
    publish: null,
    win: {
      target: ['nsis', 'zip'],
      executableName: 'Chorus',
      icon: path.join(sourceRoot, 'src/renderer/assets/convoke.ico'),
      signAndEditExecutable: false,
      artifactName: 'Chorus-${version}-windows-${arch}.${ext}',
    },
    nsis: {
      uninstallDisplayName: 'Chorus',
      include: path.join(sourceRoot, 'scripts/installer.nsh'),
      oneClick: false,
      perMachine: false,
      allowElevation: false,
      packElevateHelper: false,
      allowToChangeInstallationDirectory: true,
      deleteAppDataOnUninstall: false,
      runAfterFinish: false,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'Chorus',
      artifactName: 'Chorus-${version}-windows-${arch}-setup.${ext}',
    },
    linux: {
      target: ['deb', 'zip'],
      icon: path.join(sourceRoot, 'src/renderer/assets/convoke.png'),
      category: 'Development',
      maintainer: 'Chorus contributors',
      synopsis: 'Local multi-agent chat rooms',
      artifactName: 'Chorus-${version}-linux-${arch}.${ext}',
    },
    deb: {
      appArmorProfile: path.join(sourceRoot, 'scripts/convoke-apparmor'),
    },
  };
}

async function packageInstallers({ sourceRoot = path.resolve(__dirname, '..'), outputRoot, platform = process.platform, homepage } = {}) {
  sourceRoot = path.resolve(sourceRoot);
  if (!['win32', 'linux'].includes(platform) || platform !== process.platform || process.arch !== 'x64') {
    throw new Error('Build Windows x64 on Windows, and Ubuntu x64 on Ubuntu; cross-compilation is not a runtime validation');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  homepage = homepage || manifest.homepage || process.env.CONVOKE_HOMEPAGE;
  if (platform === 'linux' && (!homepage || !/^https?:\/\/[^\s]+$/.test(homepage))) {
    throw new Error('The Debian package requires the real project URL: set package.json homepage or pass --homepage https://your-project-url');
  }
  const snapshot = new Map(publicationFiles(sourceRoot).map(file => [file, sha256(fs.readFileSync(path.join(sourceRoot, file)))]));
  outputRoot = path.resolve(outputRoot || path.join(sourceRoot, 'dist'));
  fs.mkdirSync(outputRoot, { recursive: true });
  const output = fs.mkdtempSync(path.join(outputRoot, `Chorus-${manifest.version}-${platform}-release-`));
  const desktop = buildDesktop({ sourceRoot, outputRoot: path.join(output, 'unpacked'), strict: true });
  const startup = await smoke(desktop.output);
  const { build, Platform, Arch } = require('electron-builder');
  const target = platform === 'win32' ? Platform.WINDOWS : Platform.LINUX;
  const configuration = builderConfiguration(sourceRoot, path.join(output, 'artifacts'));
  if (homepage) configuration.extraMetadata = { homepage };
  const artifacts = await build({ projectDir: sourceRoot, prepackaged: desktop.output,
    targets: target.createTarget(platform === 'win32' ? ['nsis', 'zip'] : ['deb', 'zip'], Arch.x64),
    config: configuration, publish: 'never' });
  const desktopAudit = auditBundle(desktop.output);
  if (!desktopAudit.ok) {
    const error = new Error('Installer creation modified the audited desktop bundle');
    error.findings = desktopAudit.failures; throw error;
  }
  if (platform === 'win32') {
    const directory = path.join(output, 'uninstall');
    fs.mkdirSync(directory);
    for (const file of ['Uninstall Chorus.cmd', 'uninstall-chorus.ps1']) {
      fs.copyFileSync(path.join(sourceRoot, 'scripts', file), path.join(directory, file), fs.constants.COPYFILE_EXCL);
    }
    const archivePath = path.join(output, 'artifacts', `Chorus-${manifest.version}-windows-uninstall.zip`);
    await require('app-builder-lib/out/targets/archive').archive('zip', archivePath, directory, { withoutDir: true });
    artifacts.push(archivePath);
  }
  const finalInputs = publicationFiles(sourceRoot);
  if (finalInputs.length !== snapshot.size || finalInputs.some(file => snapshot.get(file) !== sha256(fs.readFileSync(path.join(sourceRoot, file))))) {
    throw new Error(`Source changed during packaging; rebuild this candidate: ${output}`);
  }
  const records = [...new Set(artifacts)].map(file => ({
    path: path.relative(output, file).split(path.sep).join('/'),
    bytes: fs.statSync(file).size,
    sha256: sha256(fs.readFileSync(file)),
  }));
  const required = platform === 'win32' ? ['-setup.exe', '.zip'] : ['.deb', '.zip'];
  if (required.some(extension => !records.some(record => record.path.endsWith(extension)))) throw new Error('Required installer or zip is missing');
  const result = { format: 1, version: manifest.version, platform, arch: 'x64', unsigned: true,
    builtAt: new Date().toISOString(), desktop: path.relative(output, desktop.output), smoke: startup,
    installerInstalled: false, artifacts: records };
  fs.writeFileSync(path.join(output, 'ARTIFACTS.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx' });
  const current = path.join(outputRoot, 'CURRENT-RELEASE.json');
  const pending = current + '.' + process.pid + '.tmp';
  fs.writeFileSync(pending, JSON.stringify({ version: manifest.version, platform, arch: 'x64',
    directory: path.basename(output), manifest: path.relative(outputRoot, path.join(output, 'ARTIFACTS.json')),
    artifacts: records.map(record => ({ ...record, path: path.relative(outputRoot, path.join(output, record.path)) })) }, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(pending, current);
  return { output, ...result };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const value = name => { const index = args.indexOf(name); if (index < 0) return undefined;
    if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing value: ${name}`);
    return args[index + 1]; };
  packageInstallers({ sourceRoot: value('--root'), outputRoot: value('--out'), platform: value('--platform'), homepage: value('--homepage') })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(JSON.stringify({ ok: false, error: error.message, findings: error.findings || [] }, null, 2)); process.exitCode = 1; });
}

module.exports = { builderConfiguration, packageInstallers };
