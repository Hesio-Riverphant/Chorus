'use strict';

const RoomCommands = (() => {
  const commands = () => [
    { name: 'model', description: I18n.t('选择成员的模型与推理程度') },
    { name: 'plan', description: I18n.t('计划模式 · @ 选择成员，默认主持人＋研究员') },
    { name: 'goal', description: I18n.t('目标模式 · @ 选择成员，默认主持人') },
    { name: 'context', description: I18n.t('查看成员的上下文用量') },
    { name: 'mcp', description: I18n.t('选择成员的 MCP 能力') },
    { name: 'plugins', description: I18n.t('选择成员的原生插件') },
    { name: 'permissions', description: I18n.t('查看和调整成员的访问权限') },
    { name: 'yolo', description: I18n.t('选择成员并确认全权自动模式') },
    { name: 'settings', description: I18n.t('打开应用设置') },
    { name: 'skills', description: I18n.t('管理已登记的技能引用') },
    { name: 'help', description: I18n.t('查看可用命令及其作用范围') },
    { name: 'stop', description: I18n.t('停止当前聊天的运行') },
  ].map(item => ({ ...item, command: true }));

  function dialog(title) {
    const element = document.createElement('dialog'); element.className = 'app-dialog edit-dialog';
    const heading = document.createElement('h2'); heading.textContent = title;
    const body = document.createElement('div');
    const close = document.createElement('button'); close.className = 'ghost-btn'; I18n.write(close, () => I18n.t('关闭'));
    element.append(heading, body, close); document.body.append(element);
    element.addEventListener('keydown', event => event.stopPropagation());
    const done = () => { element.close(); element.remove(); };
    close.onclick = done; element.oncancel = event => { event.preventDefault(); done(); };
    element.showModal(); return { element, body, close, done };
  }
  async function member(roomId, predicate = () => true) {
    const room = state.rooms.find(item => item.id === roomId);
    const bots = roomMembers(room).filter(predicate);
    if (!bots.length) { await AppDialog.alert(I18n.t('当前聊天没有支持此操作的成员。')); return null; }
    if (bots.length === 1) return bots[0];
    const d = dialog(I18n.live(() => I18n.t('选择成员')));
    d.element.classList.add('command-member-dialog');
    const search = document.createElement('input'); search.type = 'search'; I18n.write(search, () => I18n.t('搜索成员、Agent 或模型'), 'placeholder'); I18n.attr(search, 'aria-label', () => I18n.t('搜索成员'));
    const list = document.createElement('div'); list.className = 'command-member-list';
    const empty = document.createElement('p'); empty.className = 'hint'; I18n.write(empty, () => I18n.t('没有匹配的成员')); empty.hidden = true;
    d.body.append(search, list, empty);
    return new Promise(resolve => {
      let completed = false;
      const select = bot => { if (completed) return; completed = true; d.done(); resolve(bot); };
      for (const bot of bots) {
        const button = document.createElement('button'); button.className = 'command-member-option'; button.type = 'button';
        const name = document.createElement('strong'); name.textContent = bot.name;
        const description = document.createElement('small'); I18n.write(description, () => `${state.cliProfiles?.find(profile => profile.id === bot.cliType)?.label || bot.cliType} · ${bot.model || I18n.t('默认模型')}`);
        button.append(name, description); button.dataset.search = [bot.name, bot.cliType, bot.model, description.textContent].join(' ').toLowerCase();
        button.onclick = () => select(bot); list.append(button);
      }
      search.oninput = () => {
        const terms = search.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
        for (const button of list.children) button.hidden = !terms.every(term => button.dataset.search.includes(term));
        empty.hidden = [...list.children].some(button => !button.hidden);
      };
      search.focus();
      d.close.onclick = () => select(null); d.element.oncancel = event => { event.preventDefault(); select(null); };
    });
  }
  async function context(roomId) {
    const usage = await window.api.getContextUsage(roomId);
    const d = dialog(I18n.live(() => I18n.t('上下文用量')));
    const hint = document.createElement('p'); hint.className = 'hint';
    I18n.write(hint, () => I18n.t('上下文来自最近一次模型调用的原生用量；新调用后更新。应用补入为规则、人设和旧历史的估算，不含当前草稿、原生规则及工具。历史条数和 token 预算可在设置 → 接力控制调整。'));
    const table = document.createElement('table'); table.className = 'context-table';
    table.innerHTML = I18n.t('<thead><tr><th>成员</th><th>应用下次补入</th><th>最近运行累计输入</th><th>缓存命中</th><th>最近上下文</th></tr></thead>');
    const body = document.createElement('tbody');
    for (const item of usage) {
      const row = document.createElement('tr');
      const values = [item.name, I18n.tpl`≈${fmtNum(item.nextInputEstimate)} tok（${item.historyMessages} 条）`,
        item.lastInputTokens == null ? I18n.t('尚无记录') : `${item.lastInputEstimated ? '≈' : ''}${fmtNum(item.lastInputTokens)} tok`,
        item.cachedInputTokens == null ? I18n.t('CLI 未提供') : `${fmtNum(item.cachedInputTokens)} tok${item.lastInputTokens > 0 ? ` · ${Math.min(100, Math.round(item.cachedInputTokens / item.lastInputTokens * 100))}%` : ''}`,
        item.currentTokens == null ? I18n.t('CLI 未提供') : `${fmtNum(item.currentTokens)}${item.contextWindow ? ` / ${fmtNum(item.contextWindow)}` : ''} tok`];
      for (const text of values) { const cell = document.createElement('td'); I18n.label(cell, text); row.append(cell); }
      const breakdown = document.createElement('small'); breakdown.className = 'context-percent';
      I18n.write(breakdown, () => I18n.tpl`规则与人设 ≈${fmtNum(item.roomOverheadEstimate)} · 旧历史 ≈${fmtNum(item.historyTokenEstimate || 0)} tok`);
      row.children[1].append(breakdown);
      if (item.currentCachedInputTokens != null && item.currentInputTokens > 0) {
        const recent = document.createElement('small'); recent.className = 'context-percent';
        I18n.write(recent, () => I18n.tpl`最近请求 ${Math.round(item.currentCachedInputTokens / item.currentInputTokens * 100)}%`);
        row.children[3].append(recent);
      }
      if (item.currentTokens != null && item.contextWindow > 0) {
        const ratio = item.currentTokens / item.contextWindow;
        const progress = document.createElement('progress'); progress.max = item.contextWindow;
        progress.value = item.currentTokens; progress.className = 'context-meter';
        I18n.write(progress, () => I18n.tpl`${item.name} 上下文已用 ${Math.round(ratio * 100)}%`, 'ariaLabel');
        const label = document.createElement('small'); label.className = 'context-percent';
        I18n.write(label, () => I18n.tpl`${Math.round(ratio * 100)}% 已用 · ${Math.max(0, Math.round((1 - ratio) * 100))}% 剩余`);
        row.lastElementChild.append(progress, label);
      } else if (item.currentTokens != null) {
        const label = document.createElement('small'); label.className = 'context-percent'; I18n.write(label, () => I18n.t('模型未提供窗口上限'));
        row.lastElementChild.append(label);
      }
      I18n.write(row, () => I18n.tpl`房间规则与人设约 ${item.roomOverheadEstimate} tok`, 'title'); body.append(row);
    }
    table.append(body);
    const scroll = document.createElement('div'); scroll.className = 'context-scroll'; scroll.append(table);
    d.body.append(hint, scroll);
  }
  async function execute(name, roomId) {
    if (name === 'stop') { await window.api.stopRun(roomId); return; }
    if (name === 'context') { await context(roomId); return; }
    if (name === 'plan' || name === 'goal') { ComposerModeUI.set(roomId, name); return; }
    if (name === 'settings' || name === 'skills') { openSettings(name === 'skills' ? 'skills' : 'general', roomId); return; }
    if (name === 'help') {
      const d = dialog(I18n.live(() => I18n.t('可用命令')));
      const hint = document.createElement('p'); hint.className = 'hint'; I18n.write(hint, () => I18n.t('以下命令由应用处理；原生 CLI 的交互命令请在内置终端中使用。')); d.body.append(hint);
      for (const command of commands()) { const line = document.createElement('p'); line.textContent = `/${command.name} — ${command.description}`; d.body.append(line); }
      return;
    }
    if (name === 'mcp' || name === 'plugins') {
      openSettings('extensions', roomId); return;
    }
    const bot = await member(roomId, bot => name !== 'yolo' || ['claude', 'codex', 'kimi', 'codebuddy', 'pi', 'opencode', 'hermes', 'gemini', 'qwen', 'copilot', 'cursor', 'droid', 'zcode'].includes(bot.cliType));
    if (!bot) return;
    if (name === 'yolo') {
      const room = state.rooms.find(item => item.id === roomId), local = RoomProfiles.isLocal(room);
      const names = state.rooms.filter(item => !RoomProfiles.isLocal(item) && item.botIds?.includes(bot.id)).map(item => item.name).join('、');
      const scope = local ? I18n.tpl`仅侧聊“${room.name}”` : I18n.tpl`使用此共享成员的房间：${names}`;
      if (!await AppDialog.confirm(I18n.tpl`将“${bot.name}”设为全权自动，原生 Agent 可自动执行操作。${scope}。确认后会打开成员设置，保存后从下次运行生效。继续？`)) return;
    }
    openBotEdit(bot, roomId);
    if (name === 'model') document.getElementById('f_modelSelect').focus();
    if (name === 'yolo') setPermRadio('full');
    if (name === 'yolo' || name === 'permissions') document.getElementById('f_perm').scrollIntoView({ block: 'nearest' });
  }
  function items(roomId) {
    return commands();
  }
  async function choose(item, { roomId, composer, start, end }) {
    if (!item.command) {
      composer.replaceToken(start, end, 'skill', item.name);
      if (item.unavailableInRoom) await AppDialog.alert(I18n.tpl`/${item.name} 只适用于 ${item.cliTypes.join(' / ')}，当前房间没有对应 Agent。请选择适用成员，或登记本地其他目录的共享来源。`);
      return;
    }
    composer.select(start, end); composer.insertText('');
    await execute(item.name, roomId);
    if (item.name === 'plan' || item.name === 'goal') composer.focus();
  }
  async function intercept(text, roomId, composer) {
    const match = text.trim().match(/^\/([a-z]+)$/);
    if (!match || !commands().some(command => command.name === match[1])) return false;
    await execute(match[1], roomId); composer.clearSent(roomId, text); return true;
  }
  return { items, choose, intercept, context };
})();

