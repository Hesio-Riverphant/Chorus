'use strict';

// Explicit, offline consolidation of the two historical application stores.
// Native Agent profiles and Chromium account/cache files are never inputs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeJsonAtomic } = require('../src/main/store/jsonStore');
const { acquireStoreLease } = require('../src/main/store/storeLease');
const REGISTRIES = new Set(['bots.json', 'rooms.json', 'settings.json', 'sessions.json', 'skill-references.json', 'native-capabilities.json']);
const TREES = new Set(['messages', 'archives', 'trash', 'skills']);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function inventory(directory) {
  const root = fs.realpathSync(directory);
  const result = new Map();
  function walk(relative = '') {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (!relative && !REGISTRIES.has(name) && !TREES.has(name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`迁移输入不接受链接：${name}`);
      if (entry.isDirectory()) walk(name);
      else if (entry.isFile()) result.set(name, fs.readFileSync(path.join(root, name)));
      else throw new Error(`迁移输入类型无效：${name}`);
    }
  }
  walk();
  return result;
}
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function json(files, name, fallback) {
  if (!files.has(name)) return fallback;
  try { return JSON.parse(files.get(name).toString('utf8').replace(/^\uFEFF/, '')); }
  catch { throw new Error(`JSON 格式无效：${name}`); }
}
function records(files, name) {
  const value = json(files, name, []);
  if (!Array.isArray(value) || value.some(item => !object(item) || typeof item.id !== 'string' || !/^[\w-]+$/.test(item.id))) throw new Error(`记录格式无效：${name}`);
  if (new Set(value.map(item => item.id)).size !== value.length) throw new Error(`记录标识重复：${name}`);
  return value;
}
function mergeRecords(primary, secondary, file) {
  const result = new Map(primary.map(item => [item.id, item]));
  for (const item of secondary) {
    const existing = result.get(item.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item)) throw new Error(`同一记录存在不同内容，请先处理：${file} / ${item.id}`);
    if (!existing) result.set(item.id, item);
  }
  return [...result.values()];
}
function mergeObject(primary, secondary, file, preferPrimary = false) {
  if (!object(primary) || !object(secondary)) throw new Error(`对象格式无效：${file}`);
  const result = { ...secondary };
  for (const [key, value] of Object.entries(primary)) {
    if (!preferPrimary && Object.hasOwn(result, key) && JSON.stringify(result[key]) !== JSON.stringify(value)) throw new Error(`配置冲突：${file} / ${key}`);
    result[key] = value;
  }
  return result;
}
function planConsolidation(source, destination) {
  source = fs.realpathSync(source); destination = fs.realpathSync(destination);
  const relative = path.relative(source, destination);
  if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative) || !path.relative(destination, source).startsWith('..') && !path.isAbsolute(path.relative(destination, source))) throw new Error('源和目标目录必须彼此独立');
  const primary = inventory(source), secondary = inventory(destination), merged = new Map(secondary);
  const encode = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
  const rooms = mergeRecords(records(primary, 'rooms.json'), records(secondary, 'rooms.json'), 'rooms.json');
  const bots = mergeRecords(records(primary, 'bots.json'), records(secondary, 'bots.json'), 'bots.json');
  const names = new Set();
  for (const room of rooms) {
    const base = room.name || '房间'; let name = base;
    for (let n = 2; names.has(name); n++) name = `${base} (${n})`;
    room.name = name; names.add(name);
    if (!Array.isArray(room.botIds) || room.botIds.some(id => !bots.some(bot => bot.id === id))) throw new Error(`房间成员缺失：${room.id}`);
    if (room.parentRoomId && !rooms.some(parent => parent.id === room.parentRoomId)) throw new Error(`侧聊父房间缺失：${room.id}`);
  }
  const settings = mergeObject(json(primary, 'settings.json', {}), json(secondary, 'settings.json', {}), 'settings.json', true);
  const primarySettings = json(primary, 'settings.json', {}), secondarySettings = json(secondary, 'settings.json', {});
  if (primarySettings.cliProfiles || secondarySettings.cliProfiles) settings.cliProfiles = mergeRecords(primarySettings.cliProfiles || [], secondarySettings.cliProfiles || [], 'cliProfiles');
  if (primarySettings.enabledCliIds || secondarySettings.enabledCliIds) settings.enabledCliIds = [...new Set([...(primarySettings.enabledCliIds || []), ...(secondarySettings.enabledCliIds || [])])];
  // Persist the development root fallback before the executable moves elsewhere.
  if (!settings.defaultCwd) settings.defaultCwd = path.dirname(source);
  merged.set('rooms.json', encode(rooms)); merged.set('bots.json', encode(bots)); merged.set('settings.json', encode(settings));
  merged.set('sessions.json', encode(mergeObject(json(primary, 'sessions.json', {}), json(secondary, 'sessions.json', {}), 'sessions.json')));
  merged.set('skill-references.json', encode(mergeRecords(records(primary, 'skill-references.json'), records(secondary, 'skill-references.json'), 'skill-references.json')));
  for (const [name, bytes] of primary) {
    if (REGISTRIES.has(name)) { if (name === 'native-capabilities.json') merged.set(name, bytes); continue; }
    if (secondary.has(name) && !bytes.equals(secondary.get(name))) {
      if (/^messages\/[\w-]+\.json$/.test(name)) merged.set(name, encode(mergeRecords(records(primary, name), records(secondary, name), name)));
      else throw new Error(`文件内容冲突，请先处理：${name}`);
    } else merged.set(name, bytes);
  }
  const summary = { source, destination, rooms: rooms.length, bots: bots.length, files: merged.size,
    messages: [...merged.keys()].filter(name => /^messages\/[\w-]+\.json$/.test(name)).reduce((n, name) => n + records(merged, name).length, 0),
    settingsPreference: 'source', sourceHashes: hashes(primary), destinationHashes: hashes(secondary) };
  return { source, destination, primary, secondary, merged, summary };
}
function hashes(files) { return [...files].map(([name, bytes]) => ({ path: name, sha256: digest(bytes) })).sort((a, b) => a.path.localeCompare(b.path)); }
function writeTree(directory, files) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of files) {
    const target = path.join(directory, name); fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
  }
}
function assertSame(expected, actual) {
  if (JSON.stringify(hashes(expected)) !== JSON.stringify(hashes(actual))) throw new Error('迁移期间数据已变化，请关闭应用后重试');
}
function applyConsolidation(plan, backupRoot, { destinationSingletonHeld = false } = {}) {
  const leases = [];
  try {
    for (const dir of [plan.source, plan.destination].sort()) leases.push(acquireStoreLease(dir, { recoverStale: dir === plan.destination && destinationSingletonHeld }));
    return applyLockedConsolidation(plan, backupRoot);
  } finally { for (const lease of leases.reverse()) lease.release(); }
}
function applyLockedConsolidation(plan, backupRoot) {
  backupRoot = path.resolve(backupRoot);
  for (const dir of [plan.source, plan.destination]) {
    const relative = path.relative(dir, backupRoot);
    if (!relative || !relative.startsWith('..') && !path.isAbsolute(relative)) throw new Error('备份必须独立于源和目标数据目录');
  }
  assertSame(plan.primary, inventory(plan.source)); assertSame(plan.secondary, inventory(plan.destination));
  fs.mkdirSync(backupRoot, { recursive: false });
  writeTree(path.join(backupRoot, 'source'), plan.primary);
  writeTree(path.join(backupRoot, 'destination'), plan.secondary);
  assertSame(plan.primary, inventory(path.join(backupRoot, 'source')));
  assertSame(plan.secondary, inventory(path.join(backupRoot, 'destination')));
  writeJsonAtomic(path.join(backupRoot, 'manifest.json'), { ...plan.summary, mergedHashes: hashes(plan.merged), state: 'backed-up' });
  assertSame(plan.primary, inventory(plan.source)); assertSame(plan.secondary, inventory(plan.destination));
  const applied = [];
  try {
    // Publish registries last, after every referenced history/file exists.
    const files = [...plan.merged].sort(([a], [b]) => Number(REGISTRIES.has(a)) - Number(REGISTRIES.has(b)));
    for (const [name, bytes] of files) {
      const target = path.join(plan.destination, name); fs.mkdirSync(path.dirname(target), { recursive: true });
      const temporary = path.join(backupRoot, 'stage-' + crypto.randomUUID());
      let stageOwned = false;
      try {
        const fd = fs.openSync(temporary, 'wx'); stageOwned = true;
        try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        // Staging may be on another drive: install a local owned temporary,
        // then replace the destination atomically.
        const local = target + '.consolidating-' + crypto.randomUUID();
        let localOwned = false;
        try {
          const localFd = fs.openSync(local, 'wx'); localOwned = true;
          try { fs.writeFileSync(localFd, bytes); fs.fsyncSync(localFd); } finally { fs.closeSync(localFd); }
          fs.renameSync(local, target);
        } finally { if (localOwned && fs.existsSync(local)) fs.unlinkSync(local); }
      } finally { if (stageOwned && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      applied.push(name);
    }
    assertSame(plan.merged, inventory(plan.destination));
    writeJsonAtomic(path.join(backupRoot, 'manifest.json'), { ...plan.summary, mergedHashes: hashes(plan.merged), state: 'complete' });
    return { ...plan.summary, backupRoot, verified: true };
  } catch (error) {
    for (const name of applied.reverse()) {
      const target = path.join(plan.destination, name);
      if (plan.secondary.has(name)) fs.writeFileSync(target, plan.secondary.get(name));
      else fs.unlinkSync(target);
    }
    assertSame(plan.secondary, inventory(plan.destination));
    throw error;
  }
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2); const read = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
    if (!read('--source') || !read('--destination')) throw new Error('需要 --source 和 --destination；--apply --backup 用于离线备份并执行');
    const plan = planConsolidation(read('--source'), read('--destination'));
    if (args.includes('--apply') && !read('--backup')) throw new Error('执行需要独立 --backup 目录');
    if (args.includes('--apply')) {
      // Electron's directory-scoped lock also excludes previously distributed
      // builds which predate the file lease. No shell interpolation is used.
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const child = require('node:child_process').spawnSync(require('electron'), [path.join(__dirname, 'consolidate-data-host.cjs'), ...args],
        { env, stdio: 'inherit', windowsHide: true, timeout: 120000 });
      if (child.error) throw child.error;
      process.exitCode = child.status == null ? 1 : child.status;
    } else console.log(JSON.stringify(plan.summary, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { inventory, planConsolidation, applyConsolidation };
