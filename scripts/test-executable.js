'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '../src/main/adapters/resolveExecutable.js'), 'utf8');

function resolver(platform, env = {}) {
  const module = { exports: {} };
  vm.runInNewContext(source, { require: require('node:module').createRequire(path.join(__dirname, '../src/main/adapters/resolveExecutable.js')), module, process: { platform, env } });
  return module.exports.resolveExecutable;
}

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-room-executable-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const entry = path.join(directory, 'node_modules', '@example', 'cli', 'main.js');
  fs.mkdirSync(path.dirname(entry), { recursive: true });
  fs.writeFileSync(entry, 'console.log(JSON.stringify(process.argv.slice(2)));');
  return { directory, entry, resolve: resolver('win32', { Path: directory }) };
}

function shim(entry = 'node_modules\\@example\\cli\\main.js') {
  return [
    '@ECHO off', 'GOTO start', ':find_dp0', 'SET dp0=%~dp0', 'EXIT /b', ':start',
    'SETLOCAL', 'CALL :find_dp0', '', 'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"', ') ELSE (', '  SET "_prog=node"',
    '  SET PATHEXT=%PATHEXT:;.JS;=;%', ')', '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${entry}" %*`, '',
  ].join('\r\n');
}

const windows = { skip: process.platform !== 'win32' };

test('non-Windows leaves the executable untouched for shell:false spawning', () => {
  const resolve = resolver('linux');
  for (const command of ['pi', '/opt/CLI folder/pi', 'name;not-a-shell-command']) {
    const result = resolve(command);
    assert.equal(result.command, command);
    assert.equal(result.argsPrefix.length, 0);
  }
});

test('invalid inputs are rejected on every platform', () => {
  for (const platform of ['linux', 'win32']) {
    for (const command of [null, undefined, 7, '', 'pi\0.exe', 'pi\r\nother']) {
      assert.throws(() => resolver(platform)(command), /CLI/);
    }
  }
});

test('Windows resolves absolute native EXE and PATH names without a shell', windows, (t) => {
  const { directory, resolve } = fixture(t);
  const executable = path.join(directory, 'cli.exe');
  fs.writeFileSync(executable, 'fixture');
  for (const command of [executable, 'cli', 'cli.exe']) {
    const result = resolve(command);
    assert.equal(result.command, executable);
    assert.equal(result.argsPrefix.length, 0);
  }
});

test('Windows resolves a standard npm shim with adjacent node.exe and BOM/CRLF', windows, (t) => {
  const { directory, entry, resolve } = fixture(t);
  fs.writeFileSync(path.join(directory, 'pi.cmd'), '\uFEFF' + shim());
  const node = path.join(directory, 'node.exe');
  fs.writeFileSync(node, 'fixture');
  for (const command of ['pi', path.join(directory, 'pi.cmd')]) {
    const result = resolve(command);
    assert.equal(result.command, node);
    assert.equal(result.argsPrefix.length, 1);
    assert.equal(result.argsPrefix[0], entry);
  }
});

test('Windows falls back to PATH node.exe and preserves metacharacters as argv', windows, (t) => {
  const { directory, entry } = fixture(t);
  fs.writeFileSync(path.join(directory, 'pi.cmd'), shim());
  const resolve = resolver('win32', { PATH: `"${directory}";${path.dirname(process.execPath)}` });
  const result = resolve('pi');
  assert.equal(result.command.toLowerCase(), process.execPath.toLowerCase());
  assert.equal(result.argsPrefix[0], entry);
  const prompt = '中文 "quotes" & echo PWNED | more <input> %PATH% !test! ^ $(danger)\nnext';
  const child = spawnSync(result.command, [...result.argsPrefix, prompt], { shell: false, encoding: 'utf8', windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), [prompt]);
});

test('Windows rejects arbitrary batch files and modified shim programs', windows, (t) => {
  const { directory, resolve } = fixture(t);
  const filename = path.join(directory, 'pi.cmd');
  for (const content of [
    '@echo off\r\nnode "entry.js" %*',
    shim() + 'echo unexpected\r\n',
    'echo unexpected\r\n' + shim(),
    shim().replace('SET "_prog=node"', 'SET "_prog=cmd.exe"'),
    shim().replace('%*', '%* & echo unexpected'),
    shim().replace('SETLOCAL', 'SETLOCAL & echo unexpected'),
  ]) {
    fs.writeFileSync(filename, content);
    assert.throws(() => resolve(filename), /不支持此 CLI CMD/);
  }
  fs.writeFileSync(path.join(directory, 'pi.bat'), shim());
  assert.throws(() => resolve('pi.bat'), /BAT/);
});

test('Windows rejects path traversal, substituted variables and unsafe entry names in shims', windows, (t) => {
  const { directory, resolve } = fixture(t);
  for (const entry of ['..\\outside.js', '\\absolute.js', 'node_modules\\%ENTRY%.js', 'a&b.js', 'a"b.js', 'C:\\entry.js']) {
    fs.writeFileSync(path.join(directory, 'pi.cmd'), shim(entry));
    assert.throws(() => resolve('pi'), /不支持此 CLI CMD/);
  }
});

test('Windows rejects argument strings, relative paths and unsupported extensions', windows, (t) => {
  const { resolve } = fixture(t);
  for (const command of ['pi -p hi', 'pi&echo', '.\\pi.cmd', '..\\pi.exe', 'pi.ps1', 'pi.js', 'C:pi.exe']) {
    assert.throws(() => resolve(command), /CLI/);
  }
});

test('Windows reports missing executable, missing JS entry and missing node separately', windows, (t) => {
  const { directory, entry, resolve } = fixture(t);
  assert.throws(() => resolve('missing'), /未找到 CLI/);
  fs.writeFileSync(path.join(directory, 'pi.cmd'), shim());
  assert.throws(() => resolve('pi'), /需要 node.exe/);
  fs.unlinkSync(entry);
  assert.throws(() => resolve('pi'), /JavaScript 入口不存在/);
});

test('Windows bounds shim size and does not fall through an unknown first PATH wrapper', windows, (t) => {
  const { directory, resolve } = fixture(t);
  fs.writeFileSync(path.join(directory, 'pi.cmd'), 'x'.repeat(65537));
  assert.throws(() => resolve('pi'), /大小/);
  const other = path.join(directory, 'later');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, 'pi.exe'), 'fixture');
  fs.writeFileSync(path.join(directory, 'pi.cmd'), 'echo unknown');
  assert.throws(() => resolver('win32', { PATH: `${directory};${other}` })('pi'), /不支持此 CLI CMD/);
});
