'use strict';

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listProfiles, resolveEnabledCliIds, findProfile } = require('./cliRegistry');

function localDirectory(value, paths) {
  return typeof value === 'string' && paths.isAbsolute(value) && !/^[\\/]{2}/.test(value) && !/[\x00-\x1f]/.test(value);
}

// Exact executable names only. No recursive disk scan, process launch, or
// auth/config reads; presence is distinct from a successful connection test.
function searchDirectories({ env = process.env, homeDir = os.homedir(), platform = process.platform } = {}) {
  const windows = platform === 'win32';
  const paths = windows ? path.win32 : path.posix;
  const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH');
  const directories = (env[pathKey] || '').split(windows ? ';' : ':').map(value => value.replace(/^"(.*)"$/, '$1'));
  if (localDirectory(homeDir, paths)) directories.push(paths.join(homeDir, '.local', 'bin'), paths.join(homeDir, 'bin'), paths.join(homeDir, '.cargo', 'bin'), paths.join(homeDir, '.kimi-code', 'bin'));
  if (windows) {
    if (localDirectory(env.APPDATA, paths)) directories.push(paths.join(env.APPDATA, 'npm'));
    if (localDirectory(env.LOCALAPPDATA, paths)) directories.push(paths.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), paths.join(env.LOCALAPPDATA, 'cursor-agent'));
  }
  return { paths, windows, roots: [...new Set(directories.filter(value => localDirectory(value, paths)))].slice(0, 128) };
}

function candidates(profile, search) {
  if (!profile.builtin) return [profile.command];
  return search.roots.flatMap(root => (search.windows ? ['.exe', '.cmd', '.bat'] : ['']).map(suffix => search.paths.join(root, (profile.command || profile.id) + suffix)));
}

function locateCliExecutable(id, settings = {}, options = {}) {
  const profile = findProfile(id, settings);
  if (!profile) return null;
  const stat = options.stat || fsSync.statSync;
  for (const filename of candidates(profile, searchDirectories(options))) {
    try { if (stat(filename).isFile()) return filename; } catch (_) { /* absent/inaccessible is not installed */ }
  }
  return null;
}

async function discoverClis(settings = {}, options = {}) {
  const { bots = [], stat = fs.stat } = options;
  const search = searchDirectories(options);
  const enabled = new Set(resolveEnabledCliIds(settings, bots));
  async function exists(filename) {
    try { return (await stat(filename)).isFile(); } catch (_) { return false; }
  }
  const results = [];
  for (const profile of listProfiles(settings)) {
    let executablePath = null;
    for (const candidate of candidates(profile, search)) {
      if (await exists(candidate)) { executablePath = candidate; break; }
    }
    results.push({ ...profile, enabled: enabled.has(profile.id), installed: !!executablePath, executablePath });
  }
  return results;
}

module.exports = { discoverClis, locateCliExecutable };
