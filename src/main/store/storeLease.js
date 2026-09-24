'use strict';
const I18n = require('../../shared/i18n');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function acquireStoreLease(directory, { recoverStale = false } = {}) {
  fs.mkdirSync(directory, { recursive: true });
  const root = fs.realpathSync(directory);
  const file = path.join(root, '.convoke-store-lock');
  const owner = { pid: process.pid, nonce: crypto.randomUUID() };
  // Publish complete contents atomically; a crash before link leaves only an
  // unreferenced staging file, never an empty lock that cannot be recovered.
  const temporary = path.join(root, '.convoke-lock-owner-' + owner.nonce);
  const fd = fs.openSync(temporary, 'wx');
  try { fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); }
  catch (error) { fs.closeSync(fd); fs.unlinkSync(temporary); throw error; }
  fs.closeSync(fd);
  try {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.linkSync(temporary, file);
      const release = () => {
        try { if (fs.readFileSync(file, 'utf8') === JSON.stringify(owner)) fs.unlinkSync(file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      };
      return { root, release };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous, bytes;
      try { bytes = fs.readFileSync(file, 'utf8'); previous = JSON.parse(bytes); } catch { throw new Error(I18n.t('数据目录正在初始化或锁需检查，请稍后重试')); }
      if (!Number.isSafeInteger(previous.pid) || previous.pid < 1) throw new Error(I18n.t('数据锁格式无效，请检查备份后处理'));
      try { process.kill(previous.pid, 0); throw new Error(I18n.t('数据目录正在使用，请先关闭应用或等待迁移完成')); }
      catch (live) {
        if (live.code !== 'ESRCH') throw live;
        if (!recoverStale) throw new Error(I18n.t('源数据有遗留锁，请先从该数据目录启动并正常退出 Chorus 后再迁移'));
        if (fs.readFileSync(file, 'utf8') !== bytes) throw new Error(I18n.t('数据锁已变化，请重试'));
        // Only the caller holding the Electron singleton for this exact
        // realpath may recover. Other callers must never move an existing lock.
        fs.renameSync(file, file + '.stale-' + crypto.randomUUID());
      }
    }
  }
  throw new Error(I18n.t('未能取得数据目录的独占访问'));
  } finally { fs.unlinkSync(temporary); }
}
module.exports = { acquireStoreLease };
