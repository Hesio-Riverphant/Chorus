'use strict';
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_PACKAGES = { '@xterm/xterm': '6.0.0', '@xterm/addon-fit': '0.11.0', 'node-pty': '1.1.0' };
function allowedRuntimeFile(file, platform) {
  if (platform === 'linux' && /node-pty\/prebuilds\/win32-/.test(file)) return false;
  if (platform === 'win32' && /node-pty\/(?:build\/Release|prebuilds\/linux-)/.test(file)) return false;
  return /^node_modules\/@xterm\/xterm\/(?:lib\/xterm\.js|css\/xterm\.css|package\.json|LICENSE)$/.test(file) ||
    /^node_modules\/@xterm\/addon-fit\/(?:lib\/addon-fit\.js|package\.json|LICENSE)$/.test(file) ||
    /^node_modules\/node-pty\/(?:package\.json|LICENSE|lib\/(?!.*\.test\.js$)[\w/-]+\.js|prebuilds\/win32-x64\/(?:conpty\/)?[\w.-]+\.(?:node|dll|exe)|(?:build\/Release|prebuilds\/linux-x64)\/(?:pty\.node|spawn-helper))$/.test(file);
}
function verifyRuntimeDependencies(root, { installed = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const declared = manifest.dependencies || {};
  if (!Object.keys(declared).length) return [];
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  for (const [name, version] of Object.entries(declared)) {
    if (RUNTIME_PACKAGES[name] !== version) throw new Error(`Runtime dependency requires an explicit reviewed packaging rule: ${name}`);
    if (lock.packages?.['']?.dependencies?.[name] !== version || lock.packages?.['node_modules/' + name]?.version !== version) throw new Error(`Runtime dependency lock differs: ${name}`);
    if (installed && JSON.parse(fs.readFileSync(path.join(root, 'node_modules', name, 'package.json'), 'utf8')).version !== version) throw new Error(`Installed runtime dependency differs: ${name}`);
  }
  return Object.keys(declared);
}
module.exports = { RUNTIME_PACKAGES, allowedRuntimeFile, verifyRuntimeDependencies };
