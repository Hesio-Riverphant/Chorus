(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MessageContent = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  // Public progress remains conversation content after transport phase splitting.
  // Hidden reasoning and tool payloads do not enter full-text conversation search.
  function progress(message) {
    return (message.activities || []).filter(activity => activity.phase === 'commentary')
      .map((activity, index) => ({ activity, index }))
      .sort((a, b) => (a.activity.order ?? a.index) - (b.activity.order ?? b.index))
      .map(({ activity }) => activity.detail || '').join('\n\n');
  }
  function publicText(message) { return [progress(message), message.text].filter(Boolean).join('\n\n'); }
  return { progress, publicText };
});
