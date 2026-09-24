'use strict';
let botConnectionTest = null;
function cancelBotEditorTest() {
  const operation = botConnectionTest;
  if (operation) { botConnectionTest = null; window.api.cancelBotConnectionTest(operation.payload).catch(() => {}); }
  $('#botTestBtn').disabled = false; $('#botTestCancel').hidden = true;
}


const CLI_AVATARS = {
  claude: ['Claude Code', 'claude', 'CC'], codex: ['Codex', 'codex', 'CX'], kimi: ['Kimi Code', 'kimi', 'K'],
  codebuddy: ['CodeBuddy', 'codebuddy', 'CB'], gemini: ['Gemini CLI', 'gemini', 'G'], qwen: ['Qwen Code', 'qwen', 'Q'],
  copilot: ['GitHub Copilot', 'githubcopilot', 'GH'], cursor: ['Cursor Agent', 'cursor', 'CU'],
  opencode: ['OpenCode', 'opencode', 'OC'], zcode: ['ZCode', 'zai', 'Z'],
  droid: ['Factory Droid', '', 'FD'], pi: ['Pi', '', 'π'], hermes: ['Hermes', '', 'H'],
};
function avatarHtml(bot) {
  const [label, icon, initials] = CLI_AVATARS[bot.cliType] ||
    [state.cliProfiles?.find(profile => profile.id === bot.cliType)?.label || 'CLI', '', 'CLI'];
  const fallback = `<span class="avatar-fallback">${esc(initials === 'CLI' && label !== 'CLI' ? Array.from(label).slice(0, 2).join('') : initials)}</span>`;
  const image = (source, title, cls = '') => `<span class="avatar provider-avatar ${cls}" title="${esc(title)}">${fallback}<img class="avatar-brand-image" src="${esc(source)}" alt="${esc(title)}" /></span>`;
  const avatar = bot.avatar;
  if (avatar?.type === 'text') return avatar.text?.trim()
    ? `<span class="avatar text-avatar">${esc(avatar.text)}</span>`
    : image('assets/deepseek.svg', I18n.t('小彩蛋'), 'avatar-easter-egg');
  if (avatar?.type === 'image') return avatar.dataUrl && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(avatar.dataUrl)
    ? image(avatar.dataUrl, bot.name || label, 'custom-avatar')
    : `<span class="avatar text-avatar" title="${esc(label)}">${fallback}</span>`;
  // Legacy fixed-provider choices now follow the selected CLI as well.
  return icon ? image(`assets/${icon}.svg`, label)
    : `<span class="avatar text-avatar" title="${esc(label)}">${fallback}</span>`;
}

function displayMembers(room) {
  const order = room?.memberDisplayOrder || [];
  return roomMembers(room).sort((a, b) => {
    const ai = order.indexOf(a.id), bi = order.indexOf(b.id);
    return (ai < 0 ? order.length : ai) - (bi < 0 ? order.length : bi);
  });
}

const memberGestures = new Set();
let memberOrderSaving = false;
let memberDragRoomId = null;

function memberOrderInteractionActive(roomId) {
  return memberDragRoomId != null && memberDragRoomId === roomId;
}
function cancelMemberGestures() {
  for (const cancel of memberGestures) cancel();
  memberGestures.clear();
}

async function saveDisplayOrder(room, ids) {
  if (memberOrderSaving) return;
  memberOrderSaving = true;
  try {
    const updated = await window.api.setMemberDisplayOrder({ roomId: room.id, ids });
    Object.assign(room, updated);
  } finally { memberOrderSaving = false; renderBots(); }
}

