"use strict";
const I18n = require("../../shared/i18n");

const path = require('node:path');
const fs = require('node:fs/promises');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const { publicText } = require('../../shared/messageContent');
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;

// File reads and JSON parsing stay off Electron's main thread. Only a bounded
// result set crosses back; each superseding query terminates the prior worker.
function searchArchives(dataPath, rooms, query, { limit = 100, signal, maxArchiveBytes = MAX_ARCHIVE_BYTES } = {}) {
  if (typeof query !== 'string' || query.length > 2000) return Promise.reject(new Error(I18n.t('搜索内容须少于 2000 字')));
  if (!query.trim()) return Promise.resolve({ hits: [], warnings: [] });
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { const error = new Error(I18n.t('搜索已取消')); error.name = 'AbortError'; reject(error); return; }
    const worker = new Worker(__filename, { workerData: { language: I18n.language, dataPath, rooms: rooms.map(({ id, name }) => ({ id, name })),
      query, limit: Math.min(100, Math.max(1, limit)), maxArchiveBytes }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    let settled = false;
    const done = (error, value) => {
      if (settled) return;
      settled = true; signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      worker.terminate().then(() => { const error = new Error(I18n.t('搜索已取消')); error.name = 'AbortError'; done(error); }, done);
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.once('message', value => done(null, value));
    worker.once('error', done);
    worker.once('exit', code => {
      if (!settled && !signal?.aborted) done(new Error(I18n.tpl`归档搜索进程意外结束（${code}）`));
    });
  });
}

async function scan({ dataPath, rooms, query, limit, maxArchiveBytes, language }) {
  if (language) I18n.setLanguage(language);
  const needle = query.trim().toLocaleLowerCase(), hits = [], warnings = [];
  let warningCount = 0;
  const warn = message => { warningCount++; if (warnings.length < 20) warnings.push(message); };
  const record = item => item !== null && typeof item === 'object' && !Array.isArray(item);
  for (const room of rooms) {
    let directory;
    try { directory = await fs.opendir(path.join(dataPath, 'archives', room.id)); }
    catch (error) { if (error.code !== 'ENOENT') warn(I18n.tpl`${room.name}：无法读取聊天归档目录`); continue; }
    try {
      for await (const entry of directory) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const file = path.join(dataPath, 'archives', room.id, entry.name);
        let handle;
        try {
          handle = await fs.open(file, 'r');
          if ((await handle.stat()).size > maxArchiveBytes) {
            warn(I18n.tpl`${room.name} / ${entry.name}：归档超过 ${Math.round(maxArchiveBytes / 1024 / 1024)} MiB，未搜索此文件`); continue;
          }
          const source = await handle.readFile('utf8');
          if (Buffer.byteLength(source) > maxArchiveBytes) { warn(I18n.tpl`${room.name} / ${entry.name}：读取期间归档超出大小限制，未搜索此文件`); continue; }
          const archive = JSON.parse(source);
          if (!record(archive) || typeof archive.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(archive.id) || `${archive.id}.json` !== entry.name ||
            !Array.isArray(archive.messages) || !archive.messages.every(message => record(message) && typeof message.id === 'string' && message.id.length)) throw new Error('invalid archive');
          for (const message of archive.messages) {
            const text = publicText(message), index = text.toLocaleLowerCase().indexOf(needle);
            if (index < 0) continue;
            const hit = { roomId: room.id, roomName: room.name, archiveId: archive.id, messageId: message.id,
              createdAt: Number.isFinite(message.createdAt) ? message.createdAt : 0,
              excerpt: (index > 35 ? '…' : '') + text.slice(Math.max(0, index - 35), index + needle.length + 90) };
            const position = hits.findIndex(existing => existing.createdAt < hit.createdAt);
            if (position >= 0) hits.splice(position, 0, hit);
            else if (hits.length < limit) hits.push(hit);
            if (hits.length > limit) hits.pop();
          }
        } catch (error) {
          // Files can disappear when a room/archive is deleted during a scan.
          if (error.code !== 'ENOENT') warn(I18n.tpl`${room.name} / ${entry.name}：归档损坏或无法读取，已保留原文件`);
        } finally { await handle?.close(); }
      }
    } catch { warn(I18n.tpl`${room.name}：归档目录扫描未完成`); }
  }
  if (warningCount > warnings.length) warnings.push(I18n.tpl`另有 ${warningCount - warnings.length} 个归档读取问题`);
  return { hits, warnings };
}

if (!isMainThread) scan(workerData).then(result => parentPort.postMessage(result));
module.exports = { searchArchives, MAX_ARCHIVE_BYTES };
