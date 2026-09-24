'use strict';
const I18n = require('../../shared/i18n');

// Discovery reads bounded metadata only. Active skills are source references;
// legacy app-owned copy helpers remain for data compatibility.
const fs = require('fs');
const path = require('path');
const os = require('os');

// Classify by a directory boundary, never by a skill name containing "codex".
function sourceScope(sourcePath, owners = {}) {
  const normalized = String(sourcePath || '').replace(/\\/g, '/').toLowerCase();
  if (normalized.includes('/.agents/skills/') || normalized.endsWith('/.agents/skills')) {
    return { category: 'codex', nativeCliType: null, nativeCliTypes: ['codex', 'kimi', 'zcode'] };
  }
  for (const [cli, marker] of [['claude', '/.claude/skills'], ['codex', '/.codex/skills'],
    ['codex', '/.codex/prompts'], ['kimi', '/.kimi/skills'], ['kimi', '/.kimi-code/skills'],
    ['opencode', '/.config/opencode/skills'],
    ['opencode', '/.opencode/skills'], ['pi', '/.pi/agent/skills'], ['hermes', '/.hermes/skills'],
    ['codebuddy', '/.codebuddy/skills'],
    ['gemini', '/.gemini/skills'], ['qwen', '/.qwen/skills'], ['copilot', '/.copilot/skills'], ['copilot', '/.github/skills'],
    ['zcode', '/.zcode/skills'], ['cursor', '/.cursor/skills'], ['droid', '/.factory/skills'],
    ['claude', '/.claude/plugins/cache'], ['codex', '/.codex/plugins/cache']]) {
    if (normalized === marker || normalized.includes(marker + '/') || normalized.endsWith(marker)) {
      return { category: cli, nativeCliType: cli };
    }
  }
  const key = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  const candidate = key(sourcePath || '.');
  if (process.env.KIMI_CODE_HOME && path.isAbsolute(process.env.KIMI_CODE_HOME)) {
    const root = key(path.join(process.env.KIMI_CODE_HOME, 'skills'));
    if (candidate === root || candidate.startsWith(root + path.sep)) return { category: 'kimi', nativeCliType: 'kimi' };
  }
  for (const [root, cli] of Object.entries(owners).sort((a, b) => b[0].length - a[0].length)) {
    if (candidate === key(root) || candidate.startsWith(key(root) + path.sep)) return { category: cli, nativeCliType: cli };
  }
  return { category: 'other', nativeCliType: null };
}

