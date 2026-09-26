'use strict';
module.exports = async function interactionRepairChecks({ win, check }) {
  const run = async fn => win.webContents.executeJavaScript('(' + fn.toString() + ')()');
  check('question card uses stacked numbered choices and keeps draft focus across updates', await run(() => {
    const roomId = state.currentRoomId, messageId = 'question-ui-fixture', requestId = 'ui-fixture';
    NativeInputUI.event({ kind: 'input_request', roomId, messageId, requestId, botId: roomMembers(state.rooms.find(room => room.id === roomId))[0]?.id,
      questions: [{ id: 'one', question: '继续并行审查', options: [{ label: '继续现有三路审查（推荐）' }, { label: '暂停代理，主代理单独处理' }] },
        { id: 'two', question: '第二个问题', options: [{ label: '继续' }, { label: '稍后' }] }] });
    let form = document.querySelector('#messages .native-question');
    try {
      const choices = [...form.querySelectorAll('.native-question-choice')];
      const vertical = choices[1].getBoundingClientRect().top >= choices[0].getBoundingClientRect().bottom;
      choices[0].click();
      const input = form.querySelector('input'); input.focus(); input.setSelectionRange(2, 4);
      NativeInputUI.render(roomId);
      const retained = document.activeElement === input && input.selectionStart === 2 && input.selectionEnd === 4;
      form.querySelectorAll('.native-question-nav')[1].click();
      form = document.querySelector('#messages .native-question');
      const pageTwo = form.querySelector('.native-question-page').textContent === '2 of 2';
      form.querySelectorAll('.native-question-nav')[0].click();
      form = document.querySelector('#messages .native-question');
      const restored = form.querySelector('.native-question-choice').getAttribute('aria-pressed') === 'true';
      const compact = form.getBoundingClientRect().width <= 481;
      return vertical && retained && pageTwo && restored && compact && form.querySelector('.native-question-skip').textContent === '跳过'
        && form.querySelector('.native-question-send').textContent === '发送' && !!form.querySelector('.native-question-close');
    } finally { NativeInputUI.event({ kind: 'input_resolved', roomId, messageId, requestId }); }
  }));
  check('slash picker shows source roots beneath each skill name', await run(() => {
    const previous = state.importedSkills;
    try {
      state.importedSkills = [{ name: 'source-fixture', alias: 'source-fixture', cliTypes: ['codex'], sourcePath: 'C:/fixture/.codex/skills/source/SKILL.md' },
        { name: 'source-fixture', alias: 'source-fixture', cliTypes: ['claude'], sourcePath: 'C:/fixture/.claude/skills/source/SKILL.md' }];
      openSlash('skill', 0);
      const source = document.querySelector('#slashBox .m-source');
      return source?.textContent === '.codex · .claude' && source.title.includes('/.codex/') && source.title.includes('/.claude/') && getComputedStyle(source).display === 'block';
    } finally { state.importedSkills = previous; closeSlash(); }
  }));
  check('streamed reasoning and tool updates preserve live summary nodes and expansion', await run(() => {
    const roomId = state.currentRoomId, prior = state.dataByRoom[roomId];
    const message = { id: 'stream-control-fixture', roomId, authorType: 'bot', authorId: roomMembers(state.rooms.find(room => room.id === roomId))[0]?.id,
      text: '', status: 'streaming', createdAt: Date.now(), activities: [{ id: 'reason', kind: 'reasoning', status: 'running', detail: 'First' },
        { id: 'shell', kind: 'tool', name: 'Bash', status: 'running', detail: 'Output' }] };
    try {
      state.dataByRoom[roomId] = [...messages(roomId), message]; renderMessages();
      const row = [...document.querySelectorAll('#messages [data-msg-id]')].find(item => item.dataset.msgId === message.id);
      const reasoning = row.querySelector('details'), title = reasoning.querySelector('summary');
      title.click();
      for (let i = 0; i < 15; i++) {
        const activities = message.activities.map(item => ({ ...item, detail: item.detail + ' next' }));
        handleEvent({ kind: 'message_update', roomId, id: message.id, patch: { activities } });
      }
      const retained = reasoning.isConnected && row.querySelector('summary') === title && reasoning.open;
      title.click();
      const closed = !reasoning.open;
      const tool = row.querySelectorAll('details')[1], toolTitle = tool.querySelector('summary'); toolTitle.click();
      handleEvent({ kind: 'message_update', roomId, id: message.id, patch: { usage: { inputTokens: 15, outputTokens: 5 }, text: 'Streaming' } });
      return retained && closed && tool.isConnected && tool.open && tool.querySelector('summary') === toolTitle && !window.getSelection().toString();
    } finally { state.dataByRoom[roomId] = prior; renderMessages(); }
  }));
  check('side chat preserves streamed disclosure controls through real message events', await run(() => {
    const parent = state.rooms.find(item => item.id === state.currentRoomId), priorSide = SideChatUI.getRoom()?.id;
    const roomId = 'side-stream-fixture';
    const side = { ...parent, id: roomId, parentRoomId: parent.id, name: 'Side fixture' };
    const message = { id: 'side-stream-message', roomId, authorType: 'bot', authorId: roomMembers(parent)[0]?.id,
      text: '', status: 'streaming', createdAt: Date.now(), activities: [{ id: 'tool', kind: 'tool', name: 'Bash', status: 'running', detail: 'First' }] };
    state.rooms.push(side); state.dataByRoom[roomId] = [message];
    try {
      SideChatUI.open(roomId);
      const row = document.querySelector('#sideChatMessages [data-msg-id]');
      const detail = row.querySelector('details'), summary = detail.querySelector('summary'); summary.click();
      for (let i = 0; i < 12; i++) handleEvent({ kind: 'message_update', roomId, id: message.id,
        patch: { activities: [{ ...message.activities[0], detail: 'Update ' + i }] } });
      const retained = row.isConnected && detail.isConnected && detail.open && detail.querySelector('summary') === summary;
      summary.click(); return retained && !detail.open && detail.querySelector('pre').textContent === 'Update 11';
    } finally { SideChatUI.close(); state.rooms = state.rooms.filter(item => item.id !== roomId); delete state.dataByRoom[roomId]; if (priorSide) SideChatUI.open(priorSide); }
  }));
  check('history room search uses themed borders without native white outline', await run(() => {
    openSettings('history');
    try {
      const search = document.querySelector('#histRoomSearch'); search.focus();
      const style = getComputedStyle(search);
      return style.appearance === 'none' && style.boxShadow === 'none' && style.outlineStyle === 'none' && style.borderTopColor !== 'rgb(255, 255, 255)';
    } finally { closeAllModals(); }
  }));
};
