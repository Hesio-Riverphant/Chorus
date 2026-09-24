'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = vm.createContext({ state: { bots: [{ name: '审查者' }, { name: 'a' }, { name: '<agent>' }] },
  esc: (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/message-format.js'), 'utf8'), context);
const render = (text) => context.formatMessage(text);

test('real mentions are highlighted with boundaries; email and unknown names stay literal', () => {
  const html = render('@审查者，处理\n@all @全体 @a。 user@a @apple @unknown');
  assert.equal((html.match(/class="at"/g) || []).length, 4);
  assert.match(html, /<span class="at">@审查者<\/span>，/);
  assert.match(html, /user@a @apple @unknown/);
});

test('code and code fences never gain mention highlighting', () => {
  const html = render('`@审查者`\n```\n@all\n```\n@审查者');
  assert.equal((html.match(/class="at"/g) || []).length, 1);
  assert.doesNotMatch(html.match(/<pre>[\s\S]*?<\/pre>/)[0], /class="at"/);
});

test('nested mention markup preserves source starts and newline text', () => {
  const html = render('@审查者 重复\n@审查者 重复');
  assert.match(html, /data-source-start="8"/);
  assert.doesNotMatch(html, /<br/);
  assert.equal(html.replace(/<[^>]*>/g, ''), '@审查者 重复\n@审查者 重复\n');
});

test('untrusted input and bot names are escaped before generating markup', () => {
  const html = render('@<agent> <img src=x onerror=alert(1)> **<script>**');
  assert.doesNotMatch(html, /<img|<script/);
  assert.match(html, /<span class="at">@&lt;agent&gt;<\/span>/);
  assert.match(html, /&lt;img/);
});

test('splitting inline markdown does not manufacture an at-sign boundary', () => {
  assert.doesNotMatch(render('x`code`@a **@a**'), /class="at"/);
});
