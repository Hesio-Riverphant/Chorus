'use strict';
const I18n = require('../../shared/i18n');

const { emitActivity, nextActivityOrder } = require('./activities');
const MAX_TEXT = 4 * 1024 * 1024;

// Claude does not label commentary/final phases. A tool_use stop boundary is
// authoritative evidence that the preceding assistant message continues work.
// Everything else remains visible answer text, including interrupted streams.
function claudeText(event, acc, emit) {
  const stream = event.type === 'stream_event' ? event.event : null;
  if (stream?.type === 'message_start') {
    acc.claudeTextId = stream.message?.id;
    acc.claudeStreamBlock = null;
  }
  if (stream?.type === 'content_block_start') acc.claudeStreamBlock = {
    messageId: acc.claudeTextId, index: stream.index, type: stream.content_block?.type,
  };
  const id = event.type === 'assistant' ? event.message?.id : acc.claudeTextId;
  if (!id) { // Legacy/partial protocols without identities cannot be reclassified safely.
    if (stream?.delta?.type === 'text_delta') { acc.claudeUntrackedText = true; emit('text', stream.delta.text || ''); }
    return;
  }
  acc.claudeTexts ||= new Map();
  const get = index => {
    const key = `${id}:text:${index}`;
    if (!acc.claudeTexts.has(key)) acc.claudeTexts.set(key, { id: key, messageId: id, text: '', order: nextActivityOrder(acc), process: false });
    return acc.claudeTexts.get(key);
  };
  const replaceBody = () => emit('text_replace', [...acc.claudeTexts.values()].filter(item => !item.process).map(item => item.text).join(''));
  const progress = item => {
    emitActivity(acc, emit, { id: item.id, kind: 'reasoning', phase: 'commentary', name: I18n.t('进展'), status: 'done', detail: item.text, order: item.order });
    // A full activity list must not silently discard public output.
    item.process = acc.activities.some(activity => activity.id === item.id);
  };
  const append = (item, text) => {
    if (!text) return;
    if ((acc.claudeTextLength || 0) + text.length > MAX_TEXT) { emit('error', I18n.t('Claude 回复超过 4 MB，后续文本未接收')); return; }
    acc.claudeTextLength = (acc.claudeTextLength || 0) + text.length;
    item.text += text;
    if (item.process) progress(item); else emit('text', text);
  };
  if (stream?.type === 'content_block_start' && stream.content_block?.type === 'text') append(get(stream.index), stream.content_block.text || '');
  if (stream?.type === 'content_block_delta' && stream.delta?.type === 'text_delta') append(get(stream.index), stream.delta.text || '');
  if (event.type === 'assistant' && !acc.claudeUntrackedText && Array.isArray(event.message?.content)) {
    event.message.content.forEach((block, index) => {
      if (block.type !== 'text' || typeof block.text !== 'string') return;
      // Stream-json emits a one-block assistant envelope before block_stop.
      // Its array index is zero even when thinking occupies native index zero.
      const streamed = acc.claudeStreamBlock;
      const blockIndex = event.message.content.length === 1 && streamed?.messageId === id && streamed.type === 'text'
        ? streamed.index : index;
      const item = get(blockIndex);
      if (block.text.startsWith(item.text)) append(item, block.text.slice(item.text.length));
      else if (block.text !== item.text) emit('error', I18n.t('Claude 完整文本与流式文本不一致，已保留流式结果'));
    });
  }
  const toolBoundary = stream?.type === 'content_block_start' && stream.content_block?.type === 'tool_use' ||
    stream?.type === 'message_delta' && stream.delta?.stop_reason === 'tool_use' ||
    event.type === 'assistant' && (event.message?.stop_reason === 'tool_use' || event.message?.content?.some(block => block.type === 'tool_use'));
  if (toolBoundary && !acc.claudeUntrackedText) {
    for (const item of acc.claudeTexts.values()) if (item.messageId === id && item.text) progress(item);
    replaceBody();
  }
  const finalBoundary = stream?.type === 'message_delta' && stream.delta?.stop_reason === 'end_turn' ||
    event.type === 'assistant' && event.message?.stop_reason === 'end_turn';
  if (finalBoundary && acc.claudeFinalId !== id && [...acc.claudeTexts.values()].some(item => item.messageId === id && item.text && !item.process)) {
    acc.claudeFinalId = id; emit('final_answer', true);
  }
}

module.exports = { claudeText };
