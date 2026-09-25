'use strict';
const I18n = require('../../shared/i18n');
const { getDefaultPersona } = require('../../shared/botProfile');
const { estimateTokens } = require('../../shared/util');
const { DEFAULTS } = require('../../shared/constants');
const { parseMentions } = require('../../shared/mention');
const MessageContent = require('../../shared/messageContent');

const incomplete = message => ['error', 'aborted'].includes(message.status);
function transcriptText(message) {
  const text = typeof message.text === 'string' ? message.text : '';
  if (!incomplete(message)) return text;
  const progress = MessageContent.progress(message);
  if (progress === text || (message.activities || []).some(activity => activity.phase === 'commentary' && activity.detail === text)) return progress;
  return [progress, text].filter(Boolean).join('\n\n');
}

function labelOf(msg, bots) {
  if (msg.authorType === 'human') return '房主';
  if (msg.authorType === 'system') return '系统';
  const b = (bots || []).find((x) => x.id === msg.authorId);
  return b ? b.name : '成员';
}

function buildMessagesText(messages, bots) {
  return messages
    .filter((m) => transcriptText(m).trim() || m.error)
    .map((m) => `${labelOf(m, bots)}：${transcriptText(m)}${incomplete(m)
      ? `\n【未完成的执行；请依据最新请求决定是否续接，先核对已有副作用】${m.error || '执行已中断'}` : ''}`)
    .join('\n');
}

function isTranscriptMessage(message, bot) {
  return !message.supersededBy && ['done', 'error', 'aborted'].includes(message.status) &&
    (transcriptText(message).trim() || message.error) &&
    (!bot || !Array.isArray(message.audienceBotIds) || message.audienceBotIds.includes(bot.id)) &&
    (!bot || !['plan', 'goal'].includes(message.mode) || !Array.isArray(message.modeTargetIds) || message.modeTargetIds.includes(bot.id));
}

// Explicit human recipients also bound later history delivery. Resolve older
// records at read time; no rewrite of personal history is required.
function audienceFor(message, messages, bots) {
  if (Array.isArray(message.audienceBotIds)) return message.audienceBotIds;
  const human = message.authorType === 'human' ? message : messages.find(item => item.id === message.roundId && item.authorType === 'human');
  if (!human) return null;
  if (Array.isArray(human.audienceBotIds)) return human.audienceBotIds;
  if (human.targetBotId) return [human.targetBotId];
  const mentions = parseMentions(human.text || '', bots);
  return mentions.length && !mentions.includes('all') ? mentions : null;
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
  const visible = message => isTranscriptMessage(message, bot) &&
    (!bot || !audienceFor(message, messages, bots) || audienceFor(message, messages, bots).includes(bot.id));
  const eligible = messages.slice(0, anchor).filter(visible);
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
  let selected = history.slice(start);
  if (roundId != null && bot) {
    const latest = eligible.findLast(message => message.authorType === 'bot' && message.authorId === bot.id);
    if (latest && ['error', 'aborted'].includes(latest.status)) {
      // Recovery is explicit new work. Keep the original task and unfinished
      // result even when normal history is disabled; never replay side effects.
      const recovery = new Set([latest.roundId, ...selected.map(message => message.id), ...eligible.slice(0, eligible.indexOf(latest) + 1)
        .filter(message => message.roundId === latest.roundId).map(message => message.id)]);
      selected = eligible.filter(message => recovery.has(message.id));
      historyTokens = selected.reduce((total, message) => total + estimateTokens(buildMessagesText([message], bots) + '\n'), 0);
    }
  }
  let current = messages.slice(anchor).filter(visible);
  // Superseding a failed attempt does not undo its side effects. Recover only
  // its visible failure chain, never superseded successful answers or other bots.
  const recovered = new Set([...selected, ...current]);
  const byId = new Map(messages.map(message => [message.id, message]));
  for (let attempt of [...selected, ...current]) {
    while (attempt.authorType === 'bot' && incomplete(attempt) && attempt.roundId && attempt.supersedes) {
      const previous = byId.get(attempt.supersedes);
      if (!previous || recovered.has(previous) || previous.authorType !== 'bot' || previous.authorId !== attempt.authorId ||
          previous.roundId !== attempt.roundId || previous.supersededBy !== attempt.id || !incomplete(previous) ||
          !visible({ ...previous, supersededBy: undefined })) break;
      recovered.add(previous);
      attempt = previous;
    }
  }
  selected = messages.slice(0, anchor).filter(message => recovered.has(message));
  current = messages.slice(anchor).filter(message => recovered.has(message));
  historyTokens = selected.reduce((total, message) => total + estimateTokens(buildMessagesText([message], bots) + '\n'), 0);
  return { messages: [...selected, ...current], historyMessages: selected.length, currentMessages: current.length,
    historyTokenEstimate: historyTokens, omittedHistoryMessages: eligible.filter(message => !recovered.has(message)).length, historyTokenBudget: budget };
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
  const questionTools = { codex: 'chorus_ask_user', claude: 'AskUserQuestion', kimi: 'AskUserQuestion' };
  parts.push(questionTools[bot.cliType]
    ? `【用户交互】需要用户选择或补充信息时调用 ${questionTools[bot.cliType]}，以实际工具返回的回答继续；普通文字不会生成提问卡片。`
    : '【用户交互】此 CLI 接入使用文字问答；需要信息时直接在回复中提出问题，等待下一条消息。');
  const latestHuman = slice.findLast(message => message.authorType === 'human');
  if (latestHuman && audienceFor(latestHuman, slice, bots)) parts.push('【接收范围】本轮仅发送给用户点名的成员；回复中的点名不会自动扩大接收范围。');

  for (const sk of skillBlocks) {
    if (sk.mode === 'unavailable') {
      parts.push(`【技能引用不可用：${sk.name}】${sk.reason}。本次未提供此技能，不得假称已调用；说明限制后继续能完成的请求。`);
      continue;
    }
    if (sk.mode === 'reference' && sk.category === 'other' && !sk.nativeCliType) {
      parts.push(`【本次引用共享技能：${sk.name}】房主已显式选择此技能，先用文件读取工具按当前权限读取来源文件：${sk.skillFile}，再按原文完成任务。` +
        '此引用直接按文件路径使用，无需先安装或出现在原生技能列表中；原生技能命令不识别此名称时仍按上述路径读取。' +
        '文中的相对资源路径以此来源文件所在目录为基准，项目操作仍使用本轮工作目录。' +
        '若原生权限要求审批，提交审批请求；若来源不可读或依赖不受当前宿主支持，说明实际限制，不得假称完成。');
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

module.exports = { labelOf, buildPrompt, isTranscriptMessage, selectTranscript, audienceFor };
