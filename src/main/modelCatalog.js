'use strict';
const I18n = require('../shared/i18n');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isModelIdentifier } = require('../shared/botProfile');
const Reasoning = require('../shared/reasoning');

const MAX_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_RECORDS = 512;
const MAX_MODELS = 128;
const { findProfile } = require('./cliRegistry');
// Known model identifiers; suggestions only, never proof of account entitlements.
// https://developers.openai.com/codex/models/
const CODEX_CANDIDATES = ['gpt-6-astra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
// Local claude --help and https://code.claude.com/docs/en/model-config.
const CLAUDE_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'];
const AVAILABILITY_NOTICE = '模型可用性以“测试连接”为准。';
const MODEL_LABELS = { fable: 'Claude Fable', opus: 'Claude Opus', sonnet: 'Claude Sonnet', haiku: 'Claude Haiku',
  'gpt-6-astra': 'GPT-6 Astra', 'gpt-6-sol': 'GPT-6 Sol', 'gpt-6-luna': 'GPT-6 Luna', 'gpt-5.6-sol': 'GPT-5.6 Sol', 'gpt-5.6-terra': 'GPT-5.6 Terra', 'gpt-5.6-luna': 'GPT-5.6 Luna' };

function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
const validId = isModelIdentifier;
function validLabel(value) {
  return typeof value === 'string' && value.trim() && value.length <= 200 && !/[\x00-\x1f\x7f]/.test(value);
}

function codexCache(homeDir, env) {
  let fd;
  try {
    const configured = record(env) ? env.CODEX_HOME : undefined;
    const base = configured == null || configured === '' ? homeDir : configured;
    if (typeof base !== 'string' || !path.isAbsolute(base) || /^[\\/]{2}/.test(base) || /[\x00-\x1f]/.test(base)) {
      return { models: [], notice: I18n.t('Codex 模型缓存目录无效，未读取。') };
    }
    const file = path.join(base, configured == null || configured === '' ? '.codex' : '', 'models_cache.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { models: [], notice: I18n.t('Codex 模型缓存不是普通文件，未读取。') };
    if (stat.size > MAX_CACHE_BYTES) return { models: [], notice: I18n.t('Codex 模型缓存超过 2 MB 上限，未读取。') };
    fd = fs.openSync(file, 'r');
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_CACHE_BYTES) return { models: [], notice: I18n.t('Codex 模型缓存类型或大小超出上限，未读取。') };
    // Cap the actual read as well as stat, including files growing during a refresh.
    const buffer = Buffer.alloc(MAX_CACHE_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
      if (!count) break;
      bytes += count;
    }
    if (bytes > MAX_CACHE_BYTES) return { models: [], notice: I18n.t('Codex 模型缓存超过 2 MB 上限，未读取。') };
    const data = JSON.parse(buffer.toString('utf8', 0, bytes));
    if (!record(data) || !Array.isArray(data.models)) return { models: [], notice: I18n.t('Codex 模型缓存格式无效，已忽略。') };
    if (data.models.length > MAX_RECORDS) return { models: [], notice: I18n.t('Codex 模型缓存超过 512 条上限，已忽略。') };
    const models = data.models.filter((item) => record(item) && validId(item.slug) && item.visibility === 'list')
      .map((item) => {
        const result = { id: item.slug, label: validLabel(item.display_name) ? item.display_name.trim() : item.slug, source: 'codex-cache' };
        if (Array.isArray(item.supported_reasoning_levels)) {
          result.reasoningLevels = [...new Set(item.supported_reasoning_levels.slice(0, 24).map(level =>
            typeof level === 'string' ? level : level?.effort).filter(Reasoning.isEffort))];
        }
        if (Number.isSafeInteger(item.context_window) && item.context_window > 0) result.contextWindow = item.context_window;
        return result;
      });
    return { models, notice: models.length ? I18n.t('优先使用本地 Codex 模型缓存；缓存可能过期。') : I18n.t('Codex 模型缓存没有有效的可见模型。') };
  } catch (error) {
    return { models: [], notice: error.code === 'ENOENT' ? I18n.t('未找到本地 Codex 模型缓存。')
      : error instanceof SyntaxError ? I18n.t('Codex 模型缓存格式无效，已忽略。') : I18n.t('本地 Codex 模型缓存读取失败。') };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Metadata only: never reads auth/config files or launches a CLI/model request. */
function listModels(cliType, { bots = [], settings = {}, homeDir = os.homedir(), env = process.env } = {}) {
  if (!findProfile(cliType, settings)) throw new Error(I18n.t('不支持的 CLI 类型'));
  const models = [];
  const seen = new Set();
  const notices = [];
  let truncated = false;
  function add(item) {
    if (seen.has(item.id)) return;
    if (models.length >= MAX_MODELS) { truncated = true; return; }
    seen.add(item.id);
    models.push(item);
  }
  if (cliType === 'zcode') return { models: [], customAllowed: false, reasoningLevels: [], planSupported: false,
    notice: I18n.t('ZCode 当前接入仅支持原生默认模型，请在原生 CLI 中选择模型') + '。' + I18n.t('ZCode 当前接入未验证严格只读或工作区权限，请明确选择全权限后使用') };
  if (cliType === 'codex') {
    const cached = codexCache(homeDir, env);
    cached.models.forEach(add);
    notices.push(cached.notice);
    CODEX_CANDIDATES.forEach((id) => add({ id, label: I18n.tpl`${MODEL_LABELS[id]} · 候选`, source: 'candidate' }));
    notices.push(I18n.t('“候选”为补充模型名称，不代表当前提供商已授权；可自定义完整模型 ID。'));
  } else if (cliType === 'claude') {
    CLAUDE_ALIASES.forEach((id) => add({ id, label: MODEL_LABELS[id], source: 'claude-alias' }));
    notices.push(I18n.t('具体版本随当前账号及提供商配置。'));
  } else if (cliType === 'gemini') {
    ['auto', 'pro', 'flash', 'flash-lite'].forEach(id => add({ id, label: id, source: 'gemini-alias' }));
    notices.push(I18n.t('Gemini 官方模型别名；当前未提供账户模型目录读取接口，可填写完整模型 ID。'));
  } else {
    notices.push(I18n.t('可使用默认模型，或填写在该 Agent 中可用的完整模型 ID。'));
  }
  if (Array.isArray(bots)) {
    bots.slice(0, MAX_RECORDS).forEach((bot) => {
      if (record(bot) && bot.cliType === cliType && validId(bot.model) &&
          !(Array.isArray(settings.hiddenModelCandidates) && settings.hiddenModelCandidates.some(item => item?.cliType === cliType && item.model === bot.model))) {
        add({ id: bot.model, label: bot.model, source: 'saved-bot' });
      }
    });
    if (bots.length > MAX_RECORDS) notices.push(I18n.t('已保存成员扫描达到 512 条上限。'));
  }
  if (truncated) notices.push(I18n.t('模型列表达到 128 条上限。'));
  notices.push(I18n.t(AVAILABILITY_NOTICE));
  const customHint = cliType === 'claude' ? I18n.t('填写 Claude Code 支持的完整模型 ID，例如 claude-fable-5；自定义提供商请使用其模型 ID。')
    : cliType === 'codex' ? I18n.t('填写 Codex 当前提供商支持的模型 ID，例如 gpt-6-astra。')
      : cliType === 'pi' ? I18n.t('填写 Pi 支持的 provider/model，例如 openai/gpt-4o。') : I18n.t('填写此 Agent 当前账号或提供商支持的完整模型 ID。');
  return { models, notice: notices.join(' '), customHint,
    reasoningLevels: Reasoning.levelsFor(cliType), planSupported: cliType === 'claude' };
}

// Native discovery happens only through explicit metadata interfaces, without
// making a model request. Refreshing a catalog never certifies account access.
async function discoverModels(cliType, options = {}) {
  const result = listModels(cliType, options);
  let native = [];
  if (cliType === 'kimi') {
    try {
      native = await require('./kimiNative').listKimiModels(options.settings);
      result.notice = I18n.t('已读取 Kimi 原生模型配置与推理档位。旧版 Kimi ACP 仅支持开启/关闭；细分档位需要原生 CLI 支持。') + I18n.t(AVAILABILITY_NOTICE);
    } catch (error) { result.notice = error.message + I18n.t('；仍可填写自定义模型。'); }
  } else if (cliType === 'claude' && options.refresh) {
    try {
      native = await require('./providerModels').discoverClaudeModels(options);
      result.notice = native.length ? I18n.t('已从 Claude 用户级提供商获取模型列表；项目目录中的单独配置可能不同。') + I18n.t(AVAILABILITY_NOTICE) : I18n.t('提供商返回空模型目录，保留原生模型别名。');
    } catch (error) { result.notice = error.message + '。' + I18n.t(AVAILABILITY_NOTICE); }
  } else if (cliType === 'codex' && options.refresh) {
    let rpc;
    try {
      const { CodexRpc } = require('./adapters/codexRpc');
      rpc = new CodexRpc({ cwd: os.tmpdir(), timeoutMs: 8000, cliSettings: options.settings });
      await rpc.initialize();
      let cursor = null;
      for (let page = 0; page < 4; page += 1) {
        const response = await rpc.request('model/list', { limit: 100, cursor, includeHidden: false }, 8000);
        if (!Array.isArray(response?.data)) throw new Error();
        for (const model of response.data) {
          if (!validId(model.model || model.id) || model.hidden === true) continue;
          native.push({ id: model.model || model.id, label: validLabel(model.displayName) ? model.displayName : model.model || model.id,
            source: 'codex-native', reasoningLevels: (model.supportedReasoningEfforts || []).map(item => item.reasoningEffort).filter(Reasoning.isEffort) });
        }
        cursor = response.nextCursor;
        if (!cursor) break;
      }
      result.notice = I18n.t('已从 Codex 获取模型列表。') + I18n.t(AVAILABILITY_NOTICE);
    } catch { result.notice = I18n.t('Codex 原生模型列表刷新失败，保留本地候选。') + I18n.t(AVAILABILITY_NOTICE); }
    finally { await rpc?.close(); }
  }
  if (native.length) {
    const ids = new Set(native.map(item => item.id));
    result.models = [...native, ...result.models.filter(item => !ids.has(item.id))].slice(0, MAX_MODELS);
  }
  return result;
}

module.exports = { listModels, discoverModels };
