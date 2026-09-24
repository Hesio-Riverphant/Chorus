'use strict';
const I18n = require('../shared/i18n');

const fs = require('node:fs');
const path = require('node:path');
const { writeJsonAtomic } = require('./store/jsonStore');

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.@:/-]{0,199}$/;
const MAX_ENTRIES = 64;
const clone = value => JSON.parse(JSON.stringify(value));
const text = (value, max) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max) : '';

// Only display metadata crosses this boundary. Commands, environment, URLs,
// headers, and native configuration objects are never retained.
function metadata(value) {
  if (!value || !['claude', 'codex'].includes(value.cliType) || !Array.isArray(value.items) ||
      !Number.isFinite(value.scannedAt)) throw new Error(I18n.t('扩展清单无效，请点击更新'));
  const items = value.items.slice(0, 256).filter(item => item && NAME.test(item.id) && ['mcp', 'plugin'].includes(item.kind))
    .map(item => {
      const result = { id: item.id, name: text(item.name, 100) || item.id, kind: item.kind,
        enabled: item.enabled === true, status: ['ready', 'configured', 'disabled', 'unavailable'].includes(item.status) ? item.status : 'configured' };
      if (NAME.test(item.pluginId || '')) result.pluginId = item.pluginId;
      if (item.selectable === false) result.selectable = false;
      if (item.enableSupported === false) result.enableSupported = false;
      if (Number.isInteger(item.toolCount) && item.toolCount >= 0) result.toolCount = Math.min(item.toolCount, 100000);
      return result;
    });
  return { cliType: value.cliType, items, scannedAt: value.scannedAt,
    truncated: value.truncated === true || value.items.length > 256,
    notice: text(value.notice, 500) };
}

class NativeCapabilityCache {
  constructor(dataPath) {
    this.file = dataPath ? path.join(dataPath, 'native-capabilities.json') : null;
    this.entries = new Map();
    this.loadError = false;
    if (!this.file || !fs.existsSync(this.file)) return;
    try {
      if (fs.statSync(this.file).size > 8 * 1024 * 1024) throw new Error('large inventory');
      const saved = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (saved.version !== 1 || !Array.isArray(saved.entries) || saved.entries.length > MAX_ENTRIES) throw new Error('invalid inventory');
      for (const entry of saved.entries) {
        const key = this.key(entry.cliType, entry.cwd);
        this.entries.set(key, { cwd: path.resolve(entry.cwd), ...metadata(entry) });
      }
    } catch (_) { this.entries.clear(); this.loadError = true; }
  }
  key(cliType, cwd) {
    if (!['claude', 'codex'].includes(cliType) || typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')) {
      throw new Error(I18n.t('能力扫描需要有效 Agent 和工作目录'));
    }
    const resolved = path.resolve(cwd);
    return JSON.stringify([cliType, process.platform === 'win32' ? resolved.toLowerCase() : resolved]);
  }
  get(cliType, cwd) {
    const entry = this.entries.get(this.key(cliType, cwd));
    if (!entry) return null;
    const result = clone(entry); delete result.cwd;
    return result;
  }
  set(cliType, cwd, value) {
    const key = this.key(cliType, cwd);
    const result = metadata(value);
    const entries = new Map(this.entries);
    entries.delete(key);
    entries.set(key, { cwd: path.resolve(cwd), ...result });
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value);
    // Commit to disk first, so a failed write leaves the last good inventory.
    if (this.file) writeJsonAtomic(this.file, { version: 1, entries: [...entries.values()] });
    this.entries = entries; this.loadError = false;
    return clone(result);
  }
}

module.exports = { NativeCapabilityCache };