function wireMemberOrder(item, bot, room) {
  const list = item.parentElement || $('#botList');
  const scroller = list.closest('.side-section') || list;
  let timer, frame, dragging = false, start, destination = null, after = false, pointerY = 0;
  const clearIndicator = () => {
    destination?.classList.remove('member-drop-before', 'member-drop-after');
    destination = null;
  };
  const clean = () => {
    clearTimeout(timer); cancelAnimationFrame(frame); frame = null;
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', release, true);
    document.removeEventListener('pointercancel', cancel, true);
    clearIndicator();
    const pointerId = start?.id;
    start = null; dragging = false;
    if (memberDragRoomId === room.id) memberDragRoomId = null;
    item.classList.remove('dragging'); list.classList.remove('member-reordering');
    item.setAttribute('aria-grabbed', 'false');
    if (pointerId != null && item.hasPointerCapture(pointerId)) item.releasePointerCapture(pointerId);
  };
  const locate = () => {
    clearIndicator();
    const rows = [...list.querySelectorAll('.bot-item')].filter((row) => row !== item);
    if (!rows.length) return;
    destination = rows.find((row) => {
      const rect = row.getBoundingClientRect();
      return pointerY < rect.top + rect.height / 2;
    }) || rows.at(-1);
    after = pointerY >= destination.getBoundingClientRect().top + destination.getBoundingClientRect().height / 2;
    destination.classList.add(after ? 'member-drop-after' : 'member-drop-before');
  };
  const scroll = () => {
    if (!dragging) return;
    const rect = scroller.getBoundingClientRect();
    const distance = pointerY < rect.top + 32 ? pointerY - rect.top - 32
      : pointerY > rect.bottom - 32 ? pointerY - rect.bottom + 32 : 0;
    if (distance) { scroller.scrollTop += Math.max(-12, Math.min(12, distance / 3)); locate(); }
    frame = requestAnimationFrame(scroll);
  };
  const begin = () => {
    if (!start || memberOrderSaving) return;
    clearTimeout(timer); dragging = true; item.dataset.dragged = 'true';
    memberDragRoomId = room.id;
    item.classList.add('dragging'); list.classList.add('member-reordering');
    item.setAttribute('aria-grabbed', 'true'); item.setPointerCapture(start.id);
    locate(); frame = requestAnimationFrame(scroll);
  };
  memberGestures.add(clean);
  // Handle touch scrolling before the hold threshold ourselves so the browser
  // cannot cancel an already-started long-press reorder with a native pan.
  item.style.touchAction = 'none';
  I18n.write(item, () => I18n.t('拖动调整显示顺序；也可按 Alt + ↑ / ↓'), 'title');
  item.addEventListener('click', (event) => {
    if (item.dataset.dragged) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  item.addEventListener('keydown', async (event) => {
    if (event.key === 'Escape' && start) { event.preventDefault(); event.stopPropagation(); clean(); renderBots(); return; }
    if (memberOrderSaving || dragging) return;
    if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
      event.preventDefault();
      const ids = displayMembers(room).map((member) => member.id);
      const from = ids.indexOf(bot.id), to = from + (event.key === 'ArrowUp' ? -1 : 1);
      if (to < 0 || to >= ids.length) return;
      [ids[from], ids[to]] = [ids[to], ids[from]];
      await saveDisplayOrder(room, ids);
      $('#botList').querySelector(`[data-bot-id="${CSS.escape(bot.id)}"]`)?.focus();
    } else if (event.target === item && event.key === 'Enter') openBotEdit(bot);
  });
  item.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.isPrimary === false || event.target.closest('button') || memberOrderSaving) return;
    clean(); delete item.dataset.dragged;
    start = { x: event.clientX, y: event.clientY, id: event.pointerId, touch: event.pointerType === 'touch' };
    // Electron can deliver pointerup to the row under the cursor despite
    // pointer capture. Listen for the active pointer across the document.
    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', cancel, true);
    memberDragRoomId = room.id;
    pointerY = event.clientY;
    if (start.touch) { item.setPointerCapture(event.pointerId); timer = setTimeout(begin, 400); }
    else { event.preventDefault(); item.focus(); item.setPointerCapture(event.pointerId); }
  });
  const move = (event) => {
    if (!start || event.pointerId !== start.id) return;
    pointerY = event.clientY;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (start.touch && !dragging && (start.scrolling || distance >= 8)) {
      clearTimeout(timer); start.scrolling = true; item.dataset.dragged = 'true';
      scroller.scrollTop -= event.clientY - (start.lastY ?? start.y);
      start.lastY = event.clientY; event.preventDefault(); return;
    }
    if (!dragging && distance >= (start.touch ? 8 : 5)) {
      begin();
    }
    if (!dragging) return;
    event.preventDefault();
    locate();
  };
  item.addEventListener('pointerleave', () => { if (start?.touch && !dragging) clean(); });
  const release = async (event) => {
    if (!start || event.pointerId !== start.id) return;
    pointerY = event.clientY;
    if (dragging) locate();
    const moved = dragging;
    const target = destination, insertAfter = after;
    clean();
    if (!moved || !target) return;
    list.insertBefore(item, insertAfter ? target.nextSibling : target);
    const ids = [...list.querySelectorAll('.bot-item')].map((row) => row.dataset.botId);
    if (ids.join('\0') === displayMembers(room).map((member) => member.id).join('\0')) { renderBots(); return; }
    await saveDisplayOrder(room, ids);
  };
  const cancel = (event) => {
    if (!start || event.pointerId !== start.id) return;
    clean(); renderBots();
  };
  item.addEventListener('lostpointercapture', () => { if (start) { clean(); renderBots(); } });
  item.addEventListener('contextmenu', (event) => { if (dragging) event.preventDefault(); });
}

