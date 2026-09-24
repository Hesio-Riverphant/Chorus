'use strict';
const I18n = require('../../shared/i18n');
const { getDefaultPersona } = require('../../shared/botProfile');
const { estimateTokens } = require('../../shared/util');
const { DEFAULTS } = require('../../shared/constants');

function labelOf(msg, bots) {
  if (msg.authorType === 'human') return '房主';
  if (msg.authorType === 'system') return '系统';
  const b = (bots || []).find((x) => x.id === msg.authorId);
  return b ? b.name : '成员';
}

function buildMessagesText(messages, bots) {
  return messages
    .filter((m) => typeof m.text === 'string' && m.text.trim())
    .map((m) => `${labelOf(m, bots)}：${m.text}`)
    .join('\n');
}

function isTranscriptMessage(message, bot) {
  return !message.supersededBy && message.status === 'done' && typeof message.text === 'string' && message.text.trim() &&
    (!bot || !['plan', 'goal'].includes(message.mode) || !Array.isArray(message.modeTargetIds) || message.modeTargetIds.includes(bot.id));
}

// The room log remains complete. Only older messages are bounded for a new
// invocation; the human request and all current-round replies stay intact.
// A null roundId previews the next human turn (whose draft is not included).
function selectTranscript(messages, bot, bots, { roundId = null, catchupMessages = DEFAULTS.catchupMessages,
  historyTokenBudget = DEFAULTS.historyTokenBudget } = {}) {
  const anchor = roundId == null ? messages.length : messages.findIndex(message => message.id === roundId);
  if (anchor < 0) throw new Error(I18n.t('本轮消息不存在，不能确定输入历史范围'));
  const count = Number.isFinite(Number(catchupMessages)) ? Math.max(0, Math.min(500, Math.floor(Number(catchupMessages)))) : DEFAULTS.catchupMessages;
  const budget = Number.isSafeInteger(Number(historyTokenBudget)) && Number(historyTokenBudget) >= 0 ? Number(historyTokenBudget) : DEFAULTS.historyTokenBudget;
  const eligible = messages.slice(0, anchor).filter(message => isTranscriptMessage(message, bot));
  const history = count ? eligible.slice(-count) : [];
  let historyTokens = 0, start = history.length;
  // Keep a contiguous recent suffix; do not cut sentences or silently skip a
  // large recent answer in favor of unrelated older ones.
  while (start > 0) {
    const tokens = estimateTokens(buildMessagesText([history[start - 1]], bots) + '\n');
    if (budget && historyTokens + tokens > budget) break;
    historyTokens += tokens;
    start--;
  }
  const selected = history.slice(start);
  const current = messages.slice(anchor).filter(message => isTranscriptMessage(message, bot));
  return { messages: [...selected, ...current], historyMessages: selected.length, currentMessages: current.length,
    historyTokenEstimate: historyTokens, omittedHistoryMessages: eligible.length - selected.length, historyTokenBudget: budget };
}

function buildRosterText(bot, bots, room) {
  const lines = bots.map((b) => {
    const tags = [];
    if (room && b.id === room.moderatorBotId) tags.push('主持人');
    if (b.id === bot.id) tags.push('你');
    const role = b.role ? `，角色：${b.role}` : '';
    return `- ${b.name}（${b.cliType}${role}${tags.length ? '，' + tags.join('、') : ''}）`;
  });
  return '【房间成员】\n' + lines.join('\n');
}

// Keep free-form persona text in the stdin prompt, outside shell arguments.
// skillBlocks: per-message skills chosen via "/", [{ name, body }].
function buildPrompt(bot, slice, bots, room, skillBlocks) {
  skillBlocks = skillBlocks || [];
  const parts = [];

  parts.push(buildRosterText(bot, bots, room));

  const persona = bot.persona && bot.persona.trim() ? bot.persona : getDefaultPersona(bot.role, bot.customRole);
  if (persona) parts.push(`【你的角色设定】${persona}`);

  for (const sk of skillBlocks) {
    if (sk.mode === 'unavailable') {
      parts.push(`【技能引用不可用：${sk.name}】${sk.reason}。本次未提供此技能，不得假称已调用；说明限制后继续能完成的请求。`);
      continue;
    }
    if (sk.mode === 'reference' && sk.category === 'other' && !sk.nativeCliType) {
      parts.push(`【本次引用共享技能：${sk.name}】房主指定来源文件：${sk.skillFile}。请按当前权限读取并遵循此文件。` +
        '这是外部文件引用，未声称在你的原生框架中安装。若来源不可读或依赖的工具、接口不受当前宿主支持，请先说明限制，不得假称完成。');
      continue;
    }
    if (sk.mode === 'reference') {
      parts.push(`【本次使用原生技能：${sk.name}】请使用你的 CLI 已发现的同名技能，指定来源文件：${sk.skillFile}。` +
        '请由你的 CLI 按权限读取该文件并严格遵循原文；应用仅提供来源引用，未复制正文，也未验证你已原生加载。' +
        '若该技能未被你的 CLI 发现、来源不可访问或内容不匹配，请明确说明并停止该技能任务，不得假称已调用或自行切换同名来源。');
      continue;
    }
    const body = (sk.body || '').trim();
    parts.push(
      `【本次使用技能：${sk.name}】房主在本条消息中指定你使用该技能，请严格按以下技能说明完成本次任务：\n` +
      (body || `（请调用你框架内名为「${sk.name}」的技能）`)
    );
  }

  parts.push(
    '【群聊规则】以上是全部成员。接续下方署名共享消息，直接发言，不逐条复述；用 @成员名称 请求协助，@全体 呼叫所有人。'
  );

  parts.push('【共享消息】\n' + buildMessagesText(slice, bots));

  return parts.join('\n\n');
}

module.exports = { labelOf, buildPrompt, isTranscriptMessage, selectTranscript };
