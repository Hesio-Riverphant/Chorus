'use strict';
const I18n = require('../shared/i18n');

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { CodexRpc } = require('./adapters/codexRpc');
const { safeText } = require('./adapters/activities');
const { locateCliExecutable } = require('./cliDiscovery');
const { NativeCapabilityCache } = require('./nativeCapabilityCache');

const SUPPORTED = new Set(['claude', 'codex']);
let cache = new NativeCapabilityCache();
let storagePath = null;
const pending = new Map();
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.@:/-]{0,199}$/;

function configureStorage(dataPath) {
  if (typeof dataPath !== 'string' || !path.isAbsolute(dataPath)) throw new Error(I18n.t('扩展存储需要有效数据目录'));
  const resolved = path.resolve(dataPath);
  if (storagePath === resolved) return;
  cache = new NativeCapabilityCache(resolved); storagePath = resolved;
}

function normalizeSelection(value) {
  if (value == null) return { mode: 'inherit', mcp: [], plugins: [] };
  if (!value || !['inherit', 'selected'].includes(value.mode)) throw new Error(I18n.t('原生能力选择无效'));
  const result = { mode: value.mode };
  for (const key of ['mcp', 'plugins']) {
    const items = value[key] || [];
    if (!Array.isArray(items) || items.length > 128 || items.some(id => typeof id !== 'string' || !NAME.test(id))) {
      throw new Error(I18n.t('原生能力名称无效'));
    }
    result[key] = [...new Set(items)];
  }
  return result;
}

function readClaudeMetadata(args, cwd, signal) {
  // Fixed commands only. Command output is reduced to metadata before IPC.
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error(I18n.t('能力扫描已取消'))); return; }
    const launcher = locateCliExecutable('claude') || 'claude';
    if (/[&|<>^%!"\x00-\x1f\x7f]/.test(launcher)) { reject(new Error(I18n.t('Agent 启动路径包含不支持的字符'))); return; }
    const child = spawn(/[\s()]/.test(launcher) ? `"${launcher}"` : launcher, args, { cwd, shell: process.platform === 'win32', windowsHide: true });
    let output = '', finished = false, stopping = null, killTimer;
    const finish = (error) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(output);
    };
    const killChild = () => { try { child.kill(); } catch (_) { /* retain the original stop reason */ } };
    const stop = (error) => {
      if (finished || stopping) return;
      stopping = error;
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (process.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
        let killer;
        try { killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); }
        catch (_) { killChild(); finish(stopping); return; }
        killTimer = setTimeout(() => {
          try { killer.kill(); } catch (_) { /* cleanup remains bounded */ }
          killChild(); finish(stopping);
        }, 5000);
        killer.on('error', () => { if (!finished) { killChild(); finish(stopping); } });
        killer.on('close', () => finish(stopping));
      } else {
        killTimer = setTimeout(() => finish(stopping), 5000);
        killChild();
      }
    };
    const timer = setTimeout(() => stop(new Error(I18n.t('原生能力扫描超时，请检查 CLI 状态'))), 25000);
    const abort = () => stop(new Error(I18n.t('能力扫描已取消')));
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (finished || stopping) return;
      output += chunk;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) stop(new Error(I18n.t('原生能力清单超过大小上限')));
    });
    child.stderr.on('data', () => {});
    child.on('error', () => { if (!stopping) finish(new Error(I18n.t('未能启动 Claude Code'))); });
    child.on('close', code => {
      // On Windows the launcher may exit before taskkill has reaped its tree.
      if (stopping) { if (process.platform !== 'win32') finish(stopping); return; }
      finish(code === 0 ? null : new Error(I18n.t('Claude Code 能力扫描失败，请在原生 CLI 检查配置')));
    });
    child.stdin.on('error', () => stop(new Error(I18n.t('无法完成 Claude Code 能力扫描'))));
    child.stdin.end();
  });
}

function claudeMcpMetadata(text) {
  const result = [];
  const clean = text.replace(/\x1b\[[0-9;]*m/g, '');
  for (const line of clean.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9_.-]{0,199}):\s.+?(Connected|Failed to connect|Needs authentication|Pending approval|Disabled|disconnected)\s*$/i);
    if (!match) continue;
    const status = /^(Connected)$/i.test(match[2]) ? 'ready' : /Disabled/i.test(match[2]) ? 'disabled' : 'unavailable';
    result.push({ id: match[1], name: match[1], kind: 'mcp', enabled: status !== 'disabled', status,
      ...(status === 'disabled' ? { enableSupported: false } : {}) });
  }
  if (!result.length && !/No MCP servers configured|No MCP servers found/i.test(clean)) throw new Error(I18n.t('MCP 清单格式无法识别，请更新 CLI 后重试'));
  return result;
}