function populateBotProfile(bot) {
  const select = $('#f_rolePreset');
  select.innerHTML = window.BotProfile.ROLE_PRESETS.map((role) =>
    `<option value="${esc(role.value)}">${esc(I18n.t(role.label))}</option>`).join('') + I18n.t('<option value="__custom__">自定义</option>');
  const match = !bot.customRole && (window.BotProfile.ROLE_PRESETS.find((role) => role.value === (bot.role || '')) ||
    (!bot.id && !bot.role ? window.BotProfile.ROLE_PRESETS.find((role) => role.label === '协作者') || window.BotProfile.ROLE_PRESETS[0] : null));
  select.value = match ? match.value : '__custom__';
  $('#f_role').value = bot.role || '';
  $('#f_role').hidden = select.value !== '__custom__';
  const avatar = bot.avatar;
  state.botRoleEdited = false;
  $('#f_avatarType').value = avatar?.type === 'text' || avatar?.type === 'image' ? avatar.type
    : bot.cliType?.startsWith('custom_') ? 'image' : 'default';
  $('#f_avatarText').value = avatar?.text || '';
  state.avatarDataUrl = avatar?.dataUrl || '';
  $('#botTestResult').textContent = '';
  $('#f_error').hidden = true;
}

function selectedRole() {
  return $('#f_rolePreset').value === '__custom__' ? $('#f_role').value.trim() : $('#f_rolePreset').value;
}

function updatePersonaPlaceholder() {
  const custom = $('#f_rolePreset').value === '__custom__';
  $('#f_role').hidden = !custom;
  const defaultPersona = window.BotProfile.getDefaultPersona(selectedRole(), custom);
  $('#f_persona').placeholder = custom ? defaultPersona : I18n.t(defaultPersona);
  I18n.write($('#f_personaLabel'), () => custom ? I18n.t('人设') : I18n.t('人设（留空采用角色预设）'));
}

function selectedAvatar() {
  const type = $('#f_avatarType').value;
  if (type === 'text') return { type, text: $('#f_avatarText').value.trim() };
  if (type === 'image') return { type, dataUrl: state.avatarDataUrl || '' };
  return null;
}

function renderAvatarPreview() {
  $('#f_avatarText').hidden = $('#f_avatarType').value !== 'text';
  $('#f_avatarPick').hidden = $('#f_avatarType').value !== 'image';
  $('#f_avatarEasterEgg').hidden = !($('#f_avatarType').value === 'text' && !$('#f_avatarText').value.trim());
  $('#f_avatarPreview').innerHTML = avatarHtml({ name: $('#f_name').value || I18n.t('预览'), cliType: $('#f_cliType').value, avatar: selectedAvatar() });
}

function syncPermissionChoices() {
  const cli = $('#f_cliType').value;
  const custom = cli.startsWith('custom_');
  $('#f_perm').hidden = custom;
  $('#nativePermissionNotice').hidden = !custom && cli !== 'kimi';
  I18n.write($('#nativePermissionNotice'), () => cli === 'kimi' ? I18n.t('Kimi 无交互模式会自动执行工具，请明确选择全权限。连接测试不会启动工具。') : I18n.t('此 CLI 使用原生工具权限；请在原生配置中管理。'));
  const labels = { read_only: [I18n.t('只读'), I18n.t('向 CLI 请求只读权限')], workspace: [I18n.t('工作区可写'), I18n.t('向 CLI 请求工作区写入权限')], full: [I18n.t('全权限'), I18n.t('允许原生 Agent 自动执行操作')] };
  for (const radio of $$('input[name="f_permRadio"]')) {
    const unsupported = (cli === 'kimi' && radio.value !== 'full') || (['pi', 'hermes'].includes(cli) && radio.value === 'workspace');
    const label = radio.closest('label'); label.hidden = unsupported; radio.disabled = custom || unsupported;
    label.querySelector('b').textContent = labels[radio.value][0];
    label.querySelector('small').textContent = labels[radio.value][1];
  }
  if (!$('input[name="f_permRadio"]:checked:not(:disabled)') && !custom && cli !== 'kimi') {
    $('input[name="f_permRadio"]:not(:disabled)').checked = true;
  }
}

