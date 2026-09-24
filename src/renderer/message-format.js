'use strict';

// Small Markdown subset: all literals escaped, no raw HTML or remote images.
function formatMessage(text) {
  const raw = String(text || '');
  const names = [...new Set(state.bots.map((bot) => bot.name).concat(['全体', 'all']))]
    .filter(Boolean).sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const mention = new RegExp(`(^|\\s)@(?:${names.join('|')})(?=$|[\\s，。,.!?！？、；：:"“”‘’()（）<>\\[\\]【】])`, 'gi');
  const literal = (value, offset, highlight = true) => {
    let html = '', cursor = 0;
    if (highlight) {
      mention.lastIndex = 0;
      let match;
      while ((match = mention.exec(value))) {
        // A Markdown segment is not itself a mention boundary in the source.
        if (match.index === 0 && !match[1] && offset > 0 && !/\s/.test(raw[offset - 1])) continue;
        html += esc(value.slice(cursor, match.index)) + esc(match[1]) +
          '<span class="at">' + esc(match[0].slice(match[1].length)) + '</span>';
        cursor = match.index + match[0].length;
      }
    }
    html += esc(value.slice(cursor));
    return `<span data-source-start="${offset}">${html}</span>`;
  };
  const inline = (source, offset) => {
    const pattern = /`([^`\n]+)`|\*\*([^*\n]+)\*\*/g;
    let result = '', cursor = 0, match;
    while ((match = pattern.exec(source))) {
      result += literal(source.slice(cursor, match.index), offset + cursor);
      const tag = match[1] ? 'code' : 'strong', trim = match[1] ? 1 : 2;
      result += `<${tag}>${literal(match[1] || match[2], offset + match.index + trim, tag !== 'code')}</${tag}>`;
      cursor = match.index + match[0].length;
    }
    return result + literal(source.slice(cursor), offset + cursor);
  };
  const result = []; let code = null, list = null, offset = 0;
  const closeList = () => { if (list) result.push(`</${list}>`); list = null; };
  for (const line of raw.split('\n')) {
    const lineStart = offset; offset += line.length + 1;
    if (/^\s*```/.test(line)) {
      closeList();
      if (code) { result.push('<pre><code>' + code.join('') + '</code></pre>'); code = null; }
      else code = [];
      continue;
    }
    if (code) { code.push(literal(line + '\n', lineStart, false)); continue; }
    const bullet = line.match(/^\s*(?:([-*])\s+|\d+[.)]\s+)(.*)$/);
    if (bullet) {
      const kind = bullet[1] ? 'ul' : 'ol';
      if (list !== kind) { closeList(); list = kind; result.push(`<${kind}>`); }
      result.push('<li>' + inline(bullet[2], lineStart + line.length - bullet[2].length) + '</li>'); continue;
    }
    closeList();
    const heading = line.match(/^#{1,4}\s+(.+)$/);
    result.push(heading ? '<p class="message-heading">' + inline(heading[1], lineStart + line.length - heading[1].length) + '</p>' : inline(line + '\n', lineStart));
  }
  closeList();
  if (code) result.push('<pre><code>' + code.join('') + '</code></pre>');
  return result.join('');
}
