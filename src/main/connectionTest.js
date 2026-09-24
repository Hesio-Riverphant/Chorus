'use strict';
const I18n = require('../shared/i18n');
const { isModelIdentifier } = require('../shared/botProfile');
const { normalizeEffort, normalizeExecutionMode } = require('../shared/reasoning');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const adapter = require('./adapters/cliAdapter');
const { findProfile } = require('./cliRegistry');
const { probeKimi } = require('./kimiNative');

const active = new Map();
const MAX_CONCURRENT = 3;
const TIMEOUT_MS = 30000;
const keyFor = payload => JSON.stringify([payload.cliType, payload.model || '']);

function failureReason(error) {
  const text = String(error || '');
  if (/timeout|超时/i.test(text)) return I18n.t('连接超时');
  if (/401|403|unauthori[sz]ed|authentication|login|登录/i.test(text)) return I18n.t('身份验证失败，请检查原生 Agent 登录');
  if (/429|rate.?limit|quota|额度/i.test(text)) return I18n.t('提供商限流或额度不足');
  if (/404|model.*(?:not found|unavailable|not supported)|模型.*(?:不存在|不可用)/i.test(text)) return I18n.t('所选模型不可用');
  if (/50[234]|service unavailable/i.test(text)) return I18n.t('提供商服务暂时不可用');
  if (/ENOENT|未找到|无法启动|可执行文件/i.test(text)) return I18n.t('未找到 Agent 程序，请检查安装和路径');
  if (/ECONN|ENOTFOUND|fetch failed|network|网络/i.test(text)) return I18n.t('网络连接失败');
  return I18n.t('Agent 执行失败，请检查原生 Agent 的登录与模型配置');
}

async function test(payload, settings = {}) {
  if (!payload || !findProfile(payload.cliType, settings) ||
      (payload.model != null && (typeof payload.model !== 'string' || (payload.model && !isModelIdentifier(payload.model))))) {
    throw new Error(I18n.t('请选择有效的 CLI 和模型名称'));
  }
  if (payload.confirmed !== true) throw new Error(I18n.t('连接测试会调用所选 CLI 和模型，请先确认'));
  if (payload.cliType === 'zcode') return { ok: false, detail: I18n.t('ZCode 暂无已验证的无工具连接测试，请在原生 CLI 中验证连接'), elapsedMs: 0 };
  const key = keyFor(payload);
  if (active.has(key)) throw new Error(I18n.t('此 Agent 和模型已有连接测试正在进行'));
  if (active.size >= MAX_CONCURRENT) throw new Error(I18n.t('最多同时测试 3 个连接，请等待其中一个完成'));
  const reasoningEffort = normalizeEffort(payload.cliType, payload.reasoningEffort, payload.model);
  const executionMode = normalizeExecutionMode(payload.cliType, payload.executionMode);
  const operation = { handle: null, controller: new AbortController(), timedOut: false, cancelled: false };
  active.set(key, operation);
  const started = Date.now();
  let workspace, outcome;
  const timer = setTimeout(() => {
    operation.timedOut = true;
    operation.controller.abort();
    operation.handle?.cancel();
  }, TIMEOUT_MS);
  try {
    if (payload.cliType === 'kimi') {
      outcome = await probeKimi(payload.model || '', settings, operation.controller.signal);
    } else {
      workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-connection-'));
      operation.handle = adapter.runBot({
        bot: { cliType: payload.cliType, model: payload.model || '', reasoningEffort, executionMode, permissionMode: 'read_only' },
        prompt: 'Reply with OK. Do not use tools, read files, or execute commands.',
        cliSettings: settings, workspace, priorSessionId: null, noBytesTimeoutMs: 20000, probe: true,
      });
      const result = await operation.handle.promise;
      const text = String(result.text || '').trim();
      const rawTextProtocol = payload.cliType.startsWith('custom_') || ['pi', 'hermes', 'copilot'].includes(payload.cliType);
      outcome = result.aborted ? { ok: false, detail: I18n.t('测试已取消') }
        : result.error ? { ok: false, detail: failureReason(result.error) }
          : text && (!rawTextProtocol || /^OK[.!。！]?$/i.test(text)) ? { ok: true, detail: I18n.t('连接成功') }
            : { ok: false, detail: I18n.t('Agent 未返回模型回复') };
    }
  } catch (error) {
    // kimiNative throws application-owned messages only; never expose native
    // stderr or HTTP response bodies, which may contain credentials.
    outcome = { ok: false, detail: payload.cliType === 'kimi' ? error.message : failureReason(error.message) };
  } finally {
    clearTimeout(timer);
    if (operation.timedOut) outcome = { ok: false, detail: I18n.t('连接超时（30 秒）') };
    else if (operation.cancelled) outcome = { ok: false, detail: I18n.t('测试已取消') };
    active.delete(key);
    if (workspace) {
      try { fs.rmSync(workspace, { recursive: true, force: true }); }
      catch { outcome.detail += I18n.t(' 临时测试目录未能清理。'); }
    }
  }
  return { ...outcome, elapsedMs: Date.now() - started };
}

async function cancel(payload) {
  const operations = payload ? [active.get(keyFor(payload))].filter(Boolean) : [...active.values()];
  await Promise.all(operations.map(async operation => {
    operation.cancelled = true; operation.controller.abort(); await operation.handle?.cancel();
  }));
}

module.exports = { test, cancel };
