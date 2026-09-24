'use strict';
const I18n = require('../../shared/i18n');

const fs = require('node:fs');
const path = require('node:path');

const MAX_SESSIONS = 8;
const HIGH_WATER = 256 * 1024;
const LOW_WATER = 64 * 1024;
const MAX_INPUT = 64 * 1024;

function dimensions(value) {
  return { cols: Math.max(10, Math.min(500, Math.floor(Number(value.cols) || 80))),
    rows: Math.max(2, Math.min(200, Math.floor(Number(value.rows) || 24))) };
}

function shellSpec() {
  if (process.platform !== 'win32') return { executable: process.env.SHELL || '/bin/sh', args: ['-l'], name: I18n.t('终端') };
  const pwsh = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  if (fs.existsSync(pwsh)) return { executable: pwsh, args: ['-NoLogo'], name: 'PowerShell' };
  return { executable: path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo'], name: 'PowerShell' };
}

class TerminalService {
  constructor({ emit, ptyModule } = {}) {
    this.emit = emit;
    this.ptyModule = ptyModule;
    this.sessions = new Map();
  }

  create({ id, roomId, cwd, cols, rows }) {
    if (typeof id !== 'string' || !/^[\w-]{1,80}$/.test(id) || this.sessions.has(id)) throw new Error(I18n.t('终端标识无效'));
    if (this.sessions.size >= MAX_SESSIONS) throw new Error(I18n.t('最多同时打开 8 个终端，请先关闭一个终端'));
    const pty = this.ptyModule || require('node-pty');
    const shell = shellSpec();
    const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
    delete env.ELECTRON_RUN_AS_NODE;
    const processHandle = pty.spawn(shell.executable, shell.args, { ...dimensions({ cols, rows }), cwd, env,
      name: 'xterm-256color', useConpty: true, useConptyDll: process.platform === 'win32' });
    const session = { id, roomId, cwd, process: processHandle, ready: false, pending: '', outstanding: 0, paused: false, exited: false };
    this.sessions.set(id, session);
    session.dataListener = processHandle.onData(data => {
      if (!this.sessions.has(id)) return;
      if (!session.ready) {
        session.pending += data;
        if (session.pending.length > HIGH_WATER && !session.paused) { session.paused = true; processHandle.pause(); }
      } else this.output(session, data);
    });
    session.exitListener = processHandle.onExit(({ exitCode, signal }) => {
      session.exited = true;
      session.exit = { kind: 'terminal-exit', id, exitCode, signal };
      if (session.ready) this.emit(session.exit);
    });
    return { id, name: shell.name, cwd, pid: processHandle.pid };
  }

  output(session, data) {
    for (let index = 0; index < data.length; index += MAX_INPUT) {
      const chunk = data.slice(index, index + MAX_INPUT);
      session.outstanding += chunk.length;
      this.emit({ kind: 'terminal-data', id: session.id, data: chunk });
    }
    if (session.outstanding > HIGH_WATER && !session.paused && !session.exited) {
      session.paused = true; session.process.pause();
    }
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) throw new Error(I18n.t('终端已关闭'));
    return session;
  }

  ready(id) {
    const session = this.get(id);
    if (session.ready) return;
    session.ready = true;
    const pending = session.pending; session.pending = '';
    if (pending) this.output(session, pending);
    if (session.exit) this.emit(session.exit);
  }

  acknowledge(id, length) {
    const session = this.sessions.get(id); if (!session) return;
    if (!Number.isInteger(length) || length < 0 || length > MAX_INPUT) throw new Error(I18n.t('终端流量确认无效'));
    session.outstanding = Math.max(0, session.outstanding - length);
    if (session.paused && session.outstanding < LOW_WATER && !session.exited) {
      session.paused = false; session.process.resume();
    }
  }

  write(id, data) {
    const session = this.get(id);
    if (session.exited) throw new Error(I18n.t('此终端进程已退出，请新建终端'));
    if (typeof data !== 'string' || data.length > MAX_INPUT) throw new Error(I18n.t('终端输入过长'));
    session.process.write(data);
  }

  resize(id, size) {
    const session = this.get(id);
    if (!session.exited) session.process.resize(dimensions(size).cols, dimensions(size).rows);
  }

  close(id) {
    const session = this.sessions.get(id); if (!session) return;
    this.sessions.delete(id);
    session.dataListener?.dispose(); session.exitListener?.dispose();
    if (!session.exited) { try { session.process.kill(); } catch { /* Already exited between notification and close. */ } }
  }

  dispose() { for (const id of this.sessions.keys()) this.close(id); }
}

module.exports = { TerminalService, dimensions, shellSpec, MAX_SESSIONS };