// Main and side composers share parsing, matching and alias deduplication.
const ComposerSlash = {
  detect(text, end = text.length) {
    const match = text.slice(0, end).match(/(?:^|\s)\/(skill(?:[ \t]+[^\r\n/@]*)?|[^\s/]*)$/i);
    return match ? { query: match[1], start: end - match[1].length - 1, end } : null;
  },
  items(roomId, query = '') {
    const skillPrefix = query.length > 0 && 'skill'.startsWith(query.toLowerCase());
    const skillOnly = skillPrefix || /^skill(?:[ \t]|$)/i.test(query);
    const terms = (skillPrefix ? '' : skillOnly ? query.replace(/^skill[ \t]*/i, '') : query).toLowerCase().trim().split(/\s+/).filter(Boolean);
    const skills = new Map();
    const sourceKey = value => String(value || '').replace(/\\/g, '/').toLowerCase();
    // Reuse metadata from a user-requested library scan for older references.
    const descriptions = new Map((state.externalSkills || []).map(item => [sourceKey(item.sourcePath), item.description]));
    for (const skill of state.importedSkills || []) {
      const name = skill.alias || skill.name, key = name.toLowerCase();
      const previous = skills.get(key);
      const description = skill.description || descriptions.get(sourceKey(skill.sourcePath)) || '';
      const cliTypes = [...new Set([...(previous?.cliTypes || []), ...(skill.cliTypes || [])])];
      const searchText = [previous?.searchText, skill.name, skill.alias, description].filter(Boolean).join(' ');
      skills.set(key, { ...skill, name, cliTypes, searchText,
        skillDescription: description || previous?.skillDescription || '',
        description: [description || previous?.skillDescription, cliTypes.join(' / ')].filter(Boolean).join(' · ') });
    }
    const room = state.rooms?.find(item => item.id === roomId);
    const roomBots = typeof RoomProfiles !== 'undefined' ? RoomProfiles.members(room, state.bots || [], state.settings || {}) : (state.bots || []).filter(bot => room?.botIds?.includes(bot.id));
    const roomCliTypes = new Set(roomBots.map(bot => bot.cliType));
    for (const skill of skills.values()) {
      skill.unavailableInRoom = Boolean(room) && !skill.cliTypes.some(cli => roomCliTypes.has(cli));
      if (skill.unavailableInRoom) skill.description += I18n.t(' · 当前房间无适用 Agent');
    }
    const commands = skillPrefix ? RoomCommands.items(roomId).filter(item => query.toLowerCase() !== 'skill' && item.name.startsWith(query.toLowerCase()))
      : skillOnly ? [] : RoomCommands.items(roomId);
    return [...commands, ...skills.values()]
      .filter(item => terms.every(term => [item.name, item.searchText, item.description].join(' ').toLowerCase().includes(term)));
  },
};
window.getComposerSlashItems = (roomId, query = '') => ComposerSlash.items(roomId, query);
window.chooseComposerSlash = (item, scope) => RoomCommands.choose(item, scope);

