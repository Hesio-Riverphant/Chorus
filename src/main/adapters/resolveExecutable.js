'use strict';
const I18n = require('../../shared/i18n');

const fs = require('node:fs');
const path = require('node:path');

function isFile(filename) {
  try { return fs.statSync(filename).isFile(); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
    throw error;
  }
}

function pathDirectories() {
  const key = Object.keys(process.env).find((name) => name.toUpperCase() === 'PATH');
  return (process.env[key] || '').split(';').map((item) => item.replace(/^"(.*)"$/, '$1'))
    .filter((item) => /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(item));
}

function findOnPath(name, extensions) {
  for (const directory of pathDirectories()) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function npmEntry(filename) {
  if (fs.statSync(filename).size > 65536) throw new Error(I18n.t('CLI CMD 文件超过支持的 npm shim 大小'));
  const lines = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)
    .map((line) => line.trim()).filter(Boolean);
  // Recognize the complete npm cmd-shim template. Never evaluate batch text,
  // and never accept an otherwise arbitrary batch file containing a node line.
  const template = [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b',
    ':start', 'SETLOCAL', 'CALL :find_dp0', 'IF EXIST "%dp0%\\node.exe" (',
    'SET "_prog=%dp0%\\node.exe"', ') ELSE (', 'SET "_prog=node"',
    'SET PATHEXT=%PATHEXT:;.JS;=;%', ')',
  ];
  const validPrefix = lines.length === template.length + 1 && template.every((line, index) =>
    lines[index].toLowerCase() === line.toLowerCase());
  const entry = validPrefix && lines[template.length].match(
    /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%"\s+"%dp0%\\([A-Za-z0-9_@. \\/-]+\.(?:js|cjs|mjs))" %\*$/i,
  );
  if (!entry || entry[1].split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) {
    throw new Error(I18n.t('不支持此 CLI CMD：只支持标准 npm Node.js shim；请指定原生 EXE 路径'));
  }
  return path.resolve(path.dirname(filename), entry[1]);
}

// Only the executable belongs here; callers must pass all arguments separately
// and spawn the returned command with shell:false (including on Windows).
function resolveExecutable(command) {
  if (typeof command !== 'string' || !command || /[\0\r\n]/.test(command)) {
    throw new Error(I18n.t('CLI 可执行文件必须是命令名或绝对路径'));
  }
  if (process.platform !== 'win32') return { command, argsPrefix: [] };

  const absolute = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+)/.test(command);
  if (!absolute && !/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(command)) {
    throw new Error(I18n.t('CLI 可执行文件必须是命令名或绝对路径，不能包含命令参数'));
  }
  const extension = path.extname(command).toLowerCase();
  if (extension && !['.exe', '.cmd', '.bat'].includes(extension)) {
    throw new Error(I18n.t('Windows CLI 仅支持原生 EXE 或标准 npm CMD shim'));
  }
  const extensions = extension ? [''] : ['.exe', '.cmd', '.bat'];
  const filename = absolute
    ? extensions.map((suffix) => command + suffix).find(isFile)
    : findOnPath(command, extensions);
  if (!filename) throw new Error(I18n.t('未找到 CLI 可执行文件；请检查命令名、PATH 或绝对路径'));
  if (path.extname(filename).toLowerCase() === '.exe') return { command: filename, argsPrefix: [] };
  if (path.extname(filename).toLowerCase() !== '.cmd') {
    throw new Error(I18n.t('不支持 BAT 包装器；请指定原生 EXE 或标准 npm CMD shim'));
  }

  const entry = npmEntry(filename);
  if (!isFile(entry)) throw new Error(I18n.t('npm CLI shim 指向的 JavaScript 入口不存在'));
  const adjacentNode = path.join(path.dirname(filename), 'node.exe');
  const node = isFile(adjacentNode) ? adjacentNode : findOnPath('node', ['.exe']);
  if (!node) throw new Error(I18n.t('npm CLI shim 需要 node.exe；请检查 Node.js 安装与 PATH'));
  return { command: node, argsPrefix: [entry] };
}

module.exports = { resolveExecutable };
