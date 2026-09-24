'use strict';

// Modes belong to conversation drafts, never to shared member definitions.
const ComposerModeUI = (() => {
  const modes = new Map();
  const get = roomId => modes.get(roomId) || (ACTIVE_RUN.has(runByRoom.get(roomId)?.status) ? runByRoom.get(roomId).mode : null) || 'chat';
  function set(roomId, mode) {
    if (!roomId || !['chat', 'plan', 'goal'].includes(mode)) return;
    if (mode === 'chat') modes.delete(roomId); else modes.set(roomId, mode);
    sync();
  }
  function prepare(roomId, text, editor) {
    const match = text.match(/^\/(plan|goal)(?:\s+|$)/);
    if (match) {
      set(roomId, match[1]);
      // Preserve mention/skill spans after the command instead of rebuilding text.
      const offset = editor.value.indexOf('/' + match[1]);
      editor.select(offset, offset + match[0].length);
      editor.insertText('');
      text = editor.value.trim();
    }
    return { text, mode: get(roomId) };
  }
  function view(roomId, text) {
    const room = state.rooms.find(item => item.id === roomId);
    const mode = get(roomId);
    if (!room || mode === 'chat') return { mode, targets: [], notice: '' };
    const bots = roomMembers(room);
    const resolved = ConversationMode.resolveModeTargets({ mode, text, bots, room });
    const targets = resolved.targets;
    const unsupported = targets.filter(bot => !['codex', 'claude'].includes(bot.cliType));
    const notice = unsupported.length ? I18n.tpl`${unsupported.map(bot => bot.name).join('、')} 尚不支持原生${mode === 'goal' ? I18n.t('目标') : I18n.t('计划')}模式，请调整 @ 成员。`
      : mode === 'goal' ? [targets.some(bot => bot.cliType === 'codex') ? I18n.t('Codex 目标会话保存在 Codex 历史中。') : '',
        targets.some(bot => bot.cliType === 'claude') ? I18n.t('Claude 使用原生目标停止检查。') : ''].filter(Boolean).join(' ') : '';
    return { mode, targets, notice };
  }
  function render(host, roomId, editor) {
    if (!host || !editor) return;
    const { mode, targets, notice } = view(roomId, editor.value);
    host.replaceChildren(); host.hidden = mode === 'chat';
    const toolbar = host.parentElement.querySelector('.composer-toolbar');
    if (toolbar) toolbar.hidden = mode !== 'chat';
    if (host.hidden) return;
    const chip = document.createElement('span'); chip.className = 'mode-chip';
    const label = document.createElement('span'); I18n.write(label, () => mode === 'plan' ? I18n.t('◇ 计划') : I18n.t('◎ 目标'));
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'mode-cancel';
    cancel.textContent = '×'; I18n.write(cancel, () => cancel.ariaLabel = I18n.t('退出模式'), 'title');
    cancel.onclick = async () => {
      cancel.disabled = true;
      try {
        if (ACTIVE_RUN.has(runByRoom.get(roomId)?.status)) await window.api.stopRun(roomId);
        set(roomId, 'chat');
        if (editor.roomId === roomId) editor.focus();
      } catch (error) { cancel.disabled = false; await AppDialog.alert(error.message); }
    };
    chip.append(label, cancel);
    const recipients = document.createElement('span'); recipients.className = 'mode-recipients';
    I18n.write(recipients, () => targets.length ? I18n.tpl`接收：${targets.map(bot => bot.name).join('、')}` : I18n.t('请 @ 一位已启用的成员'));
    I18n.write(recipients, () => I18n.t('输入 @ 可调整本次接收成员'), 'title');
    host.append(chip, recipients);
    if (notice) { const hint = document.createElement('span'); hint.className = 'mode-notice'; hint.textContent = notice; host.append(hint); }
  }
  function sync() {
    if (typeof composer !== 'undefined') render(document.getElementById('composerMode'), state.currentRoomId, composer);
    if (typeof SideChatUI !== 'undefined') render(document.getElementById('sideChatMode'), SideChatUI.getRoom()?.id, SideChatUI.composer);
  }
  return { get, set, prepare, view, sync };
})();

const WorkspaceUI = {
  path(room) { return room?.cwd || state.settings.defaultCwd || state.defaultCwd || ''; },
  render(button, room) {
    if (!button) return;
    const path = this.path(room);
    I18n.write(button, () => `▱ ${path || I18n.t('工作目录')}`);
    button.title = path; I18n.write(button, () => I18n.tpl`打开工作目录：${path}`, 'ariaLabel'); button.disabled = !room;
    button.onclick = () => window.api.openRoomDirectory(room.id).catch(error => AppDialog.alert(error.message));
  },
  empty(container, side = false) {
    const empty = document.createElement('div'); empty.className = 'chat-empty';
    const mark = document.createElement('div'); mark.className = 'chat-empty-mark';
    const logo = document.createElement('img'); logo.src = 'assets/convoke.png'; logo.alt = ''; mark.append(logo);
    const title = document.createElement('h2'); I18n.write(title, () => side ? I18n.t('从另一个角度开始') : I18n.t('让想法在这里汇合'));
    const hint = document.createElement('p'); I18n.write(hint, () => side ? I18n.t('独立的成员与对话，共享项目目录。') : I18n.t('@ 选择成员，或用 /plan 与 /goal 专注推进。'));
    empty.append(mark, title, hint); container.append(empty);
  },
};