function botFormPayload() {
  if (!$('#f_cliType').value) throw new Error(I18n.t('请先在设置中启用 Agent'));
  if ($('#f_cliType').value === 'kimi' && !$('input[name="f_permRadio"][value="full"]:checked')) throw new Error(I18n.t('Kimi 无交互模式会自动执行工具，请明确选择全权限'));
  ModelPicker.validate();
  const avatar = selectedAvatar();
  const payload = {
    ...ModelPicker.values(),
    name: $('#f_name').value.trim(), role: selectedRole(), customRole: $('#f_rolePreset').value === '__custom__', cliType: $('#f_cliType').value,
    model: $('#f_model').value.trim(), cwd: $('#f_cwd').value.trim(), persona: $('#f_persona').value,
    permissionMode: $('input[name="f_permRadio"]:checked')?.value || 'workspace',
    enabled: $('#f_enabled').checked, avatar,
  };
  if (state.editingBotId) payload.id = state.editingBotId;
  return payload;
}

function updateBotDirectoryHint() {
  const room = state.rooms.find(item => item.id === state.editingBotRoomId);
  const local = RoomProfiles.isLocal(room);
  const directory = (!local && $('#f_cwd').value.trim()) || room?.cwd || state.settings.defaultCwd || state.defaultCwd || '';
  const hint = $('#botEffectiveCwd');
  if (hint) I18n.write(hint, () => local ? I18n.tpl`实际工作目录：${directory}。侧聊成员使用侧聊的工作目录。`
    : room ? I18n.tpl`实际工作目录：${directory}。优先顺序：成员目录 → 房间目录 → 设置中的默认目录 → 应用目录。`
    : I18n.t('优先顺序：成员目录 → 运行所在房间目录 → 设置中的默认目录 → 应用目录。'));
}

function wireBotProfile() {
  $('#f_cwd').addEventListener('input', updateBotDirectoryHint);
  $('#f_rolePreset').addEventListener('change', () => {
    state.botRoleEdited = true;
    if (!$('#f_moderator').disabled) $('#f_moderator').checked = selectedRole() === '主持人';
    updatePersonaPlaceholder();
  });
  $('#f_moderator').addEventListener('change', () => {
    state.botRoleEdited = false;
    $('#f_rolePreset').value = $('#f_moderator').checked ? '主持人' : '协作者';
    $('#f_role').value = $('#f_rolePreset').value;
    updatePersonaPlaceholder();
  });
  $('#f_role').addEventListener('input', () => { state.botRoleEdited = true; updatePersonaPlaceholder(); });
  $('#f_avatarType').addEventListener('change', renderAvatarPreview);
  $('#f_avatarText').addEventListener('input', renderAvatarPreview);
  $('#f_cliType').addEventListener('change', () => {
    if ($('#f_cliType').value.startsWith('custom_') && $('#f_avatarType').value === 'default') $('#f_avatarType').value = 'image';
    renderAvatarPreview();
  });
  document.addEventListener('error', event => {
    if (event.target?.classList?.contains('avatar-brand-image')) event.target.remove();
  }, true);
  $('#f_avatarPick').addEventListener('click', async () => {
    const data = await window.api.pickAvatar();
    if (data) { state.avatarDataUrl = data; renderAvatarPreview(); }
    $('#f_avatarPick').focus();
  });
  $('#botTestBtn').addEventListener('click', async () => {
    const button = $('#botTestBtn'), editVersion = botEditVersion;
    button.disabled = true;
    let operation;
    try {
      ModelPicker.validate();
      const payload = { cliType: $('#f_cliType').value, model: $('#f_model').value.trim(), ...ModelPicker.values() };
      if (!await AppDialog.confirm(I18n.t('测试会使用此 CLI 的现有登录态发出一次最小真实模型请求，可能产生少量费用。继续？')) || editVersion !== botEditVersion) return;
      operation = { payload, editVersion }; botConnectionTest = operation;
      I18n.write($('#botTestResult'), () => I18n.t('正在测试…')); $('#botTestCancel').hidden = false;
      const result = await window.api.testBotConnection({ ...payload, confirmed: true });
      if (botConnectionTest === operation && editVersion === botEditVersion) I18n.write($('#botTestResult'), () => I18n.tpl`${result.ok ? result.transport === 'provider-api' ? I18n.t('模型连接成功') : I18n.t('连接成功') : I18n.t('连接失败：') + result.detail} · ${(result.elapsedMs / 1000).toFixed(1)} 秒`);
    } catch (error) {
      if (editVersion === botEditVersion && (!operation || botConnectionTest === operation)) I18n.write($('#botTestResult'), () => I18n.tpl`测试失败：${error.message || error}`);
    } finally {
      if (botConnectionTest === operation) botConnectionTest = null;
      if (editVersion === botEditVersion && !botConnectionTest) { button.disabled = false; $('#botTestCancel').hidden = true; }
    }
  });
  $('#botTestCancel').addEventListener('click', () => { cancelBotEditorTest(); I18n.write($('#botTestResult'), () => I18n.t('测试已取消')); });
}
