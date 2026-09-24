'use strict';
const I18n = require('../../shared/i18n');

const fs = require('node:fs/promises');
const path = require('node:path');

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function roomDirectory(persistence, roomId, fallback) {
  if (typeof roomId !== 'string' || !/^[\w-]+$/.test(roomId)) throw new Error(I18n.t('房间标识无效'));
  const room = persistence.listRooms().find(item => item.id === roomId);
  if (!room || room.archivedAt) throw new Error(I18n.t('请先选择可用的房间'));
  const configured = room.cwd || persistence.getSettings().defaultCwd || fallback;
  if (typeof configured !== 'string' || !path.isAbsolute(configured)) throw new Error(I18n.t('请先为房间设置项目目录'));
  const root = await fs.realpath(configured);
  if (!(await fs.stat(root)).isDirectory()) throw new Error(I18n.t('项目目录不存在'));
  return root;
}

async function projectPath(root, input = '.', { allowMissing = false } = {}) {
  if (typeof input !== 'string' || input.length > 4096 || /[\0\r\n]/.test(input)) throw new Error(I18n.t('文件路径无效'));
  const target = path.resolve(root, input || '.');
  if (!within(root, target)) throw new Error(I18n.t('仅能打开当前房间项目目录内的文件'));
  let actual;
  try { actual = await fs.realpath(target); }
  catch (error) {
    if (!allowMissing || error.code !== 'ENOENT') throw error;
    // A deleted Git file may have missing ancestors. Validate the nearest existing
    // ancestor, including junctions, before returning its lexical target.
    let ancestor = path.dirname(target);
    while (within(root, ancestor)) {
      try {
        const realAncestor = await fs.realpath(ancestor);
        if (!within(root, realAncestor)) throw new Error(I18n.t('文件链接指向项目目录外'));
        return target;
      } catch (ancestorError) {
        if (ancestorError.code !== 'ENOENT') throw ancestorError;
        const next = path.dirname(ancestor);
        if (next === ancestor) break;
        ancestor = next;
      }
    }
    throw error;
  }
  if (!within(root, actual)) throw new Error(I18n.t('文件链接指向项目目录外'));
  return actual;
}

module.exports = { within, roomDirectory, projectPath };
