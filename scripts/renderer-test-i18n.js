'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Load the same translation boundaries as the browser into isolated DOM fixtures.
module.exports = function loadI18n(context) {
  context.document ||= {};
  context.document.addEventListener ||= () => {};
  for (const relative of ['shared/i18n-catalog.js', 'shared/i18n-main-catalog.js', 'shared/i18n.js', 'renderer/i18n-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', relative), 'utf8'), context);
  }
};
