'use strict';
const I18n = require('../../shared/i18n');

const fs = require('fs');
const path = require('path');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback) {
  try {
    // Strip a UTF-8 BOM: Windows editors (Notepad, PowerShell Out-File utf8)
    // add one, and JSON.parse throws on it, which would otherwise make us
    // wrongly fall back to empty data and drop rooms/bots.
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // Never turn corruption/permission failures into empty data which the next
    // save would overwrite. Avoid JSON.parse's error text: it can quote data.
    const error = new Error(I18n.tpl`无法读取 JSON 文件：${file}（${err.code || 'JSON_INVALID'}）`);
    error.code = err.code || 'JSON_INVALID';
    throw error;
  }
}

// Atomic write: write to a temp file then rename (prevents torn files on crash).
function writeJsonAtomic(file, obj) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let fd;
  let created = false;
  let failure;
  try {
    fd = fs.openSync(tmp, 'wx');
    created = true;
    fs.writeFileSync(fd, JSON.stringify(obj, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    // Only remove the temp file owned by this call; preserve the destination.
    if (created) {
      try { fs.unlinkSync(tmp); }
      catch (err) { if (err.code !== 'ENOENT' && !failure) throw err; }
    }
  }
}

// Append-only newline-delimited event log.
function appendLine(file, entry) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

module.exports = { ensureDir, readJson, writeJsonAtomic, appendLine };