async function scan(cliType, cwd, { signal, rpcFactory = options => new CodexRpc(options), readClaude = readClaudeMetadata } = {}) {
  signal?.throwIfAborted();
  const items = [], warnings = [];
  if (cliType === 'codex') {
    const rpc = rpcFactory({ cwd });
    const abort = () => rpc.close();
    signal?.addEventListener('abort', abort, { once: true });
    try {
      await rpc.initialize();
      signal?.throwIfAborted();
      const plugins = await rpc.request('plugin/installed', { cwds: [cwd] });
      if (plugins.marketplaceLoadErrors?.length) warnings.push(I18n.t('部分插件来源未能读取，请检查原生 CLI 后刷新。'));
      for (const marketplace of plugins.marketplaces || []) {
        for (const plugin of marketplace.plugins || []) {
          if (!plugin.installed || !NAME.test(plugin.id)) continue;
          items.push({ id: plugin.id, kind: 'plugin', name: safeText(plugin.name, 100), enabled: plugin.enabled === true,
            status: plugin.enabled ? 'configured' : 'disabled' });
        }
      }
      let cursor;
      for (let page = 0; page < 8; page++) {
        signal?.throwIfAborted();
        const result = await rpc.request('mcpServerStatus/list', { cursor, detail: 'toolsAndAuthOnly', limit: 64 });
        for (const server of result.data || []) {
          if (!NAME.test(server.name)) continue;
          const status = typeof server.runtimeStatus === 'string' ? server.runtimeStatus : server.runtimeStatus?.status;
          items.push({ id: server.name, name: server.name, kind: 'mcp', enabled: true,
            pluginId: server.pluginId || null, selectable: !server.pluginId,
            status: status === 'ready' || Object.keys(server.tools || {}).length ? 'ready' : 'configured',
            toolCount: Object.keys(server.tools || {}).length });
        }
        cursor = result.nextCursor;
        if (!cursor) break;
        if (page === 7) warnings.push(I18n.t('能力清单达到扫描上限，请缩小原生配置。'));
      }
    } finally { signal?.removeEventListener('abort', abort); await rpc.close(); }
  } else {
    const pluginText = await readClaude(['plugin', 'list', '--json'], cwd, signal);
    signal?.throwIfAborted();
    let plugins;
    try { plugins = JSON.parse(pluginText); } catch (_) { throw new Error(I18n.t('Claude Code 插件清单格式无法识别')); }
    if (!Array.isArray(plugins)) plugins = plugins.plugins || [];
    for (const plugin of plugins) {
      if (!NAME.test(plugin.id)) continue;
      items.push({ id: plugin.id, name: safeText(plugin.name || plugin.id.split('@')[0], 100), kind: 'plugin',
        enabled: plugin.enabled === true, status: plugin.enabled ? 'configured' : 'disabled' });
    }
    items.push(...claudeMcpMetadata(await readClaude(['mcp', 'list'], cwd, signal)));
  }
  const result = { cliType, items: items.slice(0, 256), truncated: items.length > 256 || warnings.length > 0, notice: warnings.join(' '), scannedAt: Date.now() };
  if (items.length > 256) result.notice += I18n.t(' 仅显示前 256 项。');
  signal?.throwIfAborted();
  return result;
}

async function discover(cliType, cwd, options = {}) {
  const { refresh = false, scanIfMissing = true, signal } = options;
  signal?.throwIfAborted();
  if (!SUPPORTED.has(cliType)) return { cliType, items: [], notice: I18n.t('此 Agent 的扩展请在原生 CLI 管理。'), unsupported: true };
  const key = cache.key(cliType, cwd);
  const previous = cache.get(cliType, cwd);
  if (!refresh && previous) return { ...previous, cached: true };
  if (!refresh && !scanIfMissing) throw new Error(I18n.t('请先在设置的扩展页面更新此 Agent 的清单'));
  if (cache.loadError && !refresh) throw new Error(I18n.t('保存的扩展清单无法读取，请点击更新'));
  if (!signal && pending.has(key)) return pending.get(key);
  if (pending.size >= 4) throw new Error(I18n.t('正在更新其他 Agent 的扩展，请稍后重试'));
  const activeCache = cache;
  const operation = (async () => {
    try {
      const result = await scan(cliType, cwd, options);
      signal?.throwIfAborted();
      if (result.truncated && previous && !previous.truncated) {
        return { ...previous, cached: true, refreshError: I18n.t('本次清单未能读取完整，已保留上次清单。请检查原生 CLI 后更新。') };
      }
      return activeCache.set(cliType, cwd, result);
    } catch (error) {
      if (signal?.aborted || !previous) throw error;
      return { ...previous, cached: true, refreshError: I18n.t('更新失败，已保留上次清单。请检查原生 CLI 后重试。') };
    }
  })();
  if (!signal) pending.set(key, operation);
  try { return await operation; }
  finally { if (pending.get(key) === operation) pending.delete(key); }
}

