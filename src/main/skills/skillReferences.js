'use strict';
const I18n = require('../../shared/i18n');

const fs = require('fs');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { readJson, writeJsonAtomic } = require('../store/jsonStore');
const { isCliId } = require('../cliRegistry');
const { sourceScope } = require('./skillScanner');

function sourceFile(sourcePath) {
  if (typeof sourcePath !== 'string' || !path.isAbsolute(sourcePath) || /[\r\n\x00]/.test(sourcePath)) {
    throw new Error(I18n.t('技能来源必须是有效的绝对路径'));
  }
  if (/^[\\/]{2}/.test(sourcePath)) throw new Error(I18n.t('原生引用仅支持本地目录，不支持网络共享路径'));
  const absolute = path.resolve(sourcePath);
  let ancestor = path.parse(absolute).root;
  for (const part of absolute.slice(ancestor.length).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, part);
    if (fs.lstatSync(ancestor).isSymbolicLink()) throw new Error(I18n.t('技能原生引用不能穿过链接目录'));
  }
  const stat = fs.lstatSync(absolute);
  const file = stat.isDirectory() ? path.join(absolute, 'SKILL.md') : absolute;
  const fileStat = fs.lstatSync(file);
  if (!fileStat.isFile() || fileStat.isSymbolicLink() || !/\.md$/i.test(file)) {
    throw new Error(I18n.t('技能来源必须是 SKILL.md 目录或 Markdown 文件'));
  }
  return file;
}

function registryFile(dataPath) { return path.join(dataPath, 'skill-references.json'); }
function records(dataPath) {
  const data = readJson(registryFile(dataPath), []);
  if (!Array.isArray(data) || data.length > 128 || data.some((item) => !item || item.mode !== 'reference' ||
      typeof item.id !== 'string' || !item.id ||
      typeof item.name !== 'string' || !item.name || item.name.length > 120 || /[\r\n\x00]/.test(item.name) ||
      (item.description != null && (typeof item.description !== 'string' || item.description.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item.description))) ||
      typeof item.alias !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(item.alias) ||
      typeof item.sourcePath !== 'string' || !path.isAbsolute(item.sourcePath) || /^[\\/]{2}/.test(item.sourcePath) ||
      typeof item.skillFile !== 'string' || !path.isAbsolute(item.skillFile) ||
      !Array.isArray(item.cliTypes) || !item.cliTypes.length || item.cliTypes.some((cli) => !isCliId(cli)))) {
    throw new Error(I18n.t('技能引用登记数据无效，未修改原记录'));
  }
  return data;
}

function list(dataPath) {
  // Listing/slash completion is metadata-only. Check the selected source on
  // resolve, rather than walking every source directory on each keystroke.
  const settings = readJson(path.join(dataPath, 'settings.json'), {});
  return records(dataPath).map((record) => {
    const scope = sourceScope(record.sourcePath, settings.skillScanOwners);
    if (!scope.nativeCliType && isCliId(record.nativeCliType)) Object.assign(scope, { nativeCliType: record.nativeCliType, category: record.nativeCliType });
    const sharedCliTypes = record.sharedForAll && Array.isArray(settings.enabledCliIds) ? settings.enabledCliIds.filter(isCliId) : record.cliTypes;
    return { ...record, ...scope, cliTypes: scope.nativeCliTypes || (scope.nativeCliType ? [scope.nativeCliType] : sharedCliTypes), availability: 'unchecked' };
  });
}

