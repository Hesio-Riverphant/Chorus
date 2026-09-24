'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const state = {
  bots: [],
  rooms: [],
  settings: {},
  cliProfiles: [],
  defaults: {},
  dataByRoom: {},
  dataPath: '',
  currentRoomId: null,
  editingBotId: null,
  editingBotRoomId: null,
  addMemberRoomId: null,
  editingRoomId: null,
  mention: null,
  slash: null,
};

const runByRoom = new Map();
const ACTIVE_RUN = new Set(['running', 'stopping']);
const sendingRooms = new Map();
let botEditVersion = 0, settingsEditVersion = 0;
let botSaving = false, settingsSaving = false;
const composer = new window.RoomComposer($('#input'));

// An IPC rejection must remain visible instead of silently losing an action.
window.addEventListener('unhandledrejection', (event) => {
  event.preventDefault();
  AppDialog.alert((event.reason && event.reason.message) || String(event.reason));
});

// ---------- utils ----------

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n) {
  n = Number(n) || 0;
  if (n >= 1000) return (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'K';
  return String(n);
}

function fmtTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function colorFor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 62%, 46%)`;
}

function richText(text) {
  let html = esc(text);
  const names = state.bots.map((b) => b.name).concat(['全体', 'all']);
  names.sort((a, b) => b.length - a.length);
  // Boundaries mirror src/shared/mention, plus HTML-escaped forms (&quot;, &lt;).
  const end = '\\s，。,.!?！？、；：、()（）\\[\\]【】&quot;';
  for (const name of names) {
    const safe = esc(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(
      new RegExp(`(^|\\s)@${safe}(?=$|[${end}]|&lt;)`, 'gm'),
      (m) => `<span class="at">${m}</span>`,
    );
  }
  return html.replace(/\n/g, '<br>');
}

function usageText(u, costInfo) {
  if (!u) return '';
  const counter = (value, estimated) => Number.isSafeInteger(value) && value >= 0 ? `${estimated ? '≈' : ''}${fmtNum(value)}` : I18n.t('未知');
  let t = `↑${counter(u.inputTokens, u.inputEstimated)} ↓${counter(u.outputTokens, u.outputEstimated)} tok`;
  if (Number.isFinite(u.cachedInputTokens) && u.inputTokens > 0) {
    t += I18n.tpl` · 缓存 ${Math.min(100, Math.round(u.cachedInputTokens / u.inputTokens * 100))}%`;
  }
  if (u.cost != null) {
    t += u.estimated ? ` · ≈$${Number(u.cost).toFixed(4)}` : ` · $${Number(u.cost).toFixed(4)}`;
    if (costInfo?.pricing?.tier && costInfo.pricing.tier !== 'standard') t += costInfo.pricing.tier === 'offPeak' ? I18n.t('（空闲价）') : I18n.t('（高峰价）');
  } else if (costInfo?.reason) {
    t += ` · ${esc(I18n.t(costInfo.reason))}`;
  }
  return t;
}

function messages(roomId) {
  if (!state.dataByRoom[roomId]) state.dataByRoom[roomId] = [];
  return state.dataByRoom[roomId];
}

function currentRoom() {
  return state.rooms.find((r) => r.id === state.currentRoomId) || null;
}

// Independent members of a room projected from global bot definitions.
function roomMembers(room) {
  if (!room) return [];
  return RoomProfiles.members(room, state.bots, state.settings);
}

// ---------- rendering ----------

function renderRooms() {
  NavigationUI.render();
}

function renderBots() {
  if (memberOrderInteractionActive(state.currentRoomId)) return;
  cancelMemberGestures();
  const el = $('#botList');
  el.innerHTML = '';
  const room = currentRoom();
  // The member list reflects the current room; membership is per-room.
  for (const bot of displayMembers(room)) {
    const item = document.createElement('div');
    item.className = 'side-item bot-item';
    I18n.write(item, () => I18n.t('拖动调整显示顺序；Alt + ↑/↓ 也可排序'), 'title');
    item.innerHTML =
      avatarHtml(bot) +
      `<span class="side-item-name">${esc(bot.name)}</span>` +
      `<span class="perm-tag">${permLabel(bot.permissionMode, bot.cliType)}</span>` +
      I18n.t('<button class="row-remove" type="button" title="移出本房间">×</button>');
    item.dataset.botId = bot.id;
    item.tabIndex = 0;
    item.addEventListener('click', () => { if (!item.dataset.dragged) openBotEdit(bot); });
    wireMemberOrder(item, bot, room);
    item.querySelector('.row-remove').addEventListener('click', (ev) => {
      ev.stopPropagation();
      removeMember(room, bot);
    });
    el.appendChild(item);
  }
}

// Remove a member from a room only (the global agent profile is kept).
async function removeMember(room, bot) {
  if (!room) return;
  const botIds = (room.botIds || []).filter((id) => id !== bot.id);
  let moderatorBotId = room.moderatorBotId;
  if (moderatorBotId === bot.id) moderatorBotId = botIds[0] || '';
  const updated = await window.api.saveRoom({ ...room, botIds, moderatorBotId });
  Object.assign(room, updated);
  renderBots();
  renderTopbar();
  renderRooms(); SideChatUI.refresh();
}

function permLabel(mode, cliType) {
  if (cliType?.startsWith('custom_')) return I18n.t('原生');
  if (cliType === 'kimi') return mode === 'full' ? I18n.t('自动') : I18n.t('原生');
  if (mode === 'read_only') return I18n.t('只读');
  if (mode === 'full') return I18n.t('全权');
  return I18n.t('可写');
}

function renderTopbar() {
  const room = currentRoom();
  I18n.write($('#roomName'), () => room ? room.name : I18n.t('无房间'));
  const members = roomMembers(room);
  I18n.write($('#memberSummary'), () => members.length
    ? I18n.tpl`${members.length} 位成员`
    : I18n.t('暂无成员'));
  $('#memberSummary').title = members.map(b => b.name).join('、');
  WorkspaceUI.render($('#roomWorkspace'), room);
  SideChatUI.sync();
  window.WorkbenchUI?.sync();
}

function nearBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 100;
}

function renderMessages(scrollMode = 'bottom') {
  const wrap = $('#messages');
  const follow = scrollMode === 'bottom' || (scrollMode === 'smart' && nearBottom(wrap));
  const previousTop = wrap.scrollTop;
  rememberActivityExpansion(wrap);
  wrap.innerHTML = '';
  const list = messages(state.currentRoomId);
  if (!list.length) WorkspaceUI.empty(wrap);

  for (const m of list) {
    wrap.appendChild(bubbleEl(m));
  }
  ConversationUI.decorate(wrap, state.currentRoomId);
  // 'smart' only follows the stream when the user is already near the bottom,
  // so reading history is not interrupted by incoming messages.
  wrap.scrollTop = follow ? wrap.scrollHeight : previousTop;
  NativeInputUI.render(state.currentRoomId);
}

function bubbleEl(m) {
  const row = document.createElement('div');
  const roomId = m.roomId || state.currentRoomId;
  row.dataset.roomId = roomId;
  const isHuman = m.authorType === 'human';
  const isSystem = m.authorType === 'system';

  if (isSystem) {
    row.className = 'sys-row';
    row.dataset.msgId = m.id;
    row.innerHTML = `<div class="sys-bubble">${richText(m.i18n ? I18n.parts(m.i18n.parts, m.i18n.values) : m.text)}</div>` +
      I18n.t('<button class="msg-del" type="button" title="删除该消息">删除</button>');
    row.querySelector('.msg-del').addEventListener('click', () =>
      deleteSingleMessage(roomId, m.id));
    return row;
  }

  const bot = isHuman ? null : (roomMembers(state.rooms.find(room => room.id === m.roomId)).find(b => b.id === m.authorId) || state.bots.find(b => b.id === m.authorId));
  const name = isHuman ? I18n.t('我') : bot ? bot.name : I18n.t('未知');
  row.className =
    'msg-row ' + (isHuman ? 'mine' : 'theirs') +
    (m.status === 'error' ? ' is-error' : '') +
    (m.status === 'aborted' ? ' is-aborted' : '') +
    (m.supersededBy ? ' is-superseded' : '');
  row.dataset.msgId = m.id;

  const avatar = isHuman
    ? I18n.t('<span class="avatar human-avatar">我</span>')
    : avatarHtml(bot || { name, cliType: 'claude' });

  const stateTag =
    m.status === 'streaming' ? I18n.t('<span class="state-tag streaming">输入中…</span>')
    : m.status === 'aborted' ? I18n.t('<span class="state-tag aborted">已中断</span>')
    : m.supersededBy ? I18n.t('<span class="state-tag superseded">已更正</span>')
    : '';

  const errorBlock = m.error
    ? `<div class="error-text">${esc(m.error)}</div>` +
      I18n.html`<button class="retry-btn" type="button">重试</button>`
    : '';

  row.innerHTML =
    avatar +
    I18n.html`<div class="msg-body">
       <div class="msg-name">${esc(name)}${bot && bot.role ? ` · ${esc(bot.role)}` : ''} ${stateTag}${m.mode && m.mode !== 'chat' ? `<span class="message-mode">${m.mode === 'goal' ? I18n.t('目标') : I18n.t('计划')}</span>` : ''}</div>
       <div class="bubble">
         <div class="bubble-text">${formatMessage(m.text)}</div>
         ${errorBlock}
       </div>
       <div class="foot-row">
         ${m.usage ? `<div class="foot">${usageText(m.usage, m.costInfo)}</div>` : '<span></span>'}
         <button class="msg-del" type="button" title="删除该消息">删除</button>
       </div>
     </div>`;

  const del = row.querySelector('.msg-del');
  if (del) del.addEventListener('click', () =>
    deleteSingleMessage(roomId, m.id));
  const retry = row.querySelector('.retry-btn');
  if (retry) retry.addEventListener('click', () =>
    window.api.retryMessage({ roomId, messageId: m.id }));
  addMessageActions(row, m);
  return row;
}

// Live update of a single (streaming) bubble without rebuilding the list.
function patchBubble(roomId, msg) {
  const row = document.querySelector(`[data-msg-id="${msg.id}"]`);
  if (!row) {
    if (roomId === state.currentRoomId) renderMessages();
    return;
  }
  const wrap = $('#messages');
  const follow = nearBottom(wrap);
  const textEl = row.querySelector('.bubble-text');
  if (textEl) textEl.innerHTML = formatMessage(msg.text);
  renderActivities(row, msg.activities || []);
  if (follow) wrap.scrollTop = wrap.scrollHeight;
}

function refreshBubbleState(roomId, id) {
  const msg = messages(roomId).find((x) => x.id === id);
  if (!msg) return;
  if (roomId === state.currentRoomId) {
    const old = document.querySelector(`[data-msg-id="${id}"]`);
    if (old) {
      const replacement = bubbleEl(msg);
      const oldActivities = old.querySelector('.activities');
      const newActivities = replacement.querySelector('.activities');
      if (oldActivities && newActivities) {
        const expanded = new Set([...oldActivities.querySelectorAll('details[data-activity-id][open]')]
          .map((entry) => entry.dataset.activityId));
        newActivities.querySelectorAll('details[data-activity-id]').forEach((entry) => {
          entry.open = expanded.has(entry.dataset.activityId);
        });
      }
      old.replaceWith(replacement);
    }
    const wrap = $('#messages');
    if (nearBottom(wrap)) wrap.scrollTop = wrap.scrollHeight;
  }
}

// ---------- room switching / composer ----------

function switchRoom(roomId) {
  const selected = state.rooms.find((room) => room.id === roomId);
  if (selected?.parentRoomId && state.rooms.some((room) => room.id === selected.parentRoomId && !room.archivedAt)) {
    SideChatUI.open(roomId); return;
  }
  state.currentRoomId = roomId;
  composer.switchRoom(roomId);
  closeMention();
  closeSlash();
  closePopMenu();
  I18n.write($('#botSectionTitle'), () => currentRoom()
    ? I18n.tpl`成员 · ${currentRoom().name}` : I18n.t('当前房间成员'));
  renderRooms();
  renderBots();
  renderTopbar();
  syncComposer();
  renderMessages();
}

function syncComposer() {
  const room = currentRoom();
  if (room) {
    $$('#routeSeg .seg-btn').forEach((b) =>
      b.classList.toggle('active', b.dataset.route === room.routingMode));
    $('#speakMode').value = room.speakMode;
  }
  const run = runByRoom.get(state.currentRoomId);
  const active = run && ACTIVE_RUN.has(run.status);
  const btn = $('#actionBtn');
  const status = $('#runStatus');
  btn.disabled = !room || !!room.archivedAt;
  $('#input').contentEditable = room && !room.archivedAt ? 'true' : 'false';
  $('#allBtn').disabled = !room || !!room.archivedAt;
  $('#speakMode').disabled = !room || !!room.archivedAt;
  $$('#routeSeg .seg-btn').forEach((button) => { button.disabled = !room || !!room.archivedAt; });

  if (active) {
    btn.classList.add('stop-btn');
    btn.classList.remove('send-btn');
    I18n.write(btn, () => I18n.t('停止'));
    status.hidden = false;
    status.innerHTML =
      I18n.tpl`${run.status === 'stopping' ? I18n.t('正在停止…') : I18n.t('运行中')} · 第 ${fmtNum(run.wave)} 波 · ` +
      I18n.tpl`${run.calls} 次调用 · ~${fmtNum(run.tokens)} tok` +
      (run.cost > 0 ? ` · ≈$${run.cost.toFixed(4)}` : '');
  } else {
    btn.classList.add('send-btn');
    btn.classList.remove('stop-btn');
    I18n.write(btn, () => I18n.t('发送'));
    status.hidden = true;
  }
  ComposerModeUI.sync();
}

async function doSend() {
  const ta = $('#input');
  let text = ta.value.trim();
  const roomId = state.currentRoomId;
  if (!text || !roomId || sendingRooms.has(roomId)) return;
  if (await RoomCommands.intercept(text, roomId, composer)) return;
  const prepared = ComposerModeUI.prepare(roomId, text, composer);
  text = prepared.text;
  if (!text) return;
  const run = runByRoom.get(roomId);
  if (run && ACTIVE_RUN.has(run.status)) return;
  sendingRooms.set(roomId, text);
  syncMessageActions();
  try {
    await window.api.sendHuman({ roomId, text, mode: prepared.mode });
  } finally {
    sendingRooms.delete(roomId);
    syncMessageActions();
  }
}

// ---------- mention autocomplete ----------

function detectMention() {
  const ta = $('#input');
  const pos = ta.selectionStart;
  const upto = ta.value.slice(0, pos);
  const m = upto.match(/(^|[\s])@([^\s@]*)$/);
  if (m) {
    const query = m[2];
    const start = pos - query.length - 1;
    openMention(query, start);
  } else closeMention();
}

function openMention(query, start) {
  const q = query.toLowerCase();
  const items = [];
  if (!q || '全体'.includes(query) || 'all'.includes(q)) {
    items.push({ id: '__all__', name: I18n.language === 'en' ? 'all' : '全体', role: I18n.t('呼叫所有人') });
  }
  for (const bot of roomMembers(currentRoom())) {
    if (bot.name.toLowerCase().includes(q)) items.push(bot);
  }
  if (!items.length) return closeMention();
  state.mention = { start, items, index: 0 };
  renderMention();
}

function renderMention() {
  const box = $('#mentionBox');
  box.innerHTML = '';
  state.mention.items.forEach((item, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention-item' + (i === state.mention.index ? ' active' : '');
    const isAll = item.id === '__all__';
    b.innerHTML = isAll
      ? I18n.html`<span class="avatar all-avatar">@</span><span class="m-name">全体成员</span><span class="m-role">${esc(item.role)}</span>`
      : avatarHtml(item) +
        `<span class="m-name">${esc(item.name)}</span><span class="m-role">${esc(item.role || '')}</span>`;
    b.addEventListener('mousedown', (event) => event.preventDefault());
    b.addEventListener('click', () => chooseMention(item));
    box.appendChild(b);
  });
  box.hidden = false;
}

function chooseMention(item) {
  const ta = $('#input');
  const { start } = state.mention;
  const pos = ta.selectionStart;
  composer.replaceToken(start, pos, 'mention', item.name);
  closeMention();
  ta.focus();
}

function closeMention() {
  state.mention = null;
  $('#mentionBox').hidden = true;
}

// ---------- slash (skill) selector ----------

function detectSlash() {
  const ta = $('#input');
  const pos = ta.selectionStart;
  const match = ComposerSlash.detect(ta.value, pos);
  if (match) openSlash(match.query, match.start); else closeSlash();
}

function openSlash(query, start) {
  const items = ComposerSlash.items(state.currentRoomId, query);
  if (!items.length) return closeSlash();
  state.slash = { start, items, index: 0 };
  renderSlash();
}

function renderSlash() {
  const box = $('#slashBox');
  box.innerHTML = '';
  state.slash.items.forEach((item, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mention-item' + (i === state.slash.index ? ' active' : '');
    b.innerHTML =
      `<span class="avatar all-avatar">/</span>` +
      `<span class="m-name">${esc(item.name)}</span>` +
      `<span class="m-role">${esc((item.description || '').slice(0, 24))}</span>`;
    b.addEventListener('mousedown', (event) => event.preventDefault());
    b.addEventListener('click', () => chooseSlash(item));
    box.appendChild(b);
  });
  box.hidden = false;
}

function chooseSlash(item) {
  const ta = $('#input');
  const { start } = state.slash;
  const pos = ta.selectionStart;
  if (item.command) { closeSlash(); RoomCommands.choose(item, { roomId: state.currentRoomId, composer, start, end: pos }); return; }
  composer.replaceToken(start, pos, 'skill', item.name);
  closeSlash();
  ta.focus();
}

function closeSlash() {
  state.slash = null;
  $('#slashBox').hidden = true;
}

// ---------- bot modal ----------

function populateCliChoices(selected) {
  const select = $('#f_cliType');
  select.replaceChildren();
  const profiles = (state.cliProfiles || []).filter(profile => profile.enabled || profile.id === selected);
  for (const profile of profiles) {
    const option = document.createElement('option'); option.value = profile.id;
    option.textContent = profile.label;
    select.append(option);
  }
  if (selected && !profiles.some(profile => profile.id === selected)) {
    const option = document.createElement('option'); option.value = selected; I18n.write(option, () => selected + I18n.t(' · 接入缺失')); select.append(option);
  }
  if (!profiles.length) {
    const option = document.createElement('option'); option.value = ''; I18n.write(option, () => I18n.t('请先在设置中启用 Agent')); select.append(option);
  }
  select.value = selected || profiles[0]?.id || '';
  updateCliNotice();
}
function updateCliNotice() {
  syncPermissionChoices();
  const profile = state.cliProfiles.find(item => item.id === $('#f_cliType').value);
  I18n.write($('#f_cliNotice'), () => !profile?.enabled ? I18n.t('请先在设置的 Agent 接入中启用。')
    : profile.historyModeSupport !== 'verified' ? I18n.t('会话记录按此 Agent 的原生设置保存。')
    : profile.id === 'pi' ? I18n.t('Pi 支持只读或全权限。只读限制工具使用范围。') : '');
}
async function refreshCliProfiles() {
  state.cliProfiles = await window.api.listCliProfiles();
  renderSkillCategories();
}


function openBotNew(roomId = state.currentRoomId) {
  cancelBotEditorTest();
  state.editingBotRoomId = roomId;
  $('#f_moderator').disabled = !roomId;
  botEditVersion += 1; $('#botSaveBtn').disabled = botSaving;
  state.editingBotId = null;
  I18n.write($('#botModalTitle'), () => I18n.t('新建 bot'));
  $('#f_name').value = '';
  populateBotProfile({});
  populateCliChoices();
  $('#f_model').value = '';
  ModelPicker.load($('#f_cliType').value);
  $('#f_cwd').value = '';
  $('#f_cwd').disabled = RoomUI.ownsMembers(state.rooms.find((room) => room.id === roomId));
  $('#f_cwdBrowse').disabled = $('#f_cwd').disabled;
  updateBotDirectoryHint();
  $('#f_persona').value = '';
  setPermRadio('workspace');
  $('#f_enabled').checked = true;
  $('#f_moderator').checked = false;
  $('#botDeleteBtn').style.visibility = 'hidden';
  updatePersonaPlaceholder();
  renderAvatarPreview();
  showModal('botModal');
}

function openBotEdit(bot, roomId = state.currentRoomId) {
  cancelBotEditorTest();
  state.editingBotRoomId = roomId;
  $('#f_moderator').disabled = !roomId;
  botEditVersion += 1; $('#botSaveBtn').disabled = botSaving;
  state.editingBotId = bot.id;
  const local = RoomProfiles.isLocal(state.rooms.find(room => room.id === roomId));
  const sharedCount = state.rooms.filter(room => !RoomProfiles.isLocal(room) && room.botIds?.includes(bot.id)).length;
  I18n.write($('#botModalTitle'), () => local ? I18n.t('编辑侧聊成员 · 仅此侧聊生效') : sharedCount > 1 ? I18n.tpl`编辑共享 bot · ${sharedCount} 个房间同步` : I18n.t('编辑 bot'));
  $('#f_name').value = bot.name;
  populateBotProfile(bot);
  populateCliChoices(bot.cliType);
  $('#f_model').value = bot.model || '';
  ModelPicker.load(bot.cliType, bot.model || '', bot.reasoningEffort || '', bot.executionMode || 'chat');
  $('#f_cwd').value = bot.cwd || '';
  $('#f_cwd').disabled = local || !!bot.ownerRoomId;
  $('#f_cwdBrowse').disabled = $('#f_cwd').disabled;
  updateBotDirectoryHint();
  $('#f_persona').value = bot.persona || '';
  setPermRadio(bot.permissionMode || 'workspace');
  $('#f_enabled').checked = !!bot.enabled;
  $('#f_moderator').checked = isModerator(bot, state.rooms.find((room) => room.id === roomId));
  $('#botDeleteBtn').style.visibility = 'visible';
  I18n.write($('#botDeleteBtn'), () => local ? I18n.t('移出此侧聊') : I18n.t('删除'));
  updatePersonaPlaceholder();
  renderAvatarPreview();
  showModal('botModal');
}

function isModerator(bot, room = currentRoom()) {
  return room ? room.moderatorBotId === bot.id : false;
}

function setPermRadio(mode) {
  $$('input[name="f_permRadio"]').forEach((r) => (r.checked = r.value === mode));
  syncPermissionChoices();
}

async function saveBot() {
  if (botSaving) return;
  const editVersion = botEditVersion;
  const targetRoomId = state.editingBotRoomId;
  const moderatorChecked = $('#f_moderator').checked;
  const name = $('#f_name').value.trim();
  const errEl = $('#f_error');
  errEl.hidden = true;
  if (!name) {
    I18n.write(errEl, () => I18n.t('请填写名称'));
    errEl.hidden = false;
    return;
  }
  try {
  const targetRoom = state.rooms.find(room => room.id === targetRoomId);
  const local = RoomProfiles.isLocal(targetRoom);
  const existing = (local ? roomMembers(targetRoom) : state.bots).find((b) => b.id === state.editingBotId);
  const payload = botFormPayload();
  if (existing) payload.id = existing.id;
  else if (RoomUI.ownsMembers(state.rooms.find((room) => room.id === targetRoomId))) payload.ownerRoomId = targetRoomId;

  botSaving = true; $('#botSaveBtn').disabled = true;
  const result = local ? await window.api.saveRoomMember(targetRoomId, payload) : await window.api.saveBot(payload);
  const saved = local ? result.bot : result;
  if (local) Object.assign(targetRoom, result.room);
  else if (existing) {
    state.bots = state.bots.map((b) => (b.id === saved.id ? saved : b));
    if (existing.cliType !== saved.cliType) {
      // The store clears old Agent capability overrides in every ordinary
      // room. Refresh those rooms before saving moderator or membership fields.
      const fresh = await window.api.getInitial();
      state.rooms = fresh.rooms;
    }
  } else state.bots.push(saved);

  // Membership belongs to the room/form that initiated this save.
  const curRoom = state.rooms.find(room => room.id === targetRoomId);
  if (curRoom) {
    let modId = curRoom.moderatorBotId;
    let botIds = curRoom.botIds || [];
    if (!existing && !botIds.includes(saved.id)) botIds = botIds.concat([saved.id]);
    if (moderatorChecked) modId = saved.id;
    else if (modId === saved.id && !moderatorChecked) modId = botIds[0] || '';
    if (modId !== curRoom.moderatorBotId ||
        botIds.join(',') !== (curRoom.botIds || []).join(',')) {
      const updated = await window.api.saveRoom({ ...curRoom, moderatorBotId: modId, botIds });
      Object.assign(curRoom, updated);
    }
  }

  if (editVersion === botEditVersion) { hideModal('botModal'); if (targetRoomId === null) openSettings('bots'); }
  renderBots();
  renderTopbar();
  renderRooms(); SideChatUI.refresh(); renderBotManagement();
  } catch (e) {
    if (editVersion === botEditVersion) { I18n.write(errEl, () => I18n.t('保存失败：') + ((e && e.message) || e)); errEl.hidden = false; }
    else AppDialog.alert(I18n.t('成员保存失败：') + (e.message || e));
  } finally { botSaving = false; $('#botSaveBtn').disabled = false; }
}

async function deleteBot() {
  const targetRoom = state.rooms.find(room => room.id === state.editingBotRoomId);
  if (RoomProfiles.isLocal(targetRoom)) {
    const bot = roomMembers(targetRoom).find(item => item.id === state.editingBotId);
    if (bot) await removeMember(targetRoom, bot);
    hideModal('botModal'); SideChatUI.refresh(); return;
  }
  const bot = state.bots.find((b) => b.id === state.editingBotId);
  if (!bot) return;
  const membership = state.rooms.filter(room => !RoomProfiles.isLocal(room) && room.botIds?.includes(bot.id));
  if (!await AppDialog.confirm(I18n.tpl`删除 bot「${bot.name}」？将从 ${membership.length} 个房间移除，已有消息保留。侧聊独立配置和已有消息保留。`)) return;
  await window.api.deleteBot(bot.id);
  const globalManagement = state.editingBotRoomId === null;
  hideModal('botModal');
  await reloadFromMain();
  if (globalManagement) openSettings('bots');
  renderBotManagement();
}

// ---------- room modal ----------

function checkedMemberIds() {
  return $$('#r_members input.member-check:checked').map((c) => c.value);
}

function checkedModeratorId() {
  const r = $('#r_members input.mod-radio:checked');
  return r ? r.value : '';
}

// Keep moderator radios consistent with the membership checkboxes.
function syncModeratorRadios() {
  const checked = checkedMemberIds();
  let mod = checkedModeratorId();
  for (const row of $$('#r_members .member-opt')) {
    const radio = row.querySelector('.mod-radio');
    radio.disabled = !checked.includes(radio.value);
  }
  if (!checked.includes(mod)) mod = checked[0] || '';
  if (mod) {
    const r = $('#r_members input.mod-radio[value="' + CSS.escape(mod) + '"]');
    if (r) r.checked = true;
  }
}

// One row per global bot: membership checkbox + moderator radio.
function fillMemberPick(room) {
  const wrap = $('#r_members');
  wrap.innerHTML = '';
  const currentIds = room ? (room.botIds || [])
    : RoomUI.availableBots(null).filter((b) => b.enabled).map((b) => b.id); // new room: pre-check enabled
  const modId = room ? room.moderatorBotId : currentIds[0];

  for (const bot of RoomUI.availableBots(room)) {
    const isMember = currentIds.includes(bot.id);
    const label = document.createElement('label');
    label.className = 'member-opt';
    label.innerHTML =
      `<input type="checkbox" class="member-check" value="${bot.id}"${isMember ? ' checked' : ''} />` +
      avatarHtml(bot) +
      `<span class="m-name">${esc(bot.name)}</span>` +
      `<span class="m-role">${esc(bot.cliType)}</span>` +
      I18n.html`<span class="mod-pick"><input type="radio" name="r_mod" class="mod-radio"
         value="${bot.id}"${bot.id === modId ? ' checked' : ''}
         title="设为主持人"/>主持人</span>`;
    label.querySelector('.member-check').addEventListener('change', syncModeratorRadios);
    wrap.appendChild(label);
  }
  syncModeratorRadios();
}

function openRoomNew(cwd = '') {
  state.editingRoomId = null;
  I18n.write($('#roomModalTitle'), () => I18n.t('新建房间'));
  $('#r_name').value = '';
  $('#r_cwd').value = typeof cwd === 'string' ? cwd : '';
  $('#r_cwd').disabled = false; $('#r_cwdBrowse').disabled = false;
  $('#r_error').hidden = true;
  fillMemberPick(null);
  $('#roomDeleteBtn').style.visibility = 'hidden';
  showModal('roomModal');
}

function openRoomEdit(room) {
  state.editingRoomId = room.id;
  I18n.write($('#roomModalTitle'), () => I18n.t('编辑房间'));
  $('#r_name').value = room.name;
  $('#r_cwd').value = room.cwd || '';
  $('#r_cwd').disabled = !!room.parentRoomId; $('#r_cwdBrowse').disabled = !!room.parentRoomId;
  $('#r_error').hidden = true;
  fillMemberPick(room);
  $('#roomDeleteBtn').style.visibility = 'visible';
  showModal('roomModal');
}

async function saveRoom() {
  const errEl = $('#r_error');
  errEl.hidden = true;
  const name = $('#r_name').value.trim() || I18n.t('新房间');
  const memberIds = checkedMemberIds();
  if (!memberIds.length) {
    I18n.write(errEl, () => I18n.t('请至少勾选一个房间成员'));
    errEl.hidden = false;
    return;
  }
  const existing = state.rooms.find((r) => r.id === state.editingRoomId);
  const payload = {
    name,
    cwd: $('#r_cwd').value.trim(),
    moderatorBotId: checkedModeratorId() || memberIds[0],
    botIds: memberIds,
  };
  if (existing) payload.id = existing.id;

  let saved;
  try {
    saved = await window.api.saveRoom(payload);
  } catch (e) {
    errEl.textContent = (e && e.message) || String(e);
    errEl.hidden = false;
    return;
  }

  if (existing) {
    Object.assign(existing, saved);
  } else {
    state.rooms.push(saved);
    state.dataByRoom[saved.id] = [];
  }
  hideModal('roomModal');
  if (saved.parentRoomId) await reloadFromMain();
  switchRoom(saved.id);
}

// Room modal delete reuses the same soft-delete (recycle bin) flow.
async function roomModalDelete() {
  const room = state.rooms.find((r) => r.id === state.editingRoomId);
  if (room) confirmDeleteRoom(room);
}

// ---------- floating context menu ----------

function openPopMenu(anchor, items) {
  const menu = $('#popMenu');
  menu.innerHTML = '';
  for (const it of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pop-item' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    b.addEventListener('click', () => { closePopMenu(); if (it.onClick) it.onClick(); });
    menu.appendChild(b);
  }
  const r = anchor.getBoundingClientRect();
  menu.hidden = false;
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  let left = r.left, top = r.bottom + 4;
  if (left + mw > window.innerWidth - 8) left = window.innerWidth - mw - 8;
  if (top + mh > window.innerHeight - 8) top = r.top - mh - 4;
  menu.style.left = left + 'px';
  menu.style.top = top + 'px';
}

function closePopMenu() { $('#popMenu').hidden = true; }

function openRoomMenu(anchor, room) {
  openPopMenu(anchor, [
    { label: room.pinnedAt ? I18n.t('取消置顶') : I18n.t('置顶'), onClick: () => RoomUI.pin(room) },
    { label: I18n.t('重命名…'), onClick: () => RoomUI.rename(room) },
    ...(!room.parentRoomId ? [{ label: I18n.t('新建侧边聊天'), onClick: () => SideChatUI.create(room.id) }] : []),
    ...(!room.parentRoomId ? [{ label: I18n.t('移动到项目…'), onClick: () => NavigationUI.moveRoom(room) }] : []),
    { label: I18n.t('房间设置…'), onClick: () => openRoomEdit(room) },
    { label: I18n.t('归档房间'), onClick: () => archiveRoom(room) },
    { label: I18n.t('归档聊天但不归档房间'), onClick: () => archiveChat(room.id) },
    { label: I18n.t('删除房间'), danger: true, onClick: () => confirmDeleteRoom(room) },
  ]);
}

async function confirmDeleteRoom(room) {
  const sideCount = state.rooms.filter((child) => child.parentRoomId === room.id).length;
  const sideNote = sideCount ? I18n.tpl` ${sideCount} 个侧边聊天将保留为独立房间。` : '';
  if (!await AppDialog.confirm(I18n.tpl`永久删除房间「${room.name}」及其消息和聊天归档？此操作不可恢复。需要保留请取消并选择归档房间。${sideNote}`)) return;
  await window.api.deleteRoom(room.id);
  state.rooms = state.rooms.filter((r) => r.id !== room.id);
  delete state.dataByRoom[room.id];
  runByRoom.delete(room.id);
  await reloadFromMain();
  if (state.currentRoomId === room.id) {
    const next = state.rooms.find((r) => !r.archivedAt);
    switchRoom(next ? next.id : null);
  }
  renderRooms(); renderBots(); renderTopbar(); syncComposer(); renderMessages();
}

async function archiveRoom(room) {
  if (!await AppDialog.confirm(I18n.tpl`归档房间「${room.name}」？成员、设置与聊天记录都会保留，可从历史恢复。`)) return;
  await window.api.setRoomArchived({ roomId: room.id, archived: true });
  await reloadFromMain();
}

async function archiveChat(roomId) {
  if (!roomId || !await AppDialog.confirm(I18n.t('归档当前聊天并清空消息？房间仍在列表中，聊天归档可从历史合并恢复。'))) return;
  const result = await window.api.archiveCurrent(roomId);
  if (!result) { AppDialog.alert(I18n.t('当前没有可归档的记录')); return; }
  await reloadFromMain();
  if (!$('#settingsModal').hidden) await renderHistory();
}

// ---------- add members to current room ----------

function openAddMember(roomId) {
  const room = typeof roomId === 'string' ? state.rooms.find((item) => item.id === roomId) : currentRoom();
  state.addMemberRoomId = room?.id || state.currentRoomId;
  if (!room) { openBotNew(); return; }
  $('#am_roomName').textContent = room.name;
  $('#am_error').hidden = true;
  const wrap = $('#am_list');
  wrap.innerHTML = '';
  const inRoom = new Set(room.botIds || []);
  const sourceIds = new Set(roomMembers(room).map((bot) => bot.sourceBotId).filter(Boolean));
  const candidates = RoomUI.availableBots(room).filter((b) => !inRoom.has(b.id) && !sourceIds.has(b.id));
  if (!candidates.length) {
    wrap.innerHTML = I18n.t('<p class="hint">所有 Agent 配置都已在本房间；可点“新建成员配置”。</p>');
  }
  for (const bot of candidates) {
    const label = document.createElement('label');
    label.className = 'member-opt';
    label.innerHTML =
      `<input type="checkbox" value="${bot.id}" />` +
      avatarHtml(bot) +
      `<span class="m-name">${esc(bot.name)}</span>` +
      `<span class="m-role">${esc(bot.cliType)}</span>`;
    wrap.appendChild(label);
  }
  showModal('addMemberModal');
}

async function addCheckedMembers() {
  const room = state.rooms.find((item) => item.id === state.addMemberRoomId);
  if (!room) return;
  const ids = $$('#am_list input[type="checkbox"]:checked').map((c) => c.value);
  if (!ids.length) {
    const e = $('#am_error');
    I18n.write(e, () => I18n.t('请勾选要加入的成员'));
    e.hidden = false;
    return;
  }
  const botIds = (room.botIds || []).slice();
  for (const id of ids) if (!botIds.includes(id)) botIds.push(id);
  const updated = await window.api.saveRoom({ ...room, botIds });
  Object.assign(room, updated);
  hideModal('addMemberModal');
  if (room.parentRoomId) await reloadFromMain();
  renderBots(); renderTopbar(); renderRooms();
}

// ---------- settings ----------

function openSettings(tab = 'general', roomId = state.currentRoomId) {
  settingsEditVersion += 1; $('#settingsSaveBtn').disabled = settingsSaving;
  const s = state.settings;
  $('#s_language').value = I18n.normalize(s.language);
  // Show the actually-effective value (stored null means "use default").
  const eff = (k) => (s[k] != null ? s[k]
    : state.defaults[k] != null ? state.defaults[k] : '');
  $('#s_turns').value = s.maxAutoTurns != null ? s.maxAutoTurns : '';
  $('#s_edge').value = eff('perEdgeMentionCap');
  $('#s_calls').value = eff('maxCliCallsPerRun');
  $('#s_catchup').value = eff('catchupMessages');
  $('#s_historyTokens').value = eff('historyTokenBudget') || 0;
  const mode = s.costMode === 'cli' ? 'cli' : 'none';
  $$('input[name="costMode"]').forEach((r) => (r.checked = r.value === mode));
  $('#s_defaultCwd').value = s.defaultCwd || '';
  $('#s_dataPath').value = state.dataPath;
  AppearanceUI.open(state.settings.appearance);
  $('#s_autoCollapseProcess').checked = state.settings.autoCollapseProcess !== false;
  CliSettingsUI.open(state.settings.cliProfiles, state.cliProfiles);
  PricingUI.open(s.agentPricing || {}, state.cliProfiles, state.bots);
  state.skillScanRoots = [...(s.skillScanRoots || [])];
  state.skillScanOwners = { ...(s.skillScanOwners || {}) };
  renderSkillCategories();
  switchSettingsTab(typeof tab === 'string' ? tab : 'general', roomId);
  showModal('settingsModal');
}

function switchSettingsTab(tab, roomId = state.currentRoomId) {
  if (tab !== 'extensions') NativeCapabilitiesUI.closeManagement();
  $('#settingsSaveBtn').hidden = ['extensions', 'bots'].includes(tab);
  $('#settingsApplyBtn').hidden = $('#settingsSaveBtn').hidden;
  $$('.settings-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $$('.settings-panel').forEach((p) => (p.hidden = p.dataset.panel !== tab));
  if (tab === 'bots') renderBotManagement();
  if (tab === 'skills') loadSkillLibrary();
  if (tab === 'history') loadHistoryTab();
  if (tab === 'extensions') openNativeManagement(roomId);
}

function renderBotManagement() {
  const host = $('#botManagementList'); if (!host) return;
  const needle = ($('#botManagementSearch')?.value || '').trim().toLocaleLowerCase();
  host.replaceChildren();
  for (const bot of state.bots) {
    if (bot.ownerRoomId) continue;
    const rooms = state.rooms.filter(room => !RoomProfiles.isLocal(room) && room.botIds?.includes(bot.id));
    const memberships = rooms.map(room => room.name + (room.archivedAt ? I18n.t('（已归档）') : '')).join('、');
    if (needle && !`${bot.name} ${bot.cliType} ${memberships}`.toLocaleLowerCase().includes(needle)) continue;
    const row = document.createElement('div'); row.className = 'skill-row';
    row.innerHTML = `<div class="sk-detail"><span class="sk-name">${esc(bot.name)}</span><span class="sk-desc">${esc(bot.cliType)} · ${esc(memberships || (bot.ownerRoomId ? I18n.t('旧侧聊配置 · 保留历史身份') : I18n.t('未加入房间')))}</span></div>`;
    row.append(actionButton(I18n.live(() => I18n.t('编辑')), () => openBotEdit(bot, null)));
    host.append(row);
  }
  if (!host.children.length) host.innerHTML = I18n.t('<p class="hint">没有匹配的成员。</p>');
}

function openNativeManagement(roomId = state.currentRoomId) {
  return NativeCapabilitiesUI.manage({ host: $('#nativeSettingsHost'), bots: state.bots, rooms: state.rooms, roomId, settings: state.settings,
    async onManageNative({ cliType, roomId: targetRoomId, cwd }) {
      try {
        await AppDialog.alert(I18n.tpl`将在内置终端打开房间工作目录。请确认目录为 ${cwd || I18n.t('当前房间工作目录')}，然后运行 ${cliType === 'claude' ? I18n.t('claude，并使用 /mcp enable 服务名 或 /plugin') : I18n.t('codex，按原生扩展管理命令操作')}。原生启用可能持久修改对应项目配置，只有你在终端执行后才会改变。完成后回到此页点击更新；应用不会代执行命令。`);
        hideModal('settingsModal');
        if (targetRoomId && targetRoomId !== state.currentRoomId) switchRoom(targetRoomId);
        await WorkbenchUI.openTerminal('bottom');
      } catch (error) { await AppDialog.alert(error.message); }
    },
    async onSaved() {
      const data = await window.api.getInitial();
      state.settings = data.settings; state.rooms = data.rooms;
      renderBots(); renderTopbar(); SideChatUI.refresh();
    },
  }).catch(error => { $('#nativeSettingsHost').textContent = error.message; });
}

// ----- per-room history (archive / clear / export) -----

async function deleteSingleMessage(roomId, messageId) {
  if (!await AppDialog.confirm(I18n.t('删除该条消息？此操作不可恢复。'))) return;
  await window.api.deleteMessage({ roomId, messageId });
  const list = messages(roomId);
  const idx = list.findIndex((m) => m.id === messageId);
  if (idx >= 0) list.splice(idx, 1);
  if (roomId === state.currentRoomId) renderMessages();
  SideChatUI.refreshMessages(roomId);
}

function renderHistoryRoomChoices() {
  const sel = $('#histRoom'), prev = sel.value;
  const query = $('#histRoomSearch').value.trim().toLocaleLowerCase();
  const selectable = state.rooms.filter(room => !room.archivedAt && (!query || room.name.toLocaleLowerCase().includes(query)));
  sel.innerHTML = `<option value="">${esc(I18n.t('所有房间'))}</option>` + selectable
    .map(r => `<option value="${esc(r.id)}">${esc(r.name)}${r.archivedAt ? esc(I18n.t('（已归档）')) : ''}</option>`).join('');
  sel.value = selectable.some(room => room.id === prev) ? prev : '';
}

async function loadHistoryTab() {
  renderHistoryRoomChoices();
  await Promise.all([renderHistory(), renderArchivedRooms()]);
}

function actionButton(label, handler, danger = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost-btn sk-btn' + (danger ? ' danger-text' : '');
  I18n.label(button, label);
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await handler(); } finally { button.disabled = false; }
  });
  return button;
}

let archiveRenderVersion = 0;
async function renderArchivedRooms() {
  const version = ++archiveRenderVersion;
  const list = $('#archivedRoomList');
  const archived = state.rooms.filter((room) => room.archivedAt);
  list.innerHTML = archived.length ? '' : I18n.t('<p class="hint">暂无归档房间。</p>');
  for (const room of archived) {
    const row = document.createElement('div'); row.className = 'skill-row';
    row.innerHTML = `<div class="sk-detail"><span class="sk-name">${esc(room.name)}</span>` +
      I18n.html`<span class="sk-desc">${fmtDateTime(room.archivedAt)} · ${(state.dataByRoom[room.id] || []).length} 条消息</span></div>`;
    row.appendChild(actionButton(I18n.live(() => I18n.t('查看聊天')), () => { hideModal('settingsModal'); ConversationUI.showMessage(room.id, (state.dataByRoom[room.id] || [])[0]?.id || ''); }));
    row.appendChild(actionButton(I18n.live(() => I18n.t('恢复房间')), async () => {
      await window.api.setRoomArchived({ roomId: room.id, archived: false });
      await reloadFromMain(); switchRoom(room.id); hideModal('settingsModal');
    }));
    row.appendChild(actionButton(I18n.live(() => I18n.t('永久删除')), async () => { await confirmDeleteRoom(room); await renderArchivedRooms(); }, true));
    list.appendChild(row);
  }
  await renderTrash(version);
}

async function renderTrash(version = archiveRenderVersion) {
  const list = $('#archivedRoomList');
  try {
    const trash = await window.api.listTrash();
    if (version !== archiveRenderVersion) return;
    if (trash.length && !state.rooms.some((room) => room.archivedAt)) list.innerHTML = '';
    for (const entry of trash) {
      const row = document.createElement('div'); row.className = 'skill-row';
      row.innerHTML = `<div class="sk-detail"><span class="sk-name">${esc(entry.name)}</span>` +
        I18n.html`<span class="sk-desc">${fmtDateTime(entry.deletedAt)} · ${entry.count} 条消息 · ${entry.archiveCount || 0} 份聊天归档</span></div>`;
      row.appendChild(actionButton(I18n.live(() => I18n.t('恢复')), async () => {
        const restored = await window.api.restoreTrash(entry.key);
        const id = typeof restored === 'string' ? restored : restored.id;
        await reloadFromMain(); switchRoom(id); hideModal('settingsModal');
      }));
      row.appendChild(actionButton(I18n.live(() => I18n.t('永久删除')), async () => {
        if (!await AppDialog.confirm(I18n.tpl`永久删除「${entry.name}」及其消息、聊天归档？此操作不可恢复。`)) return;
        await window.api.purgeTrash(entry.key); await renderArchivedRooms();
      }, true));
      list.appendChild(row);
    }
  } catch (error) { if (version !== archiveRenderVersion) return; const note = document.createElement('p'); note.className = 'hint'; I18n.write(note, () => I18n.tpl`旧归档读取失败：${error.message || error}`); list.appendChild(note); }
}

let historyRenderVersion = 0;
async function renderHistory() {
  const version = ++historyRenderVersion;
  const roomId = $('#histRoom').value;
  const room = state.rooms.find(item => item.id === roomId && !item.archivedAt);
  for (const id of ['histArchive', 'histClear', 'histExport']) $('#' + id).disabled = !room;
  const rooms = room ? [room] : state.rooms;
  $('#histCurrentCount').textContent = rooms.reduce((count, item) => count + (state.dataByRoom[item.id] || []).length, 0);
  $('#histTargetHint').hidden = !!room;
  const list = $('#histArchiveList');
  list.replaceChildren();
  // Fetch in sequence to keep IPC bounded when viewing many rooms.
  const archives = [], warnings = [];
  for (const item of rooms) {
    try {
      const entries = await window.api.listArchives(item.id);
      if (version !== historyRenderVersion) return;
      for (const arc of entries) archives.push({ ...arc, roomId: item.id, roomName: item.name });
    } catch (error) {
      if (version !== historyRenderVersion) return;
      warnings.push({ roomName: item.name, detail: error.message || String(error) });
    }
  }
  archives.sort((a, b) => b.archivedAt - a.archivedAt);
  if (!archives.length && !warnings.length) list.innerHTML = I18n.t('<p class="hint">暂无聊天归档。</p>');
  for (const warning of warnings) {
    const note = document.createElement('p'); note.className = 'hint history-archive-warning'; note.setAttribute('role', 'status');
    I18n.write(note, () => I18n.tpl`${warning.roomName}：聊天归档读取失败：${warning.detail}`); list.appendChild(note);
  }
  for (const arc of archives) {
    const row = document.createElement('div');
    row.className = 'skill-row';
    row.innerHTML = `<div class="sk-detail"><span class="sk-name">${esc(arc.roomName)} · ${fmtDateTime(arc.archivedAt)}</span>` +
      I18n.html`<span class="sk-desc">${arc.count} 条消息</span></div>`;
    row.appendChild(actionButton(I18n.live(() => I18n.t('查看')), () => viewArchive(arc.roomId, arc.id)));
    row.appendChild(actionButton(I18n.live(() => I18n.t('恢复')), () => restoreArc(arc.roomId, arc.id)));
    row.appendChild(actionButton(I18n.live(() => I18n.t('删除')), () => deleteArc(arc.roomId, arc.id), true));
    list.appendChild(row);
  }
}

async function viewArchive(roomId, archiveId, messageId) {
  const rec = await window.api.getArchive({ roomId, archiveId });
  if (!rec) { AppDialog.alert(I18n.t('归档不存在或已损坏')); return; }
  I18n.write($('#archiveViewerTitle'), () => I18n.tpl`归档 · ${rec.roomName || ''} · ${fmtDateTime(rec.archivedAt)}（${rec.messages.length} 条）`);
  const bots = state.bots;
  $('#archiveViewerBody').innerHTML = rec.messages
    .map((m) => {
      const label = m.authorType === 'human' ? I18n.t('房主')
        : m.authorType === 'system' ? I18n.t('系统')
        : (bots.find((b) => b.id === m.authorId) || {}).name || I18n.t('成员');
      return `<div class="arc-line" data-archive-message-id="${esc(m.id)}"><span class="arc-who">${esc(label)}</span>` +
        `<span class="arc-time">${fmtTime(m.createdAt)}</span>` +
        `<div class="arc-text">${richText(MessageContent.publicText(m))}</div></div>`;
    })
    .join('');
  showModal('archiveViewerModal');
  if (messageId) requestAnimationFrame(() => {
    const target = $('#archiveViewerBody').querySelector(`[data-archive-message-id="${CSS.escape(messageId)}"]`);
    target?.scrollIntoView({ block: 'center' }); target?.classList.add('message-search-target');
  });
}

async function restoreArc(roomId, archiveId) {
  if (!await AppDialog.confirm(I18n.t('把该归档合并回当前记录？（按消息 id 去重，归档文件将移除）'))) return;
  await window.api.restoreArchive({ roomId, archiveId });
  await reloadFromMain();
  await renderHistory();
}

async function deleteArc(roomId, archiveId) {
  if (!await AppDialog.confirm(I18n.t('永久删除该归档？此操作不可恢复。'))) return;
  await window.api.deleteArchive({ roomId, archiveId });
  await renderHistory();
}

// ----- native skill references -----

let skillScanVersion = 0;

function renderSkillRoots() {
  const list = $('#skillRoots');
  list.innerHTML = '';
  for (const root of state.skillScanRoots || []) {
    const scope = state.skillSourceRoots?.find(item => item.path === root);
    const row = document.createElement('div'); row.className = 'skill-row';
    const path = document.createElement('span'); path.className = 'sk-detail scan-root';
    path.textContent = root; row.appendChild(path);
    path.title = scope?.category || 'other';
    row.appendChild(actionButton(I18n.live(() => I18n.t('移除目录')), async () => {
      state.skillScanRoots = state.skillScanRoots.filter((item) => item !== root);
      delete state.skillScanOwners[root];
      await loadSkillLibrary();
    }));
    list.appendChild(row);
  }

}

function renderSkillCategories() {
  const select = $('#skillSourceCategory');
  const selected = select.value;
  select.replaceChildren();
  for (const profile of (state.cliProfiles || []).filter(item => item.enabled)) select.add(new Option(profile.label, profile.id));
  select.add(new Option(I18n.t('本地其他目录'), 'other'));
  if ([...select.options].some(option => option.value === selected)) select.value = selected;
}

async function loadSkillLibrary(addedRoot) {
  const version = ++skillScanVersion;
  $('#skillSourceCategory').disabled = true;
  $('#skillRescan').disabled = true;
  renderSkillRoots();
  I18n.write($('#skillScanStatus'), () => I18n.t('正在扫描来源…'));
  I18n.write($('#skillScanSummary'), () => I18n.t('正在扫描技能目录…'));
  const room = currentRoom();
  const cwd = (room && room.cwd) || state.settings.defaultCwd || state.defaultCwd || '';
  const [scan, references, catalog] = await Promise.allSettled([
    window.api.discoverSkillsDetailed({ cwd, roots: state.skillScanRoots || [], owners: state.skillScanOwners || {}, addedRoot, category: $('#skillSourceCategory').value }),
    window.api.listSkillReferences(),
    window.api.listImportedSkills(),
  ]);
  if (version !== skillScanVersion) return;
  const notes = [];
  if (scan.status === 'fulfilled') {
    const result = scan.value;
    if (result.category) $('#skillSourceCategory').value = result.category;
    state.skillSourceRoots = result.sourceRoots || [];
    renderSkillRoots();
    state.externalSkills = result.skills || [];
    const labels = { ok: I18n.t('完成'), missing: I18n.t('目录不存在'), error: I18n.t('读取失败'), partial: I18n.t('部分完成'),
      excluded: I18n.t('应用副本已跳过'), filtered: I18n.t('备份或依赖目录已跳过'), skipped_link: I18n.t('链接已跳过'), limited: I18n.t('达到上限') };
    notes.push(...(result.roots || []).map((root) => `${root.source || I18n.t('来源')} · ${root.path} · ${labels[root.status] || root.status}`));
    notes.push(...(result.warnings || []));
    if (result.truncated) notes.push(I18n.t('扫描已达到数量限制，结果不完整；请缩小目录范围。'));
    state.skillScanError = '';
    I18n.write($('#skillScanSummary'), () => I18n.tpl`${state.externalSkills.length} 个候选 · ${(result.roots || []).length} 个目录` +
      (result.truncated ? I18n.t(' · 结果不完整') : (result.warnings || []).length ? I18n.t(' · 有扫描提示') : ''));
  } else {
    state.externalSkills = [];
    state.skillScanError = I18n.tpl`扫描失败：${scan.reason.message || scan.reason}`;
    notes.push(state.skillScanError);
    $('#skillScanSummary').textContent = state.skillScanError;
  }
  if (catalog.status === 'fulfilled') state.importedSkills = catalog.value;
  else notes.push(I18n.t('快捷引用读取失败：') + (catalog.reason.message || catalog.reason));
  if (references.status === 'fulfilled') state.skillReferences = references.value;
  else { state.skillReferences = []; notes.push(I18n.t('引用读取失败：') + (references.reason.message || references.reason)); }
  $('#skillScanStatus').textContent = notes.join('\n');
  $('#skillSourceCategory').disabled = false;
  $('#skillRescan').disabled = false;
  renderSkillLists();
}

function renderSkillLists() {
  const query = $('#skillSearch').value.trim().toLowerCase();
  const matches = (skill) => [skill.name, skill.alias, skill.description, skill.source, skill.sourcePath, skill.dir]
    .some((value) => String(value || '').toLowerCase().includes(query));
  const sourceKey = value => {
    const normalized = String(value || '').replace(/\\/g, '/').replace(/\/$/, '');
    return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  const registered = new Set((state.skillReferences || []).map(item => sourceKey(item.sourcePath)));
  const nameKey = value => String(value || '').trim().toLowerCase();
  const external = (state.externalSkills || []).filter(skill => {
    if (!matches(skill) || registered.has(sourceKey(skill.sourcePath))) return false;
    const scope = skill.nativeCliTypes || (skill.nativeCliType ? [skill.nativeCliType]
      : (state.cliProfiles || []).filter(profile => profile.enabled).map(profile => profile.id));
    const sameName = (state.skillReferences || []).filter(reference => nameKey(reference.name) === nameKey(skill.name));
    return !scope.length || !scope.every(cli => sameName.some(reference => reference.cliTypes.includes(cli)));
  });
  const disc = $('#skillDiscover');
  disc.innerHTML = '';
  if (!external.length) {
    const hint = document.createElement('p'); hint.className = 'hint';
    I18n.write(hint, () => state.skillScanError || (query ? I18n.t('没有匹配的来源技能。') : I18n.t('本次扫描暂无待登记来源，请查看已登记引用及目录状态。')));
    disc.appendChild(hint);
  }
  for (const skill of external) {
    const row = document.createElement('div'); row.className = 'skill-row';
    row.innerHTML = `<details class="sk-detail"><summary><b>${esc(skill.name)}</b><span class="sk-source">${esc(skill.source || I18n.t('来源'))} · ${esc(skill.sourcePath)}</span><span class="sk-desc">${esc(skill.description || I18n.t('暂无描述'))}</span></summary>` +
      `<p class="hint">${esc(skill.description || I18n.t('暂无描述'))}</p></details>`;
    const button = actionButton(I18n.live(() => I18n.t('登记引用')), async () => {
      button.disabled = true;
      try {
        const registered = await window.api.registerSkillReference({ sourcePath: skill.sourcePath, direct: true });
        state.skillReferences = [...(state.skillReferences || []).filter(item => item.id !== registered.id), registered];
        state.importedSkills = await window.api.listImportedSkills();
        renderSkillLists();
      } catch (error) { await AppDialog.alert(I18n.t('登记失败：') + (error.message || error)); }
      finally { button.disabled = false; }
    });
    row.appendChild(button);
    disc.appendChild(row);
  }
  const refs = $('#skillReferences'); refs.innerHTML = '';
  for (const reference of (state.skillReferences || []).filter(matches)) {
    const row = document.createElement('div'); row.className = 'skill-row';
    row.innerHTML = '<div class="sk-detail"><b>/' + esc(reference.alias) + '</b><span class="sk-desc">' +
      esc(reference.cliTypes.map(id => state.cliProfiles.find(profile => profile.id === id)?.label || id).join(' / ')) + (reference.availability === 'missing' ? I18n.t(' · 来源缺失') : '') +
      '</span><span class="sk-source">' + esc(reference.sourcePath) + '</span></div>';
    row.appendChild(actionButton(I18n.live(() => I18n.t('移除引用')), async () => {
      try { await window.api.removeSkillReference(reference.id); await loadSkillLibrary(); }
      catch (error) { await AppDialog.alert(error.message); }
    }, true));
    refs.appendChild(row);
  }
  if (!refs.childNodes.length) refs.innerHTML = I18n.t('<p class="hint">暂无匹配的原生技能引用。</p>');

}

async function saveSettings(closeAfterSave = true) {
  if (settingsSaving) return;
  const editVersion = settingsEditVersion;
  const cliProfiles = CliSettingsUI.read();
  if (!cliProfiles) { switchSettingsTab('cli'); return; }
  const appearance = AppearanceUI.read();
  if (!appearance) { switchSettingsTab('appearance'); return; }
  let agentPricing;
  try { agentPricing = PricingUI.read(); } catch (error) { switchSettingsTab('pricing'); await AppDialog.alert(error.message); return; }
  const num = (id) => {
    const v = $(id).value;
    return v === '' ? null : Number(v);
  };
  const mode = $('input[name="costMode"]:checked');
  const patch = {
    language: $('#s_language').value,
    cliProfiles,
    agentPricing,
    enabledCliIds: CliSettingsUI.enabledIds(),
    appearance,
    autoCollapseProcess: $('#s_autoCollapseProcess').checked,
    maxAutoTurns: num('#s_turns'),
    perEdgeMentionCap: num('#s_edge'),
    maxCliCallsPerRun: num('#s_calls'),
    catchupMessages: num('#s_catchup'),
    historyTokenBudget: num('#s_historyTokens'),
    costMode: mode ? mode.value : 'none',
    defaultCwd: $('#s_defaultCwd').value.trim(),
    skillScanRoots: state.skillScanRoots || [],
    skillScanOwners: state.skillScanOwners || {},
  };
  settingsSaving = true; $('#settingsSaveBtn').disabled = true; $('#settingsApplyBtn').disabled = true;
  try {
    state.settings = await window.api.saveSettings(patch);
    I18n.setLanguage(state.settings.language);
    I18n.applyStatic();
    renderRooms(); renderBots(); renderTopbar(); renderMessages(); SideChatUI.refresh();
    renderSkillCategories();
    await refreshCliProfiles();
    if (editVersion === settingsEditVersion) {
      const pricingAgent = $('#pricingAgent')?.value;
      PricingUI.open(state.settings.agentPricing || {}, state.cliProfiles, state.bots);
      if (pricingAgent && [...($('#pricingAgent')?.options || [])].some(option => option.value === pricingAgent)) {
        $('#pricingAgent').value = pricingAgent; $('#pricingAgent').dispatchEvent(new Event('change'));
      }
      AppearanceUI.commit(state.settings.appearance);
      CliSettingsUI.commit(state.settings.cliProfiles, state.cliProfiles);
      if (closeAfterSave) hideModal('settingsModal');
    } else AppearanceUI.setSaved(state.settings.appearance);
    syncComposer();
    for (const roomId of [state.currentRoomId, SideChatUI.getRoom()?.id].filter(Boolean)) ConversationUI.event({ kind: 'run_update', roomId });
  } catch (error) {
    if (editVersion === settingsEditVersion) {
      switchSettingsTab('cli');
      I18n.write($('#cliProfileError'), () => error.message || I18n.t('设置保存失败，请重试'));
      $('#cliProfileError').hidden = false;
    } else await AppDialog.alert(error.message || I18n.t('设置保存失败'));
  } finally { settingsSaving = false; $('#settingsSaveBtn').disabled = false; $('#settingsApplyBtn').disabled = false; }
}

// ---------- modal helpers ----------

const MODAL_IDS = ['archiveViewerModal', 'settingsModal', 'addMemberModal', 'botModal', 'roomModal']; // front-first order

function visibleModal() {
  return MODAL_IDS.find((id) => !$('#' + id).hidden) || null;
}

function closeAllModals() {
  cancelBotEditorTest();
  NativeCapabilitiesUI.closeManagement();
  botEditVersion += 1; settingsEditVersion += 1;
  AppearanceUI.cancel();
  CliSettingsUI.cancel();
  MODAL_IDS.forEach((id) => { $('#' + id).hidden = true; });
}

// Only one modal at a time: opening one closes the others, preventing stacked
// modals that look impossible to dismiss.
function openOnly(id) {
  if (id !== 'botModal' && !$('#botModal').hidden) botEditVersion += 1;
  if (id !== 'settingsModal' && !$('#settingsModal').hidden) settingsEditVersion += 1;
  if (id !== 'settingsModal' && !$('#settingsModal').hidden) { AppearanceUI.cancel(); CliSettingsUI.cancel(); NativeCapabilitiesUI.closeManagement(); }
  MODAL_IDS.forEach((m) => { $('#' + m).hidden = m !== id; });
}

const modalReturnFocus = new Map();
function modalFocusables(modal) {
  return [...modal.querySelectorAll('button, input, textarea, select, [tabindex]')]
    .filter((element) => !element.disabled && element.tabIndex >= 0 && element.getClientRects().length);
}
function showModal(id) {
  modalReturnFocus.set(id, document.activeElement);
  openOnly(id);
  const modal = $('#' + id);
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
  if (!AppDialog.isOpen()) modalFocusables(modal)[0]?.focus();
}
function hideModal(id) {
  if (id === 'settingsModal') NativeCapabilitiesUI.closeManagement();
  if (id === 'botModal') botEditVersion += 1;
  if (id === 'settingsModal') settingsEditVersion += 1;
  if (id === 'settingsModal') { AppearanceUI.cancel(); CliSettingsUI.cancel(); }
  if (id === 'botModal') cancelBotEditorTest();
  $('#' + id).hidden = true;
  const prior = modalReturnFocus.get(id);
  if (prior?.isConnected && prior.getClientRects().length) prior.focus({ preventScroll: true });
  else $('#settingsBtn').focus({ preventScroll: true });
}

function autoResize() {
  const ta = $('#input');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}

// ---------- events from main ----------

function handleEvent(e) {
  if (!e || !e.roomId) return;
  messages(e.roomId);

  if (e.kind === 'message_add') {
    if (e.message.authorType === 'human' && sendingRooms.get(e.roomId) === e.message.text) {
      composer.clearSent(e.roomId, e.message.text);
      autoResize();
    }
    const list = messages(e.roomId);
    if (!list.some((m) => m.id === e.message.id)) list.push(e.message);
    if (e.roomId === state.currentRoomId) renderMessages('smart');
  } else if (e.kind === 'message_delta') {
    const msg = messages(e.roomId).find((m) => m.id === e.id);
    if (msg) {
      msg.text += e.text;
      if (e.roomId === state.currentRoomId) patchBubble(e.roomId, msg);
    }
  } else if (e.kind === 'message_update') {
    const msg = messages(e.roomId).find((m) => m.id === e.id);
    if (msg) Object.assign(msg, e.patch);
    if (e.roomId === state.currentRoomId) refreshBubbleState(e.roomId, e.id);
  } else if (e.kind === 'run_update') {
    runByRoom.set(e.roomId, e.run);
    syncMessageActions();
    if (e.roomId === state.currentRoomId) syncComposer();
    renderRooms();
  }
  SideChatUI.handleEvent(e);
  NativeInputUI.event(e);
  window.WorkbenchUI?.refreshAgentDetails();
  ConversationUI.event(e);
}

// ---------- wiring ----------

function wire() {
  SideChatUI.wire();
  ConversationUI.wire();
  NavigationUI.wireSettings();
  AppearanceUI.wire();
  CliSettingsUI.wire();
  $('#f_cliType').addEventListener('change', updateCliNotice);
  wireBotProfile();
  ModelPicker.wire();
  wireMessageActions();
  // Critical dismissal wiring FIRST, so it works even if later setup throws:
  // global Escape closes mention popup -> topmost modal -> stops active run.
  document.addEventListener('keydown', (ev) => {
    if (ev.isComposing || composer.composing || ev.keyCode === 229 || AppDialog.isOpen()) return;
    const modal = visibleModal();
    if (ev.key === 'Tab' && modal) {
      const nodes = modalFocusables($('#' + modal));
      const first = nodes[0], last = nodes.at(-1);
      if (ev.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) {
        ev.preventDefault(); last?.focus();
      } else if (!ev.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) {
        ev.preventDefault(); first?.focus();
      }
      return;
    }
    if (ev.key !== 'Escape') return;
    if (!$('#popMenu').hidden) { closePopMenu(); ev.preventDefault(); return; }
    if (state.slash) { closeSlash(); ev.preventDefault(); return; }
    if (state.mention) { closeMention(); ev.preventDefault(); return; }
    const top = visibleModal();
    if (top) { hideModal(top); ev.preventDefault(); return; }
    const run = runByRoom.get(state.currentRoomId);
    if (run && ACTIVE_RUN.has(run.status)) window.api.stopRun(state.currentRoomId);
  });

  // Click anywhere outside the floating menu closes it. The row "⋯" button
  // stops propagation, so opening still works.
  document.addEventListener('pointerdown', (ev) => {
    if (!$('#popMenu').hidden && !ev.target.closest('#popMenu')) closePopMenu();
  });

  $$('[data-close]').forEach((b) =>
    b.addEventListener('click', () => hideModal(b.dataset.close)));
  $$('.modal-backdrop').forEach((bd) =>
    bd.addEventListener('click', (ev) => { if (ev.target === bd) hideModal(bd.id); }));

  $('#addRoom').addEventListener('click', openRoomNew);
  $('#addBot').addEventListener('click', openAddMember);
  $('#settingsBtn').addEventListener('click', openSettings);
  $('#historyBtn').addEventListener('click', () => openSettings('history'));
  $('#roomName').addEventListener('click', () => {
    const room = currentRoom();
    if (room) openRoomEdit(room);
  });

  $('#actionBtn').addEventListener('click', () => {
    const run = runByRoom.get(state.currentRoomId);
    if (run && ACTIVE_RUN.has(run.status)) window.api.stopRun(state.currentRoomId);
    else doSend();
  });

  $$('#routeSeg .seg-btn').forEach((b) => b.addEventListener('click', async () => {
    const room = currentRoom();
    if (!room) return;
    const updated = await window.api.saveRoom({ ...room, routingMode: b.dataset.route });
    Object.assign(room, updated);
    syncComposer();
  }));

  $('#speakMode').addEventListener('change', async () => {
    const room = currentRoom();
    if (!room) return;
    const updated = await window.api.saveRoom({ ...room, speakMode: $('#speakMode').value });
    Object.assign(room, updated);
  });

  $('#allBtn').addEventListener('click', () => {
    composer.focus();
    const end = composer.value.length;
    composer.select(end);
    if (end && !/\s$/.test(composer.value)) composer.insertText(' ');
    composer.replaceToken(composer.value.length, composer.value.length, 'mention', I18n.language === 'en' ? 'all' : '全体');
  });

  const ta = $('#input');
  ta.addEventListener('input', () => {
    autoResize();
    if (!composer.composing) { detectMention(); detectSlash(); }
    ComposerModeUI.sync();
  });
  ta.addEventListener('compositionend', () => { detectMention(); detectSlash(); });
  ta.addEventListener('keydown', (ev) => {
    if (ev.isComposing || composer.composing || ev.keyCode === 229) return;
    if (state.mention) {
      const items = state.mention.items;
      if (ev.key === 'ArrowDown') { state.mention.index = (state.mention.index + 1) % items.length; renderMention(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { state.mention.index = (state.mention.index - 1 + items.length) % items.length; renderMention(); ev.preventDefault(); }
      else if (ev.key === 'Enter' || ev.key === 'Tab') { chooseMention(items[state.mention.index]); ev.preventDefault(); }
      else if (ev.key === 'Escape') { closeMention(); ev.preventDefault(); }
      return;
    }
    if (state.slash) {
      const items = state.slash.items;
      if (ev.key === 'ArrowDown') { state.slash.index = (state.slash.index + 1) % items.length; renderSlash(); ev.preventDefault(); }
      else if (ev.key === 'ArrowUp') { state.slash.index = (state.slash.index - 1 + items.length) % items.length; renderSlash(); ev.preventDefault(); }
      else if (ev.key === 'Enter' || ev.key === 'Tab') { chooseSlash(items[state.slash.index]); ev.preventDefault(); }
      else if (ev.key === 'Escape') { closeSlash(); ev.preventDefault(); }
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); doSend(); }
  });

  // Bot modal
  $('#botSaveBtn').addEventListener('click', saveBot);
  $('#botDeleteBtn').addEventListener('click', deleteBot);
  $('#botManagementNew').addEventListener('click', () => openBotNew(null));
  $('#botManagementSearch').addEventListener('input', renderBotManagement);
  $('#f_cwdBrowse').addEventListener('click', async () => {
    const p = await window.api.pickFolder($('#f_cwd').value);
    if (p) { $('#f_cwd').value = p; updateBotDirectoryHint(); }
  });

  // Room modal
  $('#roomSaveBtn').addEventListener('click', saveRoom);
  $('#roomDeleteBtn').addEventListener('click', roomModalDelete);
  $('#r_cwdBrowse').addEventListener('click', async () => {
    const p = await window.api.pickFolder($('#r_cwd').value);
    if (p) $('#r_cwd').value = p;
  });

  // Add member modal
  $('#am_add').addEventListener('click', addCheckedMembers);
  $('#am_new').addEventListener('click', () => {
    hideModal('addMemberModal');
    openBotNew(state.addMemberRoomId);
  });

  // Settings
  $$('.settings-tab').forEach((t) => t.addEventListener('click', () => switchSettingsTab(t.dataset.tab)));
  $('#s_cwdBrowse').addEventListener('click', async () => {
    const p = await window.api.pickFolder($('#s_defaultCwd').value);
    if (p) $('#s_defaultCwd').value = p;
  });
  $('#openDataBtn').addEventListener('click', () => window.api.openDataDir());
  $('#skillRescan').addEventListener('click', () => loadSkillLibrary());
  $('#skillSourceCategory').addEventListener('change', () => loadSkillLibrary());
  $('#skillSearch').addEventListener('input', renderSkillLists);
  $('#skillAddRoot').addEventListener('click', async () => {
    const path = await window.api.pickFolder(state.defaultCwd || '');
    if (!path) return;
    if ((state.skillScanRoots || []).length >= 24) { AppDialog.alert(I18n.t('最多添加 24 个扫描目录')); return; }
    if (!state.skillScanRoots.includes(path)) state.skillScanRoots.push(path);
    const category = $('#skillSourceCategory').value;
    if (category !== 'other') state.skillScanOwners[path] = category;
    else delete state.skillScanOwners[path];
    await loadSkillLibrary(path);
  });

  // History tab
  $('#histRoom').addEventListener('change', () => renderHistory());
  $('#histRoomSearch').addEventListener('input', () => { renderHistoryRoomChoices(); void renderHistory(); });
  $('#histSearch').addEventListener('click', () => { hideModal('settingsModal'); ConversationUI.openSearch(); });
  $('#histArchive').addEventListener('click', async () => {
    const roomId = $('#histRoom').value;
    if (!state.rooms.some(room => room.id === roomId && !room.archivedAt)) return;
    await archiveChat(roomId);
  });
  $('#histClear').addEventListener('click', async () => {
    const roomId = $('#histRoom').value;
    if (!state.rooms.some(room => room.id === roomId && !room.archivedAt)) return;
    if (!await AppDialog.confirm(I18n.t('清空当前记录且不归档？此操作不可恢复。'))) return;
    await window.api.clearRoom(roomId);
    state.dataByRoom[roomId] = [];
    renderMessages();
    await renderHistory();
  });
  $('#histExport').addEventListener('click', async () => {
    const roomId = $('#histRoom').value;
    if (!state.rooms.some(room => room.id === roomId && !room.archivedAt)) return;
    const res = await window.api.exportRoom(roomId);
    if (res && res.ok) AppDialog.alert(I18n.t('已导出：') + res.path);
  });

  $('#settingsSaveBtn').addEventListener('click', () => saveSettings(true));
  $('#settingsApplyBtn').addEventListener('click', () => saveSettings(false));
}

async function reloadFromMain() {
  const data = await window.api.getInitial();
  state.bots = data.bots || [];
  state.rooms = data.rooms || [];
  state.settings = data.settings || {};
  I18n.setLanguage(state.settings.language);
  I18n.applyStatic();
  AppearanceUI.setSaved(state.settings.appearance);
  await refreshCliProfiles();
  state.defaults = data.defaults || {};
  state.dataByRoom = data.messagesByRoom || {};
  state.dataPath = data.dataPath || '';
  state.skillsPath = data.skillsPath || '';
  state.defaultCwd = data.defaultCwd || '';
  runByRoom.clear();
  for (const run of data.activeRuns || []) runByRoom.set(run.roomId, run);
  if (!state.rooms.some((room) => room.id === state.currentRoomId && !room.archivedAt)) {
    switchRoom((state.rooms.find((room) => !room.archivedAt) || {}).id || null);
  }
  renderRooms();
  renderBots();
  renderTopbar();
  syncComposer();
  renderMessages();
  SideChatUI.refresh();
  renderBotManagement();
  if (!$('#settingsModal').hidden && $('.settings-tab.active')?.dataset.tab === 'history') await loadHistoryTab();
}

async function init() {
  const data = await window.api.getInitial();
  state.bots = data.bots || [];
  state.rooms = data.rooms || [];
  state.settings = data.settings || {};
  I18n.setLanguage(state.settings.language);
  I18n.applyStatic();
  I18n.write($('#aboutVersion'), () => I18n.t('版本') + ' ' + (data.appInfo?.version || ''));
  $('#aboutExecutable').textContent = data.appInfo?.executable || '';
  AppearanceUI.setSaved(state.settings.appearance);
  await refreshCliProfiles();
  state.defaults = data.defaults || {};
  state.dataByRoom = data.messagesByRoom || {};
  state.dataPath = data.dataPath || '';
  state.skillsPath = data.skillsPath || '';
  state.defaultCwd = data.defaultCwd || '';
  state.currentRoomId = (state.rooms.find((room) => room.id === data.currentRoomId && !room.archivedAt) ||
    RoomUI.visibleRooms()[0] || {}).id || null;
  for (const run of data.activeRuns || []) runByRoom.set(run.roomId, run);

  window.api.onRoomEvent(handleEvent);
  wire();
  await window.WorkbenchUI?.init();
  for (const pending of data.pendingInputs || []) NativeInputUI.event(pending);
  composer.switchRoom(state.currentRoomId);
  renderRooms();
  renderBots();
  renderTopbar();
  syncComposer();
  renderMessages();
  try { state.importedSkills = await window.api.listImportedSkills(); } catch { state.importedSkills = []; }
}

document.addEventListener('DOMContentLoaded', init);