const NativeInputUI = (() => {
  const pending = new Map();
  function render(roomId) {
    const container = roomId === state.currentRoomId ? document.getElementById('messages')
      : SideChatUI.getRoom()?.id === roomId ? document.getElementById('sideChatMessages') : null;
    if (!container) return;
    container.querySelectorAll('.native-question').forEach(element => element.remove());
    if (state.rooms.find(room => room.id === roomId)?.archivedAt) return;
    for (const message of messages(roomId)) for (const input of message.deferredInputs || []) {
      const key = message.id + ':' + input.requestId;
      if (input.status === 'deferred' && !message.supersededBy && !pending.has(key)) pending.set(key, { ...input, roomId,
        messageId: message.id, botId: message.authorId, answers: {} });
      else if (input.status !== 'deferred' || message.supersededBy) pending.delete(key);
    }
    for (const [key, record] of pending) {
      if (record.roomId !== roomId) continue;
      const form = document.createElement('form'); form.className = 'native-question';
      const heading = document.createElement('strong');
      const name = (roomMembers(state.rooms.find(room => room.id === record.roomId)).find(bot => bot.id === record.botId) || state.bots.find(bot => bot.id === record.botId))?.name || I18n.t('成员');
      I18n.write(heading, () => record.type === 'approval' ? I18n.tpl`${name} 请求授权` : I18n.tpl`${name} 需要补充信息`);
      form.append(heading);
      if (record.type === 'approval') {
        const detail = document.createElement('pre'); detail.textContent = record.detail || ''; form.append(detail);
        const hint = document.createElement('p'); hint.className = 'hint';
        I18n.write(hint, () => I18n.t('始终允许仅适用于本次原生会话；超时自动拒绝。')); form.append(hint);
        const error = document.createElement('p'); error.className = 'hint';
        for (const decision of record.decisions || []) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost-btn';
          I18n.write(button, () => I18n.t(({ accept: '允许一次', acceptForSession: '本次会话始终允许', decline: '拒绝' })[decision] || decision));
          button.onclick = async () => {
            form.querySelectorAll('button').forEach(value => { value.disabled = true; });
            try { await window.api.respondNativeInput({ roomId, messageId: record.messageId, requestId: record.requestId, answers: { decision } }); pending.delete(key); form.remove(); }
            catch (e) { error.textContent = e.message; form.querySelectorAll('button').forEach(value => { value.disabled = false; }); }
          };
          form.append(button);
        }
        form.append(error); container.append(form); continue;
      }
      const fields = document.createElement('div'); form.append(fields);
      if (record.status === 'deferred') {
        const hint = document.createElement('p'); hint.className = 'hint';
        I18n.write(hint, () => I18n.t('等待已结束。回答后将新建一次续接调用，并核对之前的执行结果。')); form.append(hint);
        const reopen = document.createElement('button'); reopen.type = 'button'; reopen.className = 'ghost-btn';
        I18n.write(reopen, () => I18n.t('回答问题')); fields.hidden = !record.expanded;
        reopen.onclick = () => { record.expanded = true; fields.hidden = false; reopen.hidden = true; };
        reopen.hidden = !!record.expanded; form.append(reopen);
      }
      for (const question of record.questions || []) {
        const label = document.createElement('label'); label.className = 'field';
        const text = document.createElement('span'); text.textContent = question.question;
        const input = document.createElement('input'); input.required = true; input.name = question.id; input.value = record.answers[question.id] || '';
        input.readOnly = question.optionOnly === true;
        record.selections ||= {};
        input.oninput = () => { record.answers[question.id] = input.value; record.selections[question.id] = []; };
        label.append(text);
        for (const option of question.options || []) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost-btn';
          button.textContent = option.label; button.title = option.description || '';
          button.onclick = () => {
            if (question.multiSelect) {
              const selected = record.selections[question.id] || [];
              record.selections[question.id] = selected.includes(option.label) ? selected.filter(value => value !== option.label) : [...selected, option.label];
              input.value = record.selections[question.id].join(', ');
              for (const candidate of label.querySelectorAll('button')) candidate.setAttribute('aria-pressed', String(record.selections[question.id].includes(candidate.textContent)));
            } else {
              input.value = option.label;
              for (const candidate of label.querySelectorAll('button')) candidate.setAttribute('aria-pressed', String(candidate === button));
            }
            record.answers[question.id] = input.value;
          };
          label.append(button);
        }
        input.placeholder = question.optionOnly ? I18n.t('请选择提供的选项') : I18n.t('选择选项或填写其他回答');
        label.append(input); fields.append(label);
      }
      const send = document.createElement('button'); send.className = 'primary-btn'; I18n.write(send, () => I18n.t('继续'));
      const error = document.createElement('p'); error.className = 'hint'; fields.append(send, error);
      form.onsubmit = async event => {
        event.preventDefault(); send.disabled = true;
        try {
          const answers = Object.fromEntries(record.questions.map(question => [question.id, { answers:
            question.multiSelect && record.selections?.[question.id]?.length ? record.selections[question.id] : [record.answers[question.id] || ''] }]));
          await window.api.respondNativeInput({ roomId, messageId: record.messageId, requestId: record.requestId, answers });
          pending.delete(key); form.remove();
        } catch (e) { error.textContent = e.message; send.disabled = false; }
      };
      container.append(form);
    }
  }
  function event(record) {
    if (!['input_request', 'input_resolved', 'run_update'].includes(record.kind)) return;
    if (record.kind === 'input_request') {
      const key = record.messageId + ':' + record.requestId;
      pending.set(key, { ...pending.get(key), ...record, answers: pending.get(key)?.answers || {} });
    }
    if (record.kind === 'input_resolved') pending.delete(record.messageId + ':' + record.requestId);
    if (record.kind === 'run_update' && !['running', 'stopping'].includes(record.run.status)) {
      for (const [key, value] of pending) if (value.roomId === record.roomId && value.status !== 'deferred') pending.delete(key);
    }
    render(record.roomId);
  }
  return { render, event };
})();