async function prepare(bot, cwd, { discovery = discover, signal } = {}) {
  signal?.throwIfAborted();
  const selection = normalizeSelection(bot.nativeCapabilities);
  if (selection.mode === 'inherit') return { nativeArgs: [], nativeConfig: null, cleanup() {} };
  if (!SUPPORTED.has(bot.cliType)) throw new Error(I18n.t('此 Agent 尚不支持逐成员选择原生扩展'));
  const warnings = [];
  let inventory;
  try {
    inventory = await discovery(bot.cliType, cwd, { refresh: false, scanIfMissing: false, signal });
    if (inventory.truncated) throw new Error(I18n.t('能力清单尚未读取完整'));
  } catch (_) {
    signal?.throwIfAborted();
    try {
      inventory = await discovery(bot.cliType, cwd, { refresh: true, signal });
      if (inventory.truncated) throw new Error(I18n.t('能力清单尚未读取完整'));
    } catch (_) {
      signal?.throwIfAborted();
      if (bot.cliType === 'claude') return {
        nativeArgs: ['--safe-mode', '--strict-mcp-config', '--tools', ''], nativeConfig: null,
        warnings: [I18n.t('扩展清单无法读取，本次以无工具安全模式回答。请在设置 → MCP 与插件更新清单后重试。')], cleanup() {},
      };
      throw new Error(I18n.t('Codex 扩展清单无法读取，无法保证已取消的能力保持禁用。请在设置 → MCP 与插件更新清单，或明确选择沿用原生配置；尚未启动模型。'));
    }
  }
  signal?.throwIfAborted();
  if (inventory.refreshError) warnings.push(inventory.refreshError);
  for (const kind of ['mcp', 'plugins']) {
    const actualKind = kind === 'plugins' ? 'plugin' : kind;
    for (const id of selection[kind]) if (!inventory.items.some(item => item.kind === actualKind && item.id === id)) {
      warnings.push(I18n.tpl`原生能力暂不可用：${id}。本次忽略该选择并继续回答；请在设置 → MCP 与插件更新清单。`);
    }
  }
  const mcp = Object.create(null), plugins = Object.create(null);
  for (const item of inventory.items) {
    if (item.kind === 'plugin') plugins[item.id] = { enabled: selection.plugins.includes(item.id) };
    else if (!item.pluginId) mcp[item.id] = { enabled: selection.mcp.includes(item.id) };
  }
  if (bot.cliType === 'codex') return { nativeArgs: [], nativeConfig: { mcp_servers: mcp, plugins }, warnings, cleanup() {} };
  for (const item of inventory.items) {
    if (item.kind !== 'mcp' || !selection.mcp.includes(item.id)) continue;
    if (item.enabled === false || item.enableSupported === false) {
      mcp[item.id].enabled = false;
      warnings.push(I18n.tpl`MCP ${item.name || item.id} 已被 Claude Code 禁用，本次继续回答但不会调用它。需在对应项目的 Claude Code 中执行 /mcp enable ${item.id}，再在应用内更新清单；应用未修改原生配置。`);
    } else if (item.status === 'unavailable') {
      warnings.push(I18n.tpl`MCP ${item.name || item.id} 上次未能连接，仍允许原生 Agent 尝试连接；普通回答继续。请检查该服务的原生登录或授权。`);
    }
  }
  // Only per-invocation settings are written. Native installation/config stays authoritative.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'convoke-settings-'));
  const filename = path.join(directory, 'extensions.json');
  const enabledPlugins = Object.fromEntries(Object.entries(plugins).map(([id, value]) => [id, value.enabled]));
  fs.writeFileSync(filename, JSON.stringify({ enabledPlugins }), { encoding: 'utf8', flag: 'wx' });
  const nativeArgs = ['--settings', filename];
  const blocked = Object.keys(mcp).filter(id => !mcp[id].enabled);
  if (blocked.some(id => !/^[A-Za-z0-9_.-]+$/.test(id))) {
    fs.rmSync(directory, { recursive: true }); throw new Error(I18n.t('MCP 名称暂不支持逐成员筛选，请使用原生配置'));
  }
  if (blocked.length && bot.permissionMode !== 'read_only') nativeArgs.push('--disallowedTools', blocked.map(id => `mcp__${id}__*`).join(','));
  return { nativeArgs, nativeConfig: null, warnings, cleanup() { fs.rmSync(directory, { recursive: true, force: true }); } };
}

module.exports = { normalizeSelection, configureStorage, discover, prepare, claudeMcpMetadata };
