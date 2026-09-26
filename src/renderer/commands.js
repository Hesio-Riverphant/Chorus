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
function skillSourceRoot(value) {
  const parts = String(value || '').split(String.fromCharCode(92)).join('/').split('/');
  return parts.find(part => /^\.[a-z][a-z0-9_-]*$/i.test(part)) || I18n.t('本地');
}
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
      const sourceRoots = [...new Set([...(previous?.sourceRoots || []), skillSourceRoot(skill.sourcePath)])];
      const sourcePaths = [...new Set([...(previous?.sourcePaths || []), skill.sourcePath].filter(Boolean))];
      skills.set(key, { ...skill, name, cliTypes, searchText, sourceRoots, sourcePaths,
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
  const SKIP_ANSWER = '__chorus_skip__';
  const pending = new Map();
  const attr = (element, name, value) => element.setAttribute?.(name, value);
  function render(roomId) {
    const container = roomId === state.currentRoomId ? document.getElementById('messages')
      : SideChatUI.getRoom()?.id === roomId ? document.getElementById('sideChatMessages') : null;
    if (!container) return;
    if (state.rooms.find(room => room.id === roomId)?.archivedAt) {
      container.querySelectorAll('.native-question').forEach(form => form.remove()); return;
    }
    for (const message of messages(roomId)) for (const input of message.deferredInputs || []) {
      const key = message.id + ':' + input.requestId;
      if (input.status === 'deferred' && !message.supersededBy && !pending.has(key)) pending.set(key, { ...input, roomId,
        messageId: message.id, botId: message.authorId, answers: {} });
      else if (input.status !== 'deferred' || message.supersededBy) pending.delete(key);
    }
    const existing = new Map();
    for (const form of container.querySelectorAll('.native-question')) {
      if (!pending.has(form.requestKey)) form.remove(); else existing.set(form.requestKey, form);
    }
    for (const [key, record] of pending) {
      if (record.roomId !== roomId) continue;
      const previousForm = existing.get(key);
      // Keep focused inputs and their selection alive during unrelated updates.
      if (previousForm && previousForm.requestStatus === record.status) continue;
      previousForm?.remove();
      const form = document.createElement('form'); form.className = 'native-question native-question-dialog';
      form.requestKey = key; form.requestStatus = record.status; form.noValidate = true;
      attr(form, 'role', 'dialog'); attr(form, 'aria-modal', 'false');
      const heading = document.createElement('strong');
      heading.id = 'native-question-title-' + record.messageId + '-' + record.requestId;
      attr(form, 'aria-labelledby', heading.id);
      const name = (roomMembers(state.rooms.find(room => room.id === record.roomId)).find(bot => bot.id === record.botId) || state.bots.find(bot => bot.id === record.botId))?.name || I18n.t('成员');
      I18n.write(heading, () => record.type === 'approval' ? name + ' · ' + I18n.t('请求授权') : I18n.t('问题'));
      heading.title = name;
      const header = document.createElement('div'); header.className = 'native-question-header';
      const icon = document.createElement('span'); icon.className = 'native-question-icon'; icon.textContent = '?'; attr(icon, 'aria-hidden', 'true');
      header.append(icon, heading); form.append(header);
      if (record.type === 'approval') {
        const detail = document.createElement('pre'); detail.textContent = record.detail || ''; form.append(detail);
        const hint = document.createElement('p'); hint.className = 'hint';
        I18n.write(hint, () => I18n.t('始终允许仅适用于本次原生会话；超时自动拒绝。')); form.append(hint);
        const error = document.createElement('p'); error.className = 'hint'; attr(error, 'role', 'alert');
        for (const decision of record.decisions || []) {
          const button = document.createElement('button'); button.type = 'button'; button.className = 'ghost-btn';
          I18n.write(button, () => I18n.t(({ accept: '允许一次', acceptForSession: '本次会话始终允许', decline: '拒绝' })[decision] || decision));
          button.onclick = async () => {
            if (record.submitting) return; record.submitting = true;
            form.querySelectorAll('button').forEach(value => { value.disabled = true; });
            try { await window.api.respondNativeInput({ roomId, messageId: record.messageId, requestId: record.requestId, answers: { decision } }); pending.delete(key); form.remove(); }
            catch (e) { error.textContent = e.message; record.submitting = false; form.querySelectorAll('button').forEach(value => { value.disabled = false; }); }
          };
          form.append(button);
        }
        form.append(error); container.append(form); continue;
      }
      const questions = Array.isArray(record.questions) ? record.questions : [];
      record.page = Math.max(0, Math.min(Number(record.page) || 0, Math.max(0, questions.length - 1)));
      record.selections ||= {}; record.answers ||= {};
      const rebuild = () => { form.remove(); render(roomId); };
      const pager = document.createElement('div'); pager.className = 'native-question-pager';
      const previous = document.createElement('button'); previous.type = 'button'; previous.className = 'native-question-nav'; previous.textContent = '‹';
      I18n.attr(previous, 'aria-label', () => I18n.t('上一个')); previous.disabled = record.page === 0;
      const pageLabel = document.createElement('span'); pageLabel.className = 'native-question-page';
      pageLabel.textContent = (record.page + 1) + ' of ' + questions.length;
      const next = document.createElement('button'); next.type = 'button'; next.className = 'native-question-nav'; next.textContent = '›';
      I18n.attr(next, 'aria-label', () => I18n.t('下一个')); next.disabled = record.page >= questions.length - 1;
      previous.onclick = () => { record.page -= 1; rebuild(); };
      next.onclick = () => { record.page += 1; rebuild(); };
      const close = document.createElement('button'); close.type = 'button'; close.className = 'native-question-close'; close.textContent = '×';
      I18n.attr(close, 'aria-label', () => I18n.t('暂时收起问题'));
      close.onclick = () => { record.collapsed = true; rebuild(); };
      pager.append(previous, pageLabel, next, close); header.append(pager);
      if (record.status === 'deferred') {
        const hint = document.createElement('p'); hint.className = 'hint';
        I18n.write(hint, () => I18n.t('等待已结束。回答后将新建一次续接调用，并核对之前的执行结果。')); form.append(hint);
      }
      if (record.collapsed || record.status === 'deferred' && !record.expanded) {
        const reopen = document.createElement('button'); reopen.type = 'button'; reopen.className = 'ghost-btn';
        I18n.write(reopen, () => I18n.t('回答问题'));
        reopen.onclick = () => { record.collapsed = false; record.expanded = true; rebuild(); };
        form.append(reopen); container.append(form); continue;
      }
      const question = questions[record.page];
      if (!question) continue;
      const fields = document.createElement('div'); fields.className = 'native-question-fields';
      const title = document.createElement('strong'); title.className = 'native-question-title';
      title.id = heading.id + '-prompt'; title.textContent = question.question || question.header; fields.append(title);
      const choices = document.createElement('div'); choices.className = 'native-question-choices'; fields.append(choices);
      const footer = document.createElement('div'); footer.className = 'native-question-footer';
      const edit = document.createElement('span'); edit.className = 'native-question-edit'; edit.textContent = '✎'; attr(edit, 'aria-hidden', 'true');
      const input = document.createElement('input'); input.name = question.id; input.value = record.answers[question.id] || '';
      input.readOnly = question.optionOnly === true; attr(input, 'aria-labelledby', title.id);
      I18n.attr(input, 'placeholder', () => question.optionOnly ? I18n.t('请选择提供的选项') : I18n.t('或自行撰写回复'));
      const syncChoices = () => {
        for (const button of choices.querySelectorAll('button')) attr(button, 'aria-pressed', String(question.multiSelect
          ? (record.selections[question.id] || []).includes(button.optionLabel) : record.answers[question.id] === button.optionLabel));
      };
      for (const [index, option] of (question.options || []).entries()) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'native-question-choice';
        button.optionLabel = option.label; button.title = option.description || '';
        const number = document.createElement('span'); number.className = 'native-question-number'; number.textContent = String(index + 1); attr(number, 'aria-hidden', 'true');
        const label = document.createElement('span'); label.className = 'native-question-label'; label.textContent = option.label;
        const arrow = document.createElement('span'); arrow.className = 'native-question-arrow'; arrow.textContent = '→'; attr(arrow, 'aria-hidden', 'true');
        button.append(number, label, arrow);
        button.onclick = () => {
          if (question.multiSelect) {
            const selected = record.selections[question.id] || [];
            record.selections[question.id] = selected.includes(option.label) ? selected.filter(value => value !== option.label) : [...selected, option.label];
            input.value = record.selections[question.id].join(', ');
          } else input.value = option.label;
          record.answers[question.id] = input.value; syncChoices(); syncSend();
        };
        choices.append(button);
      }
      const actions = document.createElement('div'); actions.className = 'native-question-actions';
      const skip = document.createElement('button'); skip.type = 'button'; skip.className = 'ghost-btn native-question-skip'; I18n.write(skip, () => I18n.t('跳过'));
      const send = document.createElement('button'); send.type = 'submit'; send.className = 'primary-btn native-question-send'; I18n.write(send, () => I18n.t('发送'));
      const error = document.createElement('p'); error.className = 'hint'; attr(error, 'role', 'alert');
      const syncSend = () => { send.disabled = !input.value.trim() || !!record.submitting; };
      input.oninput = () => { record.answers[question.id] = input.value; record.selections[question.id] = []; syncChoices(); syncSend(); };
      actions.append(skip, send); footer.append(edit, input, actions); form.append(fields, footer, error);
      syncChoices(); syncSend();
      const submit = async (skipAll = false) => {
        if (record.submitting) return;
        if (!skipAll) {
          const missing = questions.findIndex(item => !String(record.answers[item.id] || '').trim());
          if (missing >= 0) { record.page = missing; rebuild(); return; }
        }
        record.submitting = true;
        form.querySelectorAll('button').forEach(button => { button.disabled = true; }); input.disabled = true;
        try {
          const answers = Object.fromEntries(questions.map(item => [item.id, { answers: skipAll ? [SKIP_ANSWER] :
            (item.multiSelect && record.selections[item.id]?.length ? record.selections[item.id] : [record.answers[item.id]]) }]));
          await window.api.respondNativeInput({ roomId, messageId: record.messageId, requestId: record.requestId, answers });
          pending.delete(key); form.remove();
        } catch (e) {
          error.textContent = e.message; record.submitting = false; input.disabled = false;
          form.querySelectorAll('button').forEach(button => { button.disabled = false; });
          previous.disabled = record.page === 0; next.disabled = record.page >= questions.length - 1; syncSend();
        }
      };
      skip.onclick = () => submit(true);
      form.onsubmit = async event => { event.preventDefault(); await submit(false); };
      container.append(form);
    }
  }
  function event(record) {
    if (!['input_request', 'input_resolved', 'run_update'].includes(record.kind)) return;
    if (record.kind === 'input_request') {
      const key = record.messageId + ':' + record.requestId;
      const current = pending.get(key);
      if (current) Object.assign(current, record);
      else pending.set(key, { ...record, answers: {} });
    }
    if (record.kind === 'input_resolved') pending.delete(record.messageId + ':' + record.requestId);
    if (record.kind === 'run_update' && !['running', 'stopping'].includes(record.run.status)) {
      for (const [key, value] of pending) if (value.roomId === record.roomId && value.status !== 'deferred') pending.delete(key);
    }
    render(record.roomId);
  }
  return { render, event };
})();
