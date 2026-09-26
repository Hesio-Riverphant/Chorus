'use strict';

function roomIsBusy(roomId) {
  return ACTIVE_RUN.has(runByRoom.get(roomId)?.status) || sendingRooms.has(roomId);
}

// Expansion belongs to each native activity, not to the round output toggle.
const activityExpansion = new Map();
function rememberActivityExpansion(container) {
  for (const entry of container?.querySelectorAll('.activities details[data-activity-id]') || []) {
    const row = entry.closest('[data-msg-id]');
    if (row) activityExpansion.set(`${row.dataset.roomId}:${row.dataset.msgId}:${entry.dataset.activityId}`, entry.open);
  }
}
const actionIcons = {
  '⧉': '<rect x="8" y="8" width="11" height="11" rx="1.5"/><path d="M15 8V4H4v11h4"/>',
  '⑂': '<circle cx="7" cy="5" r="2"/><circle cx="17" cy="5" r="2"/><circle cx="7" cy="19" r="2"/><path d="M7 7v10m10-10v3a4 4 0 0 1-4 4H7"/>',
  '✎': '<path d="m4 16-1 5 5-1L20 8l-4-4L4 16Zm10-10 4 4"/>',
};
function setActionIcon(button, label) {
  if (actionIcons[label]) button.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${actionIcons[label]}</svg>`;
  else I18n.label(button, label);
}

function renderActivities(row, activities) {
  const roomId = row.dataset.roomId || state.currentRoomId;
  const message = messages(roomId).find(item => item.id === row.dataset.msgId);
  const botName = roomMembers(state.rooms.find(room => room.id === roomId)).find(bot => bot.id === message?.authorId)?.name || I18n.t('成员');
  const body = row.querySelector('.msg-body'), bubble = row.querySelector('.bubble');
  let goal = row.querySelector('.goal-progress');
  if (message?.goal) {
    if (!goal) { goal = document.createElement('div'); goal.className = 'goal-progress'; body?.insertBefore(goal, bubble); }
    I18n.write(goal, () => I18n.t('目标 · ') + ({ active: I18n.t('进行中'), complete: I18n.t('已完成'), ended: I18n.t('原生目标已结束'), paused: I18n.t('已暂停'), blocked: I18n.t('受阻'), usageLimited: I18n.t('达到原生用量限制'), budgetLimited: I18n.t('达到原生预算限制') }[message.goal.status] || message.goal.status));
  } else goal?.remove();
  let timeline = row.querySelector('.activities');
  if (!activities.length) { timeline?.remove(); delete row.dataset.activitiesSignature; return; }
  const signature = JSON.stringify(activities);
  if (timeline && row.dataset.activitiesSignature === signature) return;
  row.dataset.activitiesSignature = signature;
  if (!timeline) {
    timeline = document.createElement('section'); timeline.className = 'activities';
    I18n.attr(timeline, 'aria-label', () => I18n.t('执行过程')); body?.insertBefore(timeline, bubble);
  }
  const existing = new Map([...timeline.children].map(entry => [entry.dataset.activityId, entry]));
  const ordered = activities.map((activity, index) => ({ activity, index })).sort((a, b) => (a.activity.order ?? a.index) - (b.activity.order ?? b.index));
  for (const [position, { activity }] of ordered.entries()) {
    const id = String(activity.id), commentary = activity.phase === 'commentary';
    let entry = existing.get(id); existing.delete(id);
    if (entry && (entry.tagName === 'DETAILS') === commentary) { entry.remove(); entry = null; }
    if (!entry) {
      entry = document.createElement(commentary ? 'div' : 'details'); entry.dataset.activityId = id;
      if (commentary) entry.className = 'process-output';
      else {
        const expansionKey = roomId + ':' + row.dataset.msgId + ':' + id;
        entry.open = activityExpansion.get(expansionKey) === true;
        entry.addEventListener('toggle', () => { if (entry.isConnected) activityExpansion.set(expansionKey, entry.open); });
        entry.append(document.createElement('summary'), document.createElement('pre'));
      }
    }
    // Never detach an unchanged control: pointerdown/up may span stream events.
    if (timeline.children[position] !== entry) timeline.insertBefore(entry, timeline.children[position] || null);
    const itemSignature = JSON.stringify(activity);
    if (entry.activitySignature === itemSignature) continue;
    entry.activitySignature = itemSignature; entry.activity = activity;
    if (commentary) { entry.innerHTML = formatMessage(activity.detail || ''); continue; }
    const title = entry.querySelector('summary'), text = entry.querySelector('pre');
    const status = { running: I18n.t('进行中'), done: I18n.t('已完成'), error: I18n.t('失败'), aborted: I18n.t('已中断'), unknown: I18n.t('最终状态未知') }[activity.status] || activity.status;
    I18n.write(title, () => activity.kind === 'reasoning' ? [I18n.t('思考'), status].filter(Boolean).join(' · ')
      : [activity.name || activity.kind, status, activity.summary].filter(Boolean).join(' · '));
    if (text.textContent !== (activity.detail || '')) text.textContent = activity.detail || '';
    entry.querySelectorAll('button').forEach(button => button.remove());
    if (activity.kind === 'subagent') {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'subagent-card';
      I18n.write(button, () => I18n.t('查看子代理 ·') + ' ' + (activity.name || I18n.t('子代理')));
      button.addEventListener('click', () => window.WorkbenchUI?.openAgentDetail({ roomId, messageId: message?.id, botName, activity: entry.activity })); entry.append(button);
    }
    for (const file of activity.files || []) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'activity-file';
      I18n.write(button, () => (activity.status === 'done' ? I18n.t('被编辑文件') : I18n.t('编辑目标')) + ' · ' + file); button.title = file;
      button.addEventListener('click', () => window.WorkbenchUI?.openActivityFile(roomId, file).catch(error => AppDialog.alert(error.message))); entry.append(button);
    }
  }
  for (const entry of existing.values()) entry.remove();
}

function patchStreamingMessage(row, message) {
  if (!row || message.status !== 'streaming' || !row.querySelector('.state-tag.streaming') || message.error) return false;
  const text = row.querySelector('.bubble-text');
  const formatted = formatMessage(message.text);
  if (text && text.innerHTML !== formatted) text.innerHTML = formatted;
  renderActivities(row, message.activities || []);
  if (message.usage) {
    const foot = row.querySelector('.foot-row > :first-child');
    if (foot) { foot.className = 'foot'; foot.textContent = usageText(message.usage, message.costInfo); }
  }
  return true;
}

function transcriptText(roomId) {
  return messages(roomId).filter((message) => !message.supersededBy).map((message) => {
    const author = message.authorType === 'human' ? I18n.t('我') : message.authorType === 'system' ? I18n.t('系统')
      : roomMembers(state.rooms.find(room => room.id === roomId)).find(bot => bot.id === message.authorId)?.name || I18n.t('成员');
    const progress = (message.activities || []).filter(activity => activity.phase === 'commentary').sort((a, b) => (a.order || 0) - (b.order || 0)).map(activity => activity.detail).join('\n\n');
    return `${author} · ${fmtDateTime(message.createdAt)}\n${[progress, message.text].filter(Boolean).join('\n\n')}`;
  }).join('\n\n');
}

function syncMessageActions() {
  for (const button of document.querySelectorAll('.message-action')) {
    button.disabled = button.dataset.pending === 'true' ||
      (button.dataset.requiresIdle === 'true' && roomIsBusy(button.dataset.roomId));
  }
}

function messageAction(title, label, handler, idleRoomId = null) {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'message-action';
  button.title = title; button.setAttribute('aria-label', title); setActionIcon(button, label);
  if (idleRoomId) {
    button.dataset.requiresIdle = 'true'; button.dataset.roomId = idleRoomId;
    button.disabled = roomIsBusy(idleRoomId);
  }
  button.addEventListener('click', async () => {
    if (button.dataset.pending === 'true' || (idleRoomId && roomIsBusy(idleRoomId))) return;
    button.dataset.pending = 'true';
    button.disabled = true;
    try { await handler(); }
    finally { delete button.dataset.pending; syncMessageActions(); }
  });
  return button;
}

function addMessageActions(row, message) {
  renderActivities(row, message.activities || []);
  if (message.status === 'streaming') return;
  const roomId = message.roomId || state.currentRoomId;
  const actions = document.createElement('div'); actions.className = 'message-actions';
  actions.appendChild(messageAction(I18n.t('复制完整对话'), '⧉', async () => {
    await navigator.clipboard.writeText(transcriptText(roomId));
  }));
  const fork = messageAction(I18n.t('分支到新聊天'), '⑂', async () => {
    const room = await window.api.forkRoomAt({ roomId, messageId: message.id });
    await reloadFromMain();
    if (state.currentRoomId === roomId || SideChatUI.getRoom()?.id === roomId) switchRoom(room.id);
  }, roomId);
  actions.appendChild(fork);
  if (message.authorType === 'human' && !message.supersededBy) {
    const rewind = messageAction(I18n.t('编辑并回溯'), '✎', () => editAndRewind(roomId, message), roomId);
    actions.appendChild(rewind);
  }
  const time = document.createElement('time'); time.textContent = fmtTime(message.createdAt);
  time.dateTime = new Date(message.createdAt).toISOString(); time.title = fmtDateTime(message.createdAt);
  actions.appendChild(time); row.querySelector('.msg-body')?.appendChild(actions);
  renderAnnotations(row, roomId, message);
}

function textEditor({ title, text = '', description = '', quote = null, inputLabel = title, saveLabel = I18n.t('保存'), allowRegenerate = false, singleLine = false }) {
  const dialog = document.createElement('dialog'); dialog.className = 'app-dialog edit-dialog'; dialog.id = 'messageEditDialog';
  const heading = document.createElement('h2'); heading.textContent = title;
  const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = description;
  const label = document.createElement('label'); label.htmlFor = 'messageEditText'; label.textContent = inputLabel;
  const input = document.createElement(singleLine ? 'input' : 'textarea'); input.id = 'messageEditText';
  if (singleLine) { input.type = 'text'; input.maxLength = 120; } else input.rows = 7;
  input.value = text; input.setAttribute('aria-label', inputLabel);
  const actions = document.createElement('div'); actions.className = 'modal-actions';
  const cancel = document.createElement('button'); cancel.className = 'ghost-btn'; I18n.write(cancel, () => I18n.t('取消')); cancel.id = 'messageEditCancel';
  const save = document.createElement('button'); save.className = 'primary-btn'; save.textContent = saveLabel; save.id = 'messageEditSave';
  dialog.append(heading, hint);
  if (quote !== null) {
    const preview = document.createElement('div'); preview.className = 'annotation-selection-preview';
    const caption = document.createElement('strong'); I18n.write(caption, () => I18n.t('选中文本'));
    const quotation = document.createElement('blockquote'); quotation.textContent = quote;
    preview.append(caption, quotation); dialog.appendChild(preview);
  }
  dialog.append(label, input, actions); actions.append(cancel, save);
  document.body.appendChild(dialog);
  const prior = document.activeElement;
  return new Promise((resolve) => {
    const done = (value) => { dialog.close(); dialog.remove(); if (prior?.isConnected) prior.focus(); resolve(value); };
    cancel.onclick = () => done(null);
    save.onclick = () => { if (input.value.trim()) done({ text: input.value, regenerate: false }); };
    if (allowRegenerate) {
      const regenerate = document.createElement('button'); regenerate.className = 'primary-btn';
      regenerate.id = 'messageEditRegenerate'; I18n.write(regenerate, () => I18n.t('保存并重新生成'));
      regenerate.onclick = () => { if (input.value.trim()) done({ text: input.value, regenerate: true }); };
      actions.appendChild(regenerate);
    }
    dialog.oncancel = (event) => { event.preventDefault(); done(null); };
    dialog.onkeydown = (event) => {
      event.stopPropagation();
      if (singleLine && event.key === 'Enter' && !event.isComposing) { event.preventDefault(); save.click(); }
    };
    dialog.showModal(); input.focus();
  });
}

async function editAndRewind(roomId, message) {
  if (roomIsBusy(roomId)) return;
  const result = await textEditor({ title: I18n.t('编辑并回溯'), text: message.text,
    description: I18n.t('保存后会移除这条消息之后的当前对话；选择“保存并重新生成”会重新请求模型。'),
    saveLabel: I18n.t('仅保存'), allowRegenerate: true });
  if (!result) return;
  if (roomIsBusy(roomId)) throw new Error(I18n.t('房间正在运行，请先停止'));
  state.dataByRoom[roomId] = await window.api.rewindRoom({ roomId, messageId: message.id, text: result.text });
  if (state.currentRoomId === roomId) renderMessages();
  SideChatUI.refreshMessages(roomId);
  if (result.regenerate) await window.api.continueHuman({ roomId, messageId: message.id });
}

function renderAnnotations(row, roomId, message) {
  if (!message.annotations?.length) return;
  const details = document.createElement('details'); details.className = 'annotations';
  const summary = document.createElement('summary'); I18n.write(summary, () => I18n.tpl`批注 · ${message.annotations.length}`); details.appendChild(summary);
  for (const annotation of message.annotations) {
    const entry = document.createElement('div'); entry.className = 'annotation';
    const quote = document.createElement('blockquote'); quote.textContent = annotation.quote;
    const note = document.createElement('p'); note.textContent = annotation.note;
    entry.append(quote, note);
    entry.appendChild(messageAction(I18n.t('引用批注到草稿'), I18n.t('引用'), () => {
      if (SideChatUI.insertText(roomId, I18n.tpl`> ${annotation.quote}\n批注：${annotation.note}\n`)) return;
      switchRoom(roomId); composer.focus(); composer.select(composer.value.length);
      composer.insertText(I18n.tpl`${composer.value ? '\n' : ''}> ${annotation.quote}\n批注：${annotation.note}\n`);
    }));
    const remove = messageAction(I18n.t('删除批注'), I18n.t('删除'), async () => {
      if (!await AppDialog.confirm(I18n.t('删除这条批注？'))) return;
      await window.api.removeAnnotation({ roomId, messageId: message.id, annotationId: annotation.id });
      await reloadFromMain();
    }, roomId);
    entry.appendChild(remove); details.appendChild(entry);
  }
  row.querySelector('.msg-body')?.appendChild(details);
}

function wireMessageActions() {
  const button = document.createElement('button'); button.id = 'annotateSelection';
  button.className = 'selection-action'; I18n.write(button, () => I18n.t('添加批注')); button.hidden = true;
  document.body.appendChild(button);
  let pending;
  document.addEventListener('selectionchange', () => {
    button.hidden = true;
    const selection = window.getSelection();
    if (!selection.rangeCount || selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const start = range.startContainer.parentElement?.closest('.bubble-text');
    const end = range.endContainer.parentElement?.closest('.bubble-text');
    if (!start || start !== end) return;
    const row = start.closest('[data-msg-id]');
    const id = row.dataset.msgId;
    const roomId = row.dataset.roomId || state.currentRoomId;
    const message = messages(roomId).find((item) => item.id === id);
    if (!message || message.status !== 'done' || roomIsBusy(roomId)) return;
    const sourceOffset = (node, offset) => {
      const segment = (node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement)?.closest('[data-source-start]');
      if (!segment) return null;
      const before = document.createRange(); before.selectNodeContents(segment); before.setEnd(node, offset);
      return Number(segment.dataset.sourceStart) + before.toString().length;
    };
    const from = sourceOffset(range.startContainer, range.startOffset);
    const to = sourceOffset(range.endContainer, range.endOffset);
    if (from == null || to == null || from >= to || to > message.text.length) return;
    const quote = message.text.slice(from, to);
    if (!quote.trim()) return;
    pending = { roomId, messageId: id, quote, start: from, end: to };
    const rect = range.getBoundingClientRect();
    button.style.left = Math.min(rect.left, innerWidth - 100) + 'px';
    button.style.top = Math.max(8, rect.top - 34) + 'px'; button.hidden = false;
  });
  button.addEventListener('pointerdown', (event) => event.preventDefault());
  button.addEventListener('click', async () => {
    const selected = pending; button.hidden = true;
    if (!selected) return;
    const result = await textEditor({ title: I18n.t('添加批注'), description: I18n.t('为下面选中的原文添加批注。批注保存在此消息旁，不会自动发送给 Bot。'),
      quote: selected.quote, inputLabel: I18n.t('批注内容'), saveLabel: I18n.t('保存批注') });
    if (!result) return;
    await window.api.addAnnotation({ ...selected, note: result.text }); await reloadFromMain();
  });
}