function register(dataPath, input, options = {}) {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120 || /[\r\n\x00]/.test(input.name)) {
    throw new Error(I18n.t('技能名称无效'));
  }
  if (input.description != null && (typeof input.description !== 'string' || input.description.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(input.description))) throw new Error(I18n.t('技能说明无效'));
  const alias = input.alias || input.name;
  if (typeof alias !== 'string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(alias)) throw new Error(I18n.t('技能别名仅支持字母、数字、下划线、点和连字符'));
  if (!Array.isArray(input.cliTypes)) throw new Error(I18n.t('请选择原生引用适用的 CLI'));
  const scope = sourceScope(input.sourcePath, options.owners);
  const cliTypes = [...new Set(input.cliTypes)];
  if (scope.nativeCliType && cliTypes.some(cli => cli !== scope.nativeCliType)) {
    throw new Error(I18n.tpl`此来源属于 ${scope.nativeCliType} 的技能目录，只能登记给该 Agent；共享技能请从本地其他目录登记`);
  }
  if (scope.nativeCliTypes && cliTypes.some(cli => !scope.nativeCliTypes.includes(cli))) throw new Error(I18n.t('此技能来源仅适用于 Codex、Kimi Code 和 ZCode'));
  if (!cliTypes.length || cliTypes.some((cli) => !isCliId(cli))) throw new Error(I18n.t('请选择原生引用适用的 CLI'));
  const skillFile = sourceFile(input.sourcePath);
  const current = records(dataPath);
  const replacing = input.replaceId && current.find((record) => record.id === input.replaceId);
  if (input.replaceId && !replacing) throw new Error(I18n.t('待替换的技能引用不存在'));
  if (!replacing && current.length >= 128) throw new Error(I18n.t('技能引用已达 128 条上限，请移除不再使用的引用'));
  const conflict = current.find((record) => record.id !== input.replaceId && record.alias.toLowerCase() === alias.toLowerCase() &&
    record.cliTypes.some((cli) => cliTypes.includes(cli)));
  if (conflict) throw new Error(I18n.t('同一 CLI 已登记该技能别名；请明确选择替换来源或更换别名'));
  const record = { id: replacing ? replacing.id : randomUUID(), mode: 'reference', name: input.name.trim(), alias,
    ...scope, sharedForAll: options.sharedForAll === true && !scope.nativeCliType && !scope.nativeCliTypes,
    description: (input.description || '').trim(), sourcePath: path.resolve(input.sourcePath), skillFile, cliTypes, createdAt: replacing ? replacing.createdAt : Date.now() };
  writeJsonAtomic(registryFile(dataPath), [...current.filter((item) => item.id !== record.id), record]);
  return record;
}

function registerDiscovered(dataPath, candidate, { enabledCliIds, owners = {} }) {
  const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const current = list(dataPath);
  const existing = current.find(item => key(item.sourcePath) === key(candidate.sourcePath));
  if (existing) return existing;
  const scope = sourceScope(candidate.sourcePath, owners);
  const cliTypes = scope.nativeCliTypes ? enabledCliIds.filter(id => scope.nativeCliTypes.includes(id))
    : scope.nativeCliType ? enabledCliIds.filter(id => id === scope.nativeCliType) : enabledCliIds;
  if (!cliTypes.length) throw new Error(I18n.t('请先在 Agent 接入中启用此技能适用的 Agent'));
  const base = candidate.name.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[.-]+|[.-]+$/g, '').slice(0, 100) || 'skill';
  let alias = base;
  const conflict = value => current.some(item => item.alias.toLowerCase() === value.toLowerCase() && item.cliTypes.some(id => cliTypes.includes(id)));
  if (conflict(alias)) alias = `${base}-${createHash('sha256').update(key(candidate.sourcePath)).digest('hex').slice(0, 8)}`;
  let suffix = 2;
  const unique = alias;
  while (conflict(alias)) alias = `${unique}-${suffix++}`;
  return register(dataPath, { sourcePath: candidate.sourcePath, name: candidate.name.slice(0, 120), alias, cliTypes,
    description: (candidate.description || '').slice(0, 2000) }, { owners, sharedForAll: !scope.nativeCliType });
}

function remove(dataPath, id) {
  const current = records(dataPath);
  if (!current.some((record) => record.id === id)) throw new Error(I18n.t('技能引用不存在'));
  writeJsonAtomic(registryFile(dataPath), current.filter((record) => record.id !== id));
}

function resolve(dataPath, { alias, cliType }) {
  const matches = list(dataPath).filter((record) => record.alias.toLowerCase() === String(alias).toLowerCase());
  if (!matches.length) throw new Error(I18n.tpl`技能原生引用不存在：${alias}`);
  const compatible = matches.filter((record) => record.cliTypes.includes(cliType));
  if (compatible.length !== 1) throw new Error(I18n.tpl`技能 ${alias} 不适用于 ${cliType}；请选择该 Agent 目录的技能或本地其他目录中的共享来源`);
  const record = compatible[0];
  try {
    const skillFile = sourceFile(record.sourcePath);
    if (skillFile !== record.skillFile) throw new Error(I18n.t('来源类型已改变'));
    return { ...record, skillFile, availability: 'available' };
  }
  catch (_) { throw new Error(I18n.tpl`技能 ${alias} 的原生来源不可访问或已改变，请重新选择来源`); }
}

module.exports = { list, register, registerDiscovered, remove, resolve };
