'use strict';
const I18n = require('../../shared/i18n');

const { spawn } = require('node:child_process');
const { terminateTree } = require('./processTree');
const { StringDecoder } = require('node:string_decoder');
const { safeText } = require('./activities');
const { locateCliExecutable } = require('../cliDiscovery');

// Only fixed launcher arguments enter the shell. Protocol data uses stdin.
class CodexRpc {
  constructor({ cwd, spawnProcess = spawn, timeoutMs = 30000, cliSettings = {} } = {}) {
    this.spawnProcess = spawnProcess;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
    this.listeners = new Set();
    this.timeoutMs = timeoutMs;
    const launcher = locateCliExecutable('codex', cliSettings) || 'codex';
    if (/[&|<>^%!"\x00-\x1f\x7f]/.test(launcher)) throw new Error(I18n.t('Codex 启动路径包含不支持的字符'));
    this.child = spawnProcess(process.platform === 'win32' && /[\s()]/.test(launcher) ? `"${launcher}"` : launcher, ['app-server', '--stdio'], {
      cwd, shell: process.platform === 'win32', windowsHide: true, detached: process.platform !== 'win32',
      env: process.env, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    this.processExited = false;
    const parseLine = line => { try { this.receive(JSON.parse(line.replace(/^\uFEFF/, ''))); } catch (_) { /* non-protocol diagnostics */ } };
    const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', chunk => {
      if (this.closed) return;
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        this.transportError(new Error(I18n.t('Codex 协议输出超过大小上限'))); this.close(); return;
      }
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        parseLine(line);
      }
    });
    // Native diagnostics can contain provider data. Expose only protocol errors.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', error => this.transportError(error));
    this.child.on('error', error => this.transportError(error));
    this.child.on('close', code => {
      if (this.processExited) return;
      this.processExited = true;
      if (!this.closed && code === 0) { buffer += decoder.end(); if (buffer.trim()) parseLine(buffer); }
      this.closed = true;
      this.fail(new Error(I18n.t('Codex 连接已结束')));
      this.publish({ method: 'transport/closed', params: {} });
    });
  }

  publish(message) {
    for (const listener of this.listeners) {
      try { listener(message); } catch (_) { /* consumers cannot break transport */ }
    }
  }
  onMessage(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (message.id != null && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(safeText(message.error.message || I18n.t('Codex 请求失败'))));
      else pending.resolve(message.result);
      return;
    }
    this.publish(message);
  }
  write(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error(I18n.t('Codex 连接不可用'));
    const line = JSON.stringify(message);
    if (Buffer.byteLength(line) > 4 * 1024 * 1024) throw new Error(I18n.t('Codex 请求超过大小上限'));
    this.child.stdin.write(line + '\n');
  }
  request(method, params = {}, timeoutMs = this.timeoutMs) {
    if (this.pending.size >= 32) return Promise.reject(new Error(I18n.t('Codex 待处理请求过多')));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id); reject(new Error(I18n.tpl`Codex 请求超时：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async initialize() {
    const result = await this.request('initialize', {
      clientInfo: { name: 'chorus', title: 'Chorus', version: require('../../../package.json').version },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized' });
    return result;
  }
  respond(id, result) { this.write({ id, result }); }
  reject(id, message) { this.write({ id, error: { code: -32601, message } }); }
  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
  transportError(error) {
    if (this.closed) return;
    const safeError = new Error(safeText(error && error.message || I18n.t('Codex 连接失败')));
    this.fail(safeError);
    this.publish({ method: 'transport/error', params: { message: safeError.message } });
    void this.close();
  }
  async close() {
    if (this.closing) return this.closing;
    // Mark closed before terminating: late bytes cannot complete pending work.
    const alreadyExited = this.processExited;
    this.closed = true;
    this.fail(new Error(I18n.t('Codex 连接已关闭')));
    this.closing = (async () => {
      const result = !alreadyExited ? await terminateTree(this.child.pid, { spawnProcess: this.spawnProcess,
        platform: process.platform, killProcess: (pid, signal) => {
          if (pid === this.child.pid) this.child.kill(signal); else process.kill(pid, signal);
        } }) : { scope: 'none' };
      this.child.stdin.destroy();
      return result;
    })();
    return this.closing;
  }
}

module.exports = { CodexRpc };