function unquote(s) {
  return String(s || '').trim().replace(/^["']|["']$/g, '');
}

function parseFrontmatter(md) {
  const out = { name: '', description: '' };
  const m = md.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return out;
  const fm = m[1];
  const nameM = fm.match(/^name:\s*(.+?)\s*$/m);
  // description is a single (possibly long) line; stop at the next key.
  const descM = fm.match(/^description:[ \t]*(.+?)(?=\r?\n[A-Za-z_][\w-]*:|$)/ms);
  if (nameM) out.name = unquote(nameM[1]);
  if (descM) out.description = unquote(descM[1]);
  return out;
}

// Global bounds keep accidental selection of a large tree finite. File reads
// stop at the closing frontmatter delimiter, before the instruction body.
const LIMIT = { roots: 64, dirs: 1024, entries: 8192, skills: 512, depth: 7,
  header: 8192, bytes: 1048576, milliseconds: 2500 };

function ignoredDirectory(name, directory) {
  const normalized = name.toLowerCase();
  if (['node_modules', '.git', '.venv', 'venv', 'virtualenv', '__pycache__', 'site-packages',
    '.tox', '.nox', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.cache', 'dist', 'build'].includes(normalized) ||
      normalized.startsWith('.import-')) return true;
  const backup = /^[._-]*(?:rollbacks?|fallbacks?|handoffs?|snapshots?|backups?|candidates?)(?:$|[._-])/;
  if (!backup.test(normalized)) return false;
  // Keep explicit backup containers (including hidden and dated copies) excluded.
  // A descriptive skill such as backup-database is a usable leaf, not a container.
  if (/^[._-]/.test(normalized) || /^(?:rollbacks?|fallbacks?|handoffs?|snapshots?|backups?|candidates?)(?:$|[._-](?:old|copy|copies|archive|\d)(?:$|[._-]|\d))/.test(normalized)) return true;
  try {
    const stat = fs.lstatSync(path.join(directory, 'SKILL.md'));
    return !stat.isFile() || stat.isSymbolicLink();
  } catch { return true; }
}

function discoverExternalDetailed(payload = {}) {
  const category = payload.category || 'all';
  const categories = payload.categories || ['claude', 'codex', 'kimi', 'opencode', 'pi', 'hermes', 'codebuddy', 'gemini', 'qwen', 'copilot', 'cursor', 'droid', 'zcode'];
  if (!['all', 'other', ...categories].includes(category)) throw new Error(I18n.t('技能来源分类无效'));
  const owners = payload.owners || {};
  const scopeOf = value => sourceScope(value, owners);
  const result = { skills: [], roots: [], warnings: [], truncated: false, category };
  const started = Date.now();
  let directories = 0, entries = 0, headerBytes = 0;
  const seenPaths = new Set(), seenDirs = new Set();
  const key = (p) => process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);
  const within = (p, root) => key(p) === key(root) || key(p).startsWith(key(root) + path.sep);
  const appRoot = path.resolve(__dirname, '..', '..', '..');
  const excluded = [path.join(appRoot, 'data', 'skills')];
  if (process.env.AR_DATA_DIR) excluded.push(path.join(process.env.AR_DATA_DIR, 'skills'));
  if (typeof payload.skillsDir === 'string' && path.isAbsolute(payload.skillsDir)) excluded.push(payload.skillsDir);
  const warn = (message) => { if (!result.warnings.includes(message)) result.warnings.push(message); };
  const truncate = (message) => { result.truncated = true; warn(message); };
  const exhausted = () => {
    if (directories >= LIMIT.dirs || entries >= LIMIT.entries || result.skills.length >= LIMIT.skills ||
        headerBytes >= LIMIT.bytes || Date.now() - started >= LIMIT.milliseconds) {
      truncate(I18n.t('扫描达到数量或时间上限，请选择更具体的目录后重试'));
      return true;
    }
    return false;
  };
  const specs = [
    ['.codex/skills', 'Codex'], ['.codex/prompts', 'Codex prompts', true],
    ['.claude/skills', 'Claude'], ['.agents/skills', 'Agents'], ['.kimi-code/skills', 'Kimi'], ['.kimi/skills', I18n.t('Kimi 兼容目录')],
    ['.config/opencode/skills', 'OpenCode'],
    ['.opencode/skills', 'OpenCode'], ['.pi/agent/skills', 'Pi'], ['.hermes/skills', 'Hermes'],
    ['.codebuddy/skills', 'CodeBuddy'],
    ['.gemini/skills', 'Gemini'], ['.qwen/skills', 'Qwen'], ['.copilot/skills', 'Copilot'], ['.github/skills', I18n.t('Copilot 项目')],
    ['.zcode/skills', 'ZCode'], ['.cursor/skills', 'Cursor'], ['.factory/skills', 'Factory Droid'],
    ['.claude/plugins/cache', I18n.t('Claude 插件来源')], ['.codex/plugins/cache', I18n.t('Codex 插件来源')],
  ];
  const roots = [];
  for (const [base, scope] of [[os.homedir(), I18n.t('个人')], [payload.cwd, I18n.t('项目')]]) {
    if (!base) continue;
    if (typeof base !== 'string' || !path.isAbsolute(base)) { warn(I18n.t('项目目录必须是绝对路径')); continue; }
    for (const [suffix, label, prompts] of specs) roots.push({ path: path.join(base, suffix), source: `${label}·${scope}`, prompts });
  }
  // Kimi resolves project skills at the nearest Git root, including linked worktrees.
  if (typeof payload.cwd === 'string' && path.isAbsolute(payload.cwd)) {
    let current = path.resolve(payload.cwd);
    while (true) {
      if (fs.existsSync(path.join(current, '.git'))) {
        if (current !== path.resolve(payload.cwd)) for (const suffix of ['.kimi-code/skills', '.agents/skills']) {
          roots.push({ path: path.join(current, suffix), source: I18n.t('Kimi·Git 项目') });
        }
        break;
      }
      const parent = path.dirname(current); if (parent === current) break; current = parent;
    }
  }
  if (process.env.KIMI_CODE_HOME && path.isAbsolute(process.env.KIMI_CODE_HOME)) roots.unshift({ path: path.join(process.env.KIMI_CODE_HOME, 'skills'), source: I18n.t('Kimi·配置目录') });
  if (payload.roots != null && !Array.isArray(payload.roots)) warn(I18n.t('附加扫描目录必须是数组'));
  const customRoots = [];
  for (const root of Array.isArray(payload.roots) ? payload.roots.slice(0, LIMIT.roots) : []) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) { warn(I18n.t('已忽略非绝对路径的附加扫描目录')); continue; }
    customRoots.push({ path: root, source: I18n.t('自选目录') });
  }
  roots.unshift(...customRoots);
  if (Array.isArray(payload.roots) && payload.roots.length > LIMIT.roots) truncate(I18n.t('附加扫描目录数量超限'));

  function linked(p) {
    let current = path.parse(path.resolve(p)).root;
    for (const part of path.resolve(p).slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    }
    return false;
  }

  function metadata(file) {
    const fd = fs.openSync(file, 'r');
    const byte = Buffer.alloc(1), bytes = [];
    let line = [], first = true;
    try {
      while (bytes.length < LIMIT.header && !exhausted()) {
        if (!fs.readSync(fd, byte, 0, 1, null)) break;
        headerBytes += 1;
        bytes.push(byte[0]);
        // Files without frontmatter need only a delimiter-sized probe.
        if (first && bytes.length === 4 && !Buffer.from(bytes).toString('utf8').startsWith('---') &&
            !Buffer.from(bytes).equals(Buffer.from([0xef, 0xbb, 0xbf, 0x2d]))) {
          return { name: '', description: '' };
        }
        if (byte[0] !== 10) { line.push(byte[0]); continue; }
        const text = Buffer.from(line).toString('utf8').replace(/\r$/, '').replace(/^\uFEFF/, '');
        line = [];
        if (first) { first = false; if (text !== '---') return { name: '', description: '' }; }
        else if (text === '---') return parseFrontmatter(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, ''));
      }
      if (bytes.length >= LIMIT.header) truncate(I18n.tpl`技能元数据超过 ${LIMIT.header} 字节：${file}`);
      else if (bytes.length && !first) warn(I18n.tpl`技能元数据未闭合：${file}`);
      return { name: '', description: '' };
    } finally { fs.closeSync(fd); }
  }

  function add(file, sourcePath, source) {
    const scope = scopeOf(sourcePath);
    if (category !== 'all' && scope.category !== category && !scope.nativeCliTypes?.includes(category)) return;
    if (seenPaths.has(key(sourcePath)) || exhausted()) return;
    const fileStat = fs.lstatSync(file);
    if (fileStat.isSymbolicLink()) { warn(I18n.tpl`已跳过链接：${file}`); return; }
    const fm = metadata(file);
    seenPaths.add(key(sourcePath));
    result.skills.push({ name: fm.name || path.basename(sourcePath).replace(/\.md$/i, ''),
      description: fm.description, source, sourcePath, modifiedAt: fileStat.mtimeMs, ...scope,
      ...(scope.nativeCliTypes?.includes(category) ? { category } : {}) });
  }

  function scan(dir, root, depth) {
    const scope = scopeOf(dir);
    if (category !== 'all' && scope.nativeCliType && scope.category !== category) return;
    if (excluded.some((p) => within(dir, p))) { warn(I18n.tpl`已跳过应用技能副本：${dir}`); return; }
    if (seenDirs.has(key(dir)) || exhausted()) return;
    seenDirs.add(key(dir));
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink()) { warn(I18n.tpl`已跳过链接：${dir}`); return; }
    if (st.isFile()) { if (/\.md$/i.test(dir)) add(dir, dir, root.source); return; }
    if (!st.isDirectory()) return;
    // Virtual environments may use any directory name; their marker is enough
    // to skip dependencies without opening configuration or package files.
    if (fs.existsSync(path.join(dir, 'pyvenv.cfg')) || fs.existsSync(path.join(dir, 'conda-meta'))) return;
    directories += 1;
    const skill = path.join(dir, 'SKILL.md');
    try {
      const skillStat = fs.lstatSync(skill);
      if (skillStat.isFile() || skillStat.isSymbolicLink()) { add(skill, dir, root.source); return; }
    } catch (err) { if (err.code !== 'ENOENT') throw err; }
    const handle = fs.opendirSync(dir);
    try {
      let entry;
      while (!exhausted() && (entry = handle.readSync())) {
        entries += 1;
        const child = path.join(dir, entry.name);
        if (entry.isSymbolicLink()) { warn(I18n.tpl`已跳过链接：${child}`); continue; }
        if (entry.isDirectory()) {
          if (ignoredDirectory(entry.name, child)) continue;
          if (depth >= LIMIT.depth) { truncate(I18n.tpl`扫描达到嵌套深度上限：${child}`); continue; }
          try { scan(child, root, depth + 1); } catch (err) { root.status = 'partial'; warn(I18n.tpl`目录无法读取：${child}（${err.code || 'ERROR'}）`); }
        } else if (root.prompts && entry.isFile() && /\.md$/i.test(entry.name)) {
          try { add(child, child, root.source); } catch (err) { root.status = 'partial'; warn(I18n.tpl`元数据无法读取：${child}（${err.code || 'ERROR'}）`); }
        }
      }
    } finally { handle.closeSync(); }
  }

  const rootKeys = new Set();
  for (const candidate of roots) {
    const rootPath = path.resolve(candidate.path);
    const rootScope = scopeOf(rootPath);
    if (category !== 'all' && rootScope.category !== category && !rootScope.nativeCliTypes?.includes(category)) continue;
    if (rootKeys.has(key(rootPath))) continue;
    rootKeys.add(key(rootPath));
    if (result.roots.length >= LIMIT.roots) { truncate(I18n.t('扫描根目录数量超限')); break; }
    const root = { path: rootPath, source: candidate.source, ...scopeOf(rootPath), status: 'ok' };
    result.roots.push(root);
    if (exhausted()) { root.status = 'limited'; continue; }
    try {
      if (linked(rootPath)) { root.status = 'skipped_link'; warn(I18n.tpl`已跳过链接根目录：${rootPath}`); continue; }
      let ancestor = path.parse(rootPath).root;
      const ignoredRoot = rootPath.slice(ancestor.length).split(path.sep).filter(Boolean).some(part => {
        ancestor = path.join(ancestor, part); return ignoredDirectory(part, ancestor);
      });
      if (ignoredRoot) { root.status = 'filtered'; continue; }
      if (excluded.some((p) => within(rootPath, p))) { root.status = 'excluded'; continue; }
      scan(rootPath, Object.assign(root, { prompts: candidate.prompts }), 0);
      delete root.prompts;
      if (exhausted() && root.status === 'ok') root.status = 'limited';
    } catch (err) {
      delete root.prompts;
      root.status = err.code === 'ENOENT' ? 'missing' : 'error';
      if (root.status === 'error') warn(I18n.tpl`扫描根目录无法读取：${rootPath}（${err.code || 'ERROR'}）`);
    }
  }
  // Only shared local copies collapse by name. Native Agent copies retain their
  // separate applicability. Equal timestamps use the path for a stable winner.
  const newest = new Map();
  for (const skill of result.skills) {
    if (skill.category !== 'other') continue;
    const name = skill.name.trim().toLowerCase();
    const prior = newest.get(name);
    if (!prior || skill.modifiedAt > prior.modifiedAt ||
        (skill.modifiedAt === prior.modifiedAt && key(skill.sourcePath) < key(prior.sourcePath))) newest.set(name, skill);
  }
  result.skills = result.skills.filter(skill => skill.category !== 'other' || newest.get(skill.name.trim().toLowerCase()) === skill);
  return result;
}

