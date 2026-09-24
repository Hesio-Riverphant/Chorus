(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.Mention = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
'use strict';
const escapeRegExp = value => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Characters that may legally follow a mentioned name.
const NAME_END = '\\s，。,.!?！？、；：:"“”‘’()（）<>\\[\\]【】';
// Characters that may legally precede an "@".
const AT_START = '^|\\s';

// Parse @bot mentions and @all/@全体 from a text. Matches against provided bots.
// Returns an array of bot ids plus possibly the literal 'all'.
function parseMentions(text, bots) {
  const mentions = [];
  const src = String(text || '');

  if (new RegExp(`(${AT_START})@(all|全体)(?=$|[${NAME_END}])`, 'm').test(src)) {
    mentions.push('all');
  }

  // Match longer names first to reduce prefix collisions.
  const ordered = [...bots].sort((a, b) => b.name.length - a.name.length);
  for (const b of ordered) {
    const re = new RegExp(
      `(${AT_START})@${escapeRegExp(b.name)}(?=$|[${NAME_END}])`,
      'i',
    );
    if (re.test(src) && !mentions.includes(b.id)) mentions.push(b.id);
  }
  return mentions;
}

return { parseMentions };
});
