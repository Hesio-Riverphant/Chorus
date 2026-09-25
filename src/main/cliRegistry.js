'use strict';
const I18n = require('../shared/i18n');

const path = require('node:path');
const BUILTINS = [
  { id: 'claude', label: 'Claude Code', historyModeSupport: 'verified', historyFlag: '--no-session-persistence' },
  { id: 'codex', label: 'Codex', historyModeSupport: 'verified', historyFlag: '--ephemeral' },
  { id: 'kimi', label: 'Kimi Code', historyModeSupport: 'unknown' },
  { id: 'codebuddy', label: 'CodeBuddy Code', historyModeSupport: 'documented', historyFlag: '--no-session-persistence' },
  { id: 'gemini', label: 'Gemini CLI', historyModeSupport: 'unknown' },
  { id: 'qwen', label: 'Qwen Code', historyModeSupport: 'unknown' },
  { id: 'copilot', label: 'GitHub Copilot CLI', historyModeSupport: 'unknown' },
  { id: 'cursor', command: 'agent', label: 'Cursor Agent', historyModeSupport: 'unknown' },
  { id: 'droid', label: 'Factory Droid', historyModeSupport: 'unknown' },
  { id: 'zcode', label: 'ZCode', historyModeSupport: 'unknown' },
  { id: 'pi', label: 'Pi', historyModeSupport: 'verified', historyFlag: '--no-session' },
  { id: 'opencode', label: 'OpenCode', historyModeSupport: 'unsupported' },
  { id: 'hermes', label: 'Hermes', historyModeSupport: 'unknown' },
].map(item => Object.freeze({ ...item, builtin: true,
  subagentSupport: ['claude', 'codex', 'codebuddy', 'qwen'].includes(item.id) ? 'events' : item.id === 'kimi' ? 'summary' : 'unavailable' }));
const isCliId = value => typeof value === 'string' && (BUILTINS.some(item => item.id === value) || /^custom_[a-f0-9]{32}$/.test(value));

function normalizeProfiles(profiles = []) {
  if (!Array.isArray(profiles) || profiles.length > 32) throw new Error(I18n.t('自定义 CLI 最多 32 个'));
  const ids = new Set();
  const labels = new Set();
  return profiles.map(profile => {
    if (!profile || typeof profile !== 'object' || !/^custom_[a-f0-9]{32}$/.test(profile.id) || ids.has(profile.id)) throw new Error(I18n.t('CLI 标识无效或重复'));
    ids.add(profile.id);
    const label = typeof profile.label === 'string' ? profile.label.trim() : '';
    if (!label || label.length > 80 || /[\x00-\x1f]/.test(label) || labels.has(label.toLowerCase())) throw new Error(I18n.t('CLI 名称无效或重复'));
    labels.add(label.toLowerCase());
    const command = profile.command;
    const absolute = typeof command === 'string' && (path.win32.isAbsolute(command) && /\.(exe|cmd)$/i.test(command) || path.posix.isAbsolute(command));
    if (!absolute || command.length > 1024 || /^[\\/]{2}/.test(command) || /[\x00-\x1f"%]/.test(command)) throw new Error(I18n.t('程序须为本地可执行文件的完整路径（Windows 使用 .exe 或标准 npm .cmd）'));
    if (!['stdin', 'arg'].includes(profile.promptMode) || !['text', 'jsonl'].includes(profile.outputMode)) throw new Error(I18n.t('CLI 输入或输出方式无效'));
    const args = validateArgs(profile.args);
    const historyArgs = validateArgs(profile.historyArgs || []);
    const promptCount = args.filter(arg => arg === '{prompt}').length;
    if (promptCount !== (profile.promptMode === 'arg' ? 1 : 0) || historyArgs.some(arg => /\{/.test(arg))) throw new Error(I18n.t('命令行消息需要且仅需要一个独立的 {prompt} 参数'));
    return { id: profile.id, label, command, args, promptMode: profile.promptMode, outputMode: profile.outputMode, historyArgs };
  });
}

function validateArgs(args) {
  if (!Array.isArray(args) || args.length > 64 || args.some(arg => typeof arg !== 'string' || !arg || arg.length > 2048 || /[\x00-\x1f]/.test(arg) ||
      (/\{|\}/.test(arg) && !['{prompt}', '{model}'].includes(arg)) || /(?:api[-_]?key|access[-_]?token|bearer|password|secret|cookie|authorization)(?:\b|=)/i.test(arg))) {
    throw new Error(I18n.t('参数须为逐项文字，最多 64 项；仅支持独立的 {prompt}/{model}，凭据请在原生 CLI 配置'));
  }
  return [...args];
}

function listProfiles(settings = {}) {
  return [...BUILTINS, ...normalizeProfiles(settings.cliProfiles).map(profile => ({ ...profile, builtin: false, historyModeSupport: 'unknown',
    subagentSupport: profile.outputMode === 'jsonl' ? 'protocol' : 'unavailable' }))];
}
function findProfile(id, settings = {}) { return listProfiles(settings).find(item => item.id === id); }
function normalizeEnabledCliIds(ids, settings = {}) {
  if (!Array.isArray(ids) || ids.length > BUILTINS.length + 32 || ids.some(id => typeof id !== 'string' || !findProfile(id, settings))) {
    throw new Error(I18n.t('Agent 接入选择无效，请重新扫描并选择'));
  }
  return [...new Set(ids)];
}
// An older store keeps only the providers its existing members actually use.
// Discovery and editing definitions never opt an Agent in on the user's behalf.
function resolveEnabledCliIds(settings = {}, bots = []) {
  if (Object.hasOwn(settings, 'enabledCliIds')) return normalizeEnabledCliIds(settings.enabledCliIds, settings);
  return [...new Set(bots.filter(bot => bot && findProfile(bot.cliType, settings)).map(bot => bot.cliType))];
}
function requireEnabled(id, settings = {}) {
  if (Object.hasOwn(settings, 'enabledCliIds') && !normalizeEnabledCliIds(settings.enabledCliIds, settings).includes(id)) {
    throw new Error(I18n.t('请先在设置的 Agent 接入中启用此 Agent'));
  }
}
function requireAppOnly(id, settings = {}) {
  const profile = findProfile(id, settings);
  if (!profile) throw new Error(I18n.t('CLI 接入不存在，请在设置中重新选择'));
  // Prefer verified no-save flags; unknown native history behavior is advisory.
  // Kept under its original export for existing callers and stored settings.
  return profile;
}

module.exports = { BUILTINS, isCliId, normalizeProfiles, listProfiles, findProfile, requireAppOnly, requireEnabled, normalizeEnabledCliIds, resolveEnabledCliIds };