function discoverExternal(payload) { return discoverExternalDetailed(payload).skills; }

// --- imported copies (app-owned, under data/skills) ---

function importedDir(skillsDir, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' ||
      /[\\/:*?"<>|\x00-\x1f]/.test(name) || /[. ]$/.test(name) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error(I18n.t('技能名称必须是有效的单级目录名'));
  }
  const root = path.resolve(skillsDir);
  const dest = path.resolve(root, name);
  if (path.dirname(dest) !== root) throw new Error(I18n.t('技能路径超出应用目录'));
  if (fs.existsSync(root) && fs.lstatSync(root).isSymbolicLink()) throw new Error(I18n.t('技能目录不能是链接'));
  if (fs.existsSync(dest) && fs.lstatSync(dest).isSymbolicLink()) throw new Error(I18n.t('技能目录不能是链接'));
  return dest;
}

// Copy an external skill (a folder, or a single Codex .md) into the app store.
// Overwrites a previous imported copy of the same name.
function importSkill(skillsDir, sourcePath, name) {
  const dest = importedDir(skillsDir, name);
  const st = fs.statSync(sourcePath);
  const relativeStore = path.relative(path.resolve(sourcePath), path.resolve(skillsDir));
  if (st.isDirectory() && (!relativeStore || (!relativeStore.startsWith('..' + path.sep) && relativeStore !== '..' && !path.isAbsolute(relativeStore)))) {
    throw new Error(I18n.t('不能导入包含应用技能目录的父目录'));
  }
  const skillFile = st.isDirectory() ? path.join(sourcePath, 'SKILL.md') : sourcePath;
  fs.readFileSync(skillFile, 'utf8'); // Validate the source before replacing a working copy.
  fs.mkdirSync(skillsDir, { recursive: true });
  const stage = fs.mkdtempSync(path.join(skillsDir, '.import-'));
  const staged = path.join(stage, 'skill');
  const previous = path.join(stage, 'previous');
  let preserveRecovery = false;
  try {
    if (st.isDirectory()) {
      fs.cpSync(sourcePath, staged, { recursive: true, filter: (src) => {
        if (fs.lstatSync(src).isSymbolicLink()) throw new Error(I18n.t('技能导入不支持符号链接'));
        return true;
      } });
    } else {
      fs.mkdirSync(staged);
      fs.copyFileSync(sourcePath, path.join(staged, 'SKILL.md'));
    }
    if (fs.existsSync(dest)) fs.renameSync(dest, previous);
    try { fs.renameSync(staged, dest); } catch (err) {
      if (fs.existsSync(previous)) {
        try { fs.renameSync(previous, dest); } catch (_) {
          preserveRecovery = true;
          throw new Error(I18n.tpl`技能替换失败，旧副本已保留，请从此目录恢复：${previous}`);
        }
      }
      throw err;
    }
  } finally {
    if (!preserveRecovery) fs.rmSync(stage, { recursive: true, force: true });
  }
  return readOneImported(skillsDir, name);
}

function readOneImported(skillsDir, name) {
  const skPath = path.join(importedDir(skillsDir, name), 'SKILL.md');
  try {
    const fm = parseFrontmatter(fs.readFileSync(skPath, 'utf8'));
    return { name, description: fm.description, dir: importedDir(skillsDir, name) };
  } catch { return null; }
}

function listImported(skillsDir) {
  let entries;
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const sk = readOneImported(skillsDir, e.name);
    if (sk) out.push(sk);
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function removeImported(skillsDir, name) {
  fs.rmSync(importedDir(skillsDir, name), { recursive: true, force: true });
}

// Full SKILL.md text of an imported skill, used to inline instructions into
// the addressed bot's prompt.
function readSkillBody(skillsDir, name) {
  try {
    return fs.readFileSync(path.join(importedDir(skillsDir, name), 'SKILL.md'), 'utf8');
  } catch { return ''; }
}

module.exports = {
  sourceScope,
  parseFrontmatter,
  discoverExternal,
  discoverExternalDetailed,
  importSkill,
  listImported,
  removeImported,
  readSkillBody,
};
