'use strict';
const { StringDecoder } = require('node:string_decoder');
const { safeText } = require('./activities');
const I18n = require('../../shared/i18n');

// Retain the whole bounded diagnostic before redaction. Keeping only a raw
// tail can drop the credential's label and expose its remaining value.
function createDiagnostics(limit = 16000) {
  const decoder = new StringDecoder('utf8');
  let raw = '', overflow = false;
  return {
    push(chunk) {
      if (overflow) return;
      const text = decoder.write(chunk);
      if (raw.length + text.length > limit) { overflow = true; raw = ''; }
      else raw += text;
    },
    text() { return overflow ? I18n.t('原生错误输出超过大小上限，已省略') : safeText(raw.replace(/^\uFEFF/, ''), limit); },
  };
}
module.exports = { createDiagnostics };
