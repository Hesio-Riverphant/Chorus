'use strict';
const I18n = require('../shared/i18n');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { locateCliExecutable } = require('./cliDiscovery');
const { resolveExecutable } = require('./adapters/resolveExecutable');
const { isModelIdentifier } = require('../shared/botProfile');

// Kimi Code 0.28.1: provider list is a metadata command, not an Agent turn.
// The native JSON includes credentials. Keep it private to this module and
// never forward stdout, stderr, configuration, or provider objects to IPC/logs.
function readProviders(settings = {}, signal) {
  return new Promise((resolve, reject) => {
    let executable;
    try { executable = resolveExecutable(locateCliExecutable('kimi', settings) || 'kimi'); }
    catch { reject(new Error(I18n.t('未找到 Kimi Code 可执行文件'))); return; }
    execFile(executable.command, [...executable.argsPrefix, 'provider', 'list', '--json'], {
      windowsHide: true, shell: false, timeout: 8000, maxBuffer: 2 * 1024 * 1024,
      encoding: 'utf8', signal,
      env: { ...process.env, KIMI_DISABLE_TELEMETRY: '1', KIMI_CODE_NO_AUTO_UPDATE: '1' },
    }, (error, stdout) => {
      if (error) { reject(new Error(signal?.aborted ? I18n.t('测试已取消') : I18n.t('Kimi 原生模型列表读取失败，请更新 Kimi Code 后重试'))); return; }
      try {
        const result = JSON.parse(stdout);
        if (!result || Array.isArray(result.models) || typeof result.models !== 'object' || !result.models ||
            Object.keys(result.models).length > 512 || !result.providers || typeof result.providers !== 'object') throw new Error();
        resolve(result);
      } catch { reject(new Error(I18n.t('Kimi 原生模型列表格式不受支持'))); }
    });
  });
}

function metadata(data) {
  return Object.entries(data.models || {}).filter(([id, model]) => isModelIdentifier(id) && model && isModelIdentifier(model.model))
    .map(([id, model]) => {
      const capabilities = Array.isArray(model.capabilities) ? model.capabilities : [];
      const efforts = Array.isArray(model.supportEfforts) ? model.supportEfforts.filter(value => ['low', 'medium', 'high', 'xhigh', 'max'].includes(value)) : [];
      const thinking = capabilities.includes('thinking') || capabilities.includes('always_thinking') || efforts.length > 0;
      return { id, label: id, nativeModel: model.model, source: 'kimi-native',
        reasoningLevels: thinking ? [...(capabilities.includes('always_thinking') ? [] : ['off']), ...(efforts.length ? efforts : ['on'])] : [],
        ...(Number.isSafeInteger(model.maxContextSize) && model.maxContextSize > 0 ? { contextWindow: model.maxContextSize } : {}) };
    });
}

function readVersion(settings = {}, signal) {
  return new Promise(resolve => {
    let executable;
    try { executable = resolveExecutable(locateCliExecutable('kimi', settings) || 'kimi'); } catch { resolve(''); return; }
    execFile(executable.command, [...executable.argsPrefix, '--version'], {
      windowsHide: true, shell: false, timeout: 5000, maxBuffer: 4096, encoding: 'utf8', signal,
    }, (error, stdout) => resolve(!error && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?\s*$/.test(stdout.trim()) ? stdout.trim() : ''));
  });
}

function compatibleReasoning(models, version) {
  // 0.28.1's ACP boolean dispatcher silently maps any other value to off.
  // 2.1.1's published ACP contract exposes native model efforts. Unknown or
  // older versions retain on/off; the runtime still requires an exact ack.
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  const supportsEfforts = match && (Number(match[1]) > 2 || Number(match[1]) === 2 && (Number(match[2]) > 1 || Number(match[2]) === 1 && Number(match[3]) >= 1));
  return models.map(item => ({ ...item, nativeCliVersion: version,
    ...(item.reasoningLevels.length && !supportsEfforts ? {
      declaredReasoningLevels: item.reasoningLevels,
      reasoningLevels: [...(item.reasoningLevels.includes('off') ? ['off'] : []), 'on'],
      reasoningNotice: I18n.t('当前 Kimi CLI 仅通过 ACP 提供开启/关闭；开启时使用原生默认档位。细分档位需升级支持该协议的 Kimi Code。'),
    } : {}) }));
}

async function listKimiModels(settings = {}, signal) {
  const [providers, version] = await Promise.all([readProviders(settings, signal), readVersion(settings, signal)]);
  return compatibleReasoning(metadata(providers), version);
}

