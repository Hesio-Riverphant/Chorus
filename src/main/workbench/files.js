'use strict';
const I18n = require('../../shared/i18n');

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { projectPath, within } = require('./paths');
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function git(root, args) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
    delete env.GIT_EXTERNAL_DIFF;
    execFile('git', ['-c', 'core.quotepath=false', ...args], {
      cwd: root, env, windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error(error.killed ? I18n.t('Git 查询超时') : (stderr.trim() || error.message))); return; }
      resolve(stdout);
    });
  });
}

async function listFiles(root, relative = '.') {
  const directory = await projectPath(root, relative);
  if (!(await fs.stat(directory)).isDirectory()) throw new Error(I18n.t('请选择一个目录'));
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const visible = entries.filter(item => item.name !== '.git').sort((a, b) =>
    Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  return { path: path.relative(root, directory), cwd: root, truncated: visible.length > 1000,
    entries: visible.slice(0, 1000).map(item => ({ name: item.name, path: path.relative(root, path.join(directory, item.name)),
      directory: item.isDirectory(), link: item.isSymbolicLink() })) };
}

async function readFile(root, relative) {
  const target = await projectPath(root, relative);
  const stat = await fs.stat(target);
  if (!stat.isFile()) throw new Error(I18n.t('请选择一个文件'));
  if (stat.size > MAX_FILE_BYTES) throw new Error(I18n.t('文件超过 2 MB，请使用外部应用打开'));
  const handle = await fs.open(target, 'r');
  let bytes;
  try {
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const result = await handle.read(buffer, 0, buffer.length, 0);
    bytes = buffer.subarray(0, result.bytesRead);
    if (bytes.length > MAX_FILE_BYTES || (await handle.stat()).size > MAX_FILE_BYTES) throw new Error(I18n.t('文件超过 2 MB，请使用外部应用打开'));
  } finally { await handle.close(); }
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = bytes.subarray(2).toString('utf16le');
  else if (bytes.subarray(0, 8192).includes(0)) throw new Error(I18n.t('此文件为二进制文件，请使用外部应用打开'));
  else text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  return { path: path.relative(root, target), absolutePath: target, text, bytes: bytes.length };
}

async function changes(root) {
  const gitRoot = (await git(root, ['rev-parse', '--show-toplevel'])).trim();
  const output = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  const parts = output.split('\0'), entries = [];
  for (let index = 0; index < parts.length; index++) {
    if (!parts[index]) continue;
    const status = parts[index].slice(0, 2), relative = parts[index].slice(3);
    // -z prints destination first, then source for renamed/copied paths.
    const previous = /[RC]/.test(status) ? parts[++index] : undefined;
    const target = path.resolve(gitRoot, relative);
    if (!within(root, target)) continue;
    entries.push({ path: path.relative(root, target), status, previous: previous || null });
  }
  return { entries: entries.slice(0, 500), truncated: entries.length > 500, cwd: root };
}

async function diff(root, relative) {
  const target = await projectPath(root, relative, { allowMissing: true });
  const scoped = path.relative(root, target).split(path.sep).join('/');
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--src-prefix=a/', '--dst-prefix=b/'];
  let output;
  try {
    await git(root, ['rev-parse', '--verify', 'HEAD']);
    output = await git(root, [...args, 'HEAD', '--', `:(literal)${scoped}`]);
  } catch (error) {
    // An unborn repository has no HEAD. Staged additions and working-tree edits
    // still have meaningful changes and should remain reviewable.
    if (!/unknown revision|ambiguous argument|Needed a single revision|bad revision|not a valid|Not a valid/i.test(error.message)) throw error;
    output = await git(root, [...args, '--cached', '--', `:(literal)${scoped}`]);
    output += await git(root, [...args, '--', `:(literal)${scoped}`]);
  }
  if (!output) {
    const status = await git(root, ['status', '--porcelain=v1', '-z', '--', `:(literal)${scoped}`]);
    if (status.startsWith('??')) {
      const file = await readFile(root, relative);
      output = I18n.tpl`新文件 · ${file.path}\n${file.text.split('\n').map(line => `+${line}`).join('\n')}`;
    }
  }
  return { path: scoped, text: output || I18n.t('此文件当前没有未提交的差异。') };
}

module.exports = { listFiles, readFile, changes, diff, MAX_FILE_BYTES };
