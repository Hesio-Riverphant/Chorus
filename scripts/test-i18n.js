'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const I18n = require('../src/shared/i18n');

test('language catalog translates only explicitly owned literals and preserves interpolated content', () => {
  I18n.setLanguage('en');
  assert.equal(I18n.t('保存'), 'Save');
  assert.equal(I18n.tpl`成员 · ${'设置 发送 <中文>'}`, 'Members · 设置 发送 <中文>');
  assert.equal(I18n.parts(['归档房间「', '」？成员、设置与聊天记录都会保留，可从历史恢复。'], ['中文房间']),
    'Archive room "中文房间"? Members, settings and messages will be kept and can be restored from history.');
  I18n.setLanguage('zh-CN');
  assert.equal(I18n.tpl`成员 · ${'Settings'}`, '成员 · Settings');
});

test('catalog supports independent Node consumers and falls back to the source for unknown text', () => {
  I18n.setLanguage('en');
  assert.equal(require('../src/renderer/conversation-ui').timing({ roundRun: { startedAt: 1000, endedAt: 62000, status: 'done' } }).label.includes('Elapsed'), true);
  assert.equal(I18n.t('未经登记的外部文本'), '未经登记的外部文本');
  assert.equal(I18n.normalize('invalid'), 'zh-CN');
  I18n.setLanguage('zh-CN');
});

test('explicit live bindings keep newer native status unchanged', () => {
  const context = { I18n: { ...I18n }, document: { querySelectorAll: () => [], documentElement: {}, addEventListener() {} }, WeakRef, FinalizationRegistry };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/i18n-ui.js'), 'utf8'), context);
  const item = { isConnected: true, textContent: '' };
  context.I18n.write(item, () => context.I18n.t('正在启动终端…'));
  item.textContent = 'D:\\中文项目';
  I18n.setLanguage('en');
  assert.equal(item.textContent, 'D:\\中文项目');
  I18n.setLanguage('zh-CN');
});

test('HTML localization keeps model names and escaped message values outside translation', () => {
  I18n.setLanguage('en');
  const context = { I18n: { ...I18n }, document: { querySelectorAll: () => [], documentElement: {}, addEventListener() {} }, WeakRef, FinalizationRegistry };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/i18n-ui.js'), 'utf8'), context);
  const html = context.I18n.html(['<label>模型</label><span>', '</span>'], '设置 &lt;中文&gt;');
  assert.match(html, />Model<\/span>/);
  assert.match(html, /<span>设置 &lt;中文&gt;<\/span>/);
  assert.match(context.I18n.t('<option value="default">默认</option>'), /<option value="default" data-i18n="默认">Default<\/option>/);
  I18n.setLanguage('zh-CN');
});
