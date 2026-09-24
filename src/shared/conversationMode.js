(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./mention').parseMentions);
  else root.ConversationMode = factory(root.Mention.parseMentions);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (parseMentions) {
  'use strict';
  function normalizeMode(value) {
    if (value == null) return undefined;
    if (!['chat', 'plan', 'goal'].includes(value)) throw new Error('会话模式无效');
    return value;
  }
  function resolveModeTargets({ mode, text, bots, room }) {
    normalizeMode(mode);
    const mentions = parseMentions(text, bots);
    bots = bots.filter(bot => bot.enabled !== false);
    let targets, via;
    if (mentions.includes('all')) { targets = bots; via = 'all'; }
    else if (mentions.length) { targets = bots.filter(bot => mentions.includes(bot.id)); via = 'mention'; }
    else if (['plan', 'goal'].includes(mode)) {
      const moderator = bots.find(bot => bot.id === room.moderatorBotId) || bots[0];
      const ids = new Set(moderator ? [moderator.id] : []);
      if (mode === 'plan') for (const bot of bots) {
        if (['研究者', '研究员', 'researcher'].includes(String(bot.role || '').toLowerCase())) ids.add(bot.id);
      }
      targets = bots.filter(bot => ids.has(bot.id)); via = 'mode_default';
    } else if (room.routingMode === 'all') { targets = bots; via = 'routing_all'; }
    else { const moderator = bots.find(bot => bot.id === room.moderatorBotId) || bots[0]; targets = moderator ? [moderator] : []; via = 'moderator'; }
    return { targets: [...new Map(targets.map(bot => [bot.id, bot])).values()], mentions, via };
  }
  return { normalizeMode, resolveModeTargets };
});