function chooseAlias(models, requested) {
  if (!requested || models.some(item => item.id === requested)) return requested;
  const matches = models.filter(item => item.nativeModel === requested);
  if (matches.length === 1) return matches[0].id;
  if (matches.length > 1) throw new Error(I18n.t('多个 Kimi 提供商使用此模型名，请从模型列表选择含提供商的完整名称'));
  throw new Error(I18n.t('Kimi 未配置此模型，请刷新模型列表并选择原生模型名称'));
}

async function resolveKimiModel(requested, settings = {}, signal) {
  if (!requested) return '';
  return chooseAlias(await listKimiModels(settings, signal), requested);
}

function defaultAlias() {
  const root = process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
  if (!path.isAbsolute(root) || /^[\\/]{2}/.test(root)) return '';
  try {
    const file = path.join(root, 'config.toml');
    if (fs.statSync(file).size > 2 * 1024 * 1024) return '';
    // Only the root scalar is needed; all provider/auth parsing stays native.
    const header = fs.readFileSync(file, 'utf8').split(/^\s*\[/m, 1)[0];
    const value = header.match(/^\s*default_model\s*=\s*(?:"([^"\r\n\\]*)"|'([^'\r\n]*)')\s*(?:#.*)?$/m);
    const id = value?.[1] || value?.[2] || '';
    return isModelIdentifier(id) ? id : '';
  } catch { return ''; }
}

function failure(status) {
  if (status === 401 || status === 403) return I18n.t('身份验证失败，请检查 Kimi 提供商的登录或密钥权限');
  if (status === 404) return I18n.t('所选模型或提供商接口不存在');
  if (status === 429) return I18n.t('提供商限流或额度不足');
  if (status >= 500) return I18n.t('提供商服务暂时不可用');
  return I18n.tpl`提供商拒绝请求（HTTP ${status}）`;
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error(I18n.t('提供商返回空响应'));
  const chunks = []; let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 64 * 1024) throw new Error(I18n.t('提供商响应超过连接测试上限'));
      chunks.push(Buffer.from(value));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new Error(I18n.t('提供商返回了无效响应')); }
  } catch { throw new Error(I18n.t('提供商响应无效或超过连接测试上限')); }
  finally { await reader.cancel().catch(() => {}); }
}

// A small real model request without starting Kimi's Agent/MCP processes.
// Protocol verified against the installed KimiChatProvider (OpenAI chat API).
// OAuth-managed providers deliberately stay unsupported until their refresh
// contract is implemented; no token files are copied or refreshed here.
async function probeKimi(requested, settings = {}, signal, fetchImpl = fetch) {
  const data = await readProviders(settings, signal);
  const alias = chooseAlias(metadata(data), requested || defaultAlias());
  const model = data.models[alias];
  if (!model) throw new Error(I18n.t('Kimi 尚未配置默认模型，请选择模型后测试'));
  const provider = data.providers[model.provider];
  if (!provider || !['kimi', 'openai'].includes(provider.type) || provider.oauth) {
    throw new Error(I18n.t('此 Kimi 提供商暂不支持无工具连接测试，请使用原生 CLI 验证'));
  }
  const apiKey = provider.apiKey || (provider.type === 'kimi' ? process.env.KIMI_API_KEY : undefined);
  if (typeof apiKey !== 'string' || !apiKey || /[\r\n]/.test(apiKey)) throw new Error(I18n.t('Kimi 提供商没有可用的 API 密钥'));
  let endpoint;
  try {
    const base = provider.baseUrl || (provider.type === 'kimi' ? process.env.KIMI_BASE_URL || 'https://api.moonshot.ai/v1' : 'https://api.openai.com/v1');
    endpoint = new URL(base.replace(/\/+$/, '') + '/chat/completions');
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
  } catch { throw new Error(I18n.t('Kimi 提供商接口地址无效')); }
  const body = { model: model.model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false,
    ...(provider.type === 'kimi' ? { max_completion_tokens: 32, thinking: { type: 'disabled' } } : { max_tokens: 32 }) };
  let response;
  try {
    response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify(body) });
  } catch { throw new Error(signal?.aborted ? I18n.t('测试已取消或超时') : I18n.t('无法连接 Kimi 提供商，请检查网络和接口地址')); }
  if (!response.ok) { await response.body?.cancel().catch(() => {}); return { ok: false, detail: failure(response.status) }; }
  const result = await boundedJson(response);
  const content = result.choices?.[0]?.message?.content;
  if (result.error || typeof content !== 'string' || !content.trim()) return { ok: false, detail: I18n.t('提供商未返回模型回复') };
  return { ok: true, detail: I18n.t('模型连接成功'), model: alias, transport: 'provider-api' };
}

module.exports = { listKimiModels, resolveKimiModel, probeKimi, metadata, chooseAlias, compatibleReasoning };
