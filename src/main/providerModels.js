'use strict';
const I18n = require('../shared/i18n');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isModelIdentifier } = require('../shared/botProfile');

// Read only Claude's user-level env overlay. Credentials remain in this
// module and request headers; neither native JSON nor HTTP bodies reach IPC.
function claudeEnvironment(homeDir, env) {
  const directory = env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
  if (!path.isAbsolute(directory) || /^[\\/]{2}/.test(directory)) throw new Error(I18n.t('Claude 配置目录无效'));
  const result = { ...env };
  try {
    const file = path.join(directory, 'settings.json'), stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error();
    const configured = JSON.parse(fs.readFileSync(file, 'utf8')).env;
    if (configured && typeof configured === 'object' && !Array.isArray(configured)) {
      for (const key of ['ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) {
        if (typeof configured[key] === 'string') result[key] = configured[key];
      }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(I18n.t('Claude 用户配置读取失败'));
  }
  return result;
}

async function readModelPage(response) {
  if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error(I18n.tpl`模型列表请求失败（HTTP ${response.status}）`); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(I18n.t('模型列表为空'));
  const chunks = []; let bytes = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      bytes += part.value.length;
      if (bytes > 2 * 1024 * 1024) throw new Error(I18n.t('模型列表超过大小上限'));
      chunks.push(Buffer.from(part.value));
    }
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(parsed.data) || parsed.data.length > 512) throw new Error();
    return parsed;
  } catch { throw new Error(I18n.t('模型列表格式无效或超过大小上限')); }
  finally { await reader.cancel().catch(() => {}); }
}

async function discoverClaudeModels({ homeDir = os.homedir(), env = process.env, fetchImpl = fetch } = {}) {
  const config = claudeEnvironment(homeDir, env);
  const key = config.ANTHROPIC_API_KEY, token = config.ANTHROPIC_AUTH_TOKEN;
  if (!(typeof token === 'string' && token || typeof key === 'string' && key)) {
    throw new Error(I18n.t('当前 Claude 登录未提供模型目录接口凭据，保留原生模型别名'));
  }
  let url;
  try {
    const base = (config.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, '');
    url = new URL(base + (base.endsWith('/v1') ? '/models' : '/v1/models'));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        [key, token].some(value => typeof value === 'string' && /[\r\n]/.test(value))) throw new Error();
  } catch { throw new Error(I18n.t('Claude 提供商接口配置无效')); }
  const headers = { 'anthropic-version': '2023-06-01', Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  else headers['x-api-key'] = key;
  const models = [], seen = new Set(), signal = AbortSignal.timeout(8000);
  const alternative = url.pathname.endsWith('/anthropic/v1/models') ? new URL(url) : null;
  if (alternative) alternative.pathname = alternative.pathname.replace(/\/anthropic\/v1\/models$/, '/v1/models');
  for (let page = 0; page < 4; page += 1) {
    let response;
    try { response = await fetchImpl(url, { method: 'GET', headers, signal, redirect: 'error' }); }
    catch { throw new Error(I18n.t('无法读取 Claude 提供商模型目录，请检查网络或提供商是否支持 /v1/models')); }
    // Gateways may route Messages under /anthropic while exposing a shared
    // model catalog under /v1/models. Only try this same-origin metadata path
    // after a definitive 404, preserving the configured host and auth scheme.
    if (page === 0 && response.status === 404 && alternative) {
      await response.body?.cancel().catch(() => {}); url = alternative;
      try { response = await fetchImpl(url, { method: 'GET', headers, signal, redirect: 'error' }); }
      catch { throw new Error(I18n.t('无法读取 Claude 提供商模型目录')); }
    }
    const body = await readModelPage(response);
    for (const item of body.data) {
      if (!item || !isModelIdentifier(item.id) || seen.has(item.id)) continue;
      seen.add(item.id);
      const name = item.display_name || item.name;
      models.push({ id: item.id, label: typeof name === 'string' && name.length <= 200 && !/[\x00-\x1f]/.test(name) ? name : item.id, source: 'claude-provider' });
      if (models.length >= 128) return models;
    }
    if (!body.has_more) break;
    if (!isModelIdentifier(body.last_id)) throw new Error(I18n.t('提供商模型分页格式无效'));
    url = new URL(url); url.searchParams.set('after_id', body.last_id);
  }
  return models;
}

module.exports = { discoverClaudeModels };
