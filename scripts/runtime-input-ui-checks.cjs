'use strict';
module.exports = async ({ win, persistence, check }) => {
  const orchestrator = require('../src/main/orchestrator/orchestrator');
  const page = (fn, ...args) => win.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`);
  const bot = persistence.saveBot({ name: 'Interaction fixture', cliType: 'codex', enabled: true });
  const room = persistence.saveRoom({ name: 'Interaction room', botIds: [bot.id], moderatorBotId: bot.id });
  const record = { kind: 'input_request', roomId: room.id, botId: bot.id, messageId: 'interaction-message',
    requestId: 'approval-fixture', type: 'approval', decisions: ['accept', 'acceptForSession', 'decline'], detail: 'Write fixture.txt' };
  const replies = [];
  orchestrator.runs.set(room.id, { id: 'interaction-run', roomId: room.id, status: 'running', active: new Set(), calls: 1 });
  orchestrator.inputHandles.set(record.messageId, { roomId: room.id, handle: { respondInput(id, answers) { replies.push({ id, answers }); return { ok: true }; } } });
  try {
    check('runtime approval shows exact operation and sends an explicit session decision through IPC', await page(async record => {
      closeAllModals(); await reloadFromMain(); await switchRoom(record.roomId); NativeInputUI.event(record);
      const form = document.querySelector('.native-question');
      const text = form.textContent.includes('Write fixture.txt') && form.textContent.includes('本次会话始终允许');
      await form.querySelectorAll('button')[1].onclick();
      return text && !document.querySelector('.native-question');
    }, record) && replies[0]?.answers.decision === 'acceptForSession');
    check('runtime questions support native options and custom answers', await page(async record => {
      NativeInputUI.event({ ...record, type: undefined, requestId: 'question-fixture', questions: [{ id: 'q', question: 'Choose', options: [{ label: 'Option', description: 'Fixture' }] }] });
      const form = document.querySelector('.native-question'); form.querySelector('.native-question-choice').click();
      const input = form.querySelector('input'); const selected = input.value === 'Option';
      input.value = 'My own answer'; input.dispatchEvent(new Event('input'));
      await form.onsubmit({ preventDefault() {} }); return selected;
    }, record) && replies[1]?.answers.q.answers[0] === 'My own answer');
    check('native option-only questions cannot suggest unsupported free text and send the actual choice', await page(async record => {
      NativeInputUI.event({ ...record, type: undefined, requestId: 'option-fixture', questions: [{ id: 'q', question: 'Choose only', optionOnly: true, options: [{ label: 'Continue' }, { label: 'Skip' }] }] });
      const form = document.querySelector('.native-question'); const input = form.querySelector('input');
      const readonly = input.readOnly && input.placeholder === '请选择提供的选项';
      form.querySelectorAll('.native-question-choice')[1].click();
      await form.onsubmit({ preventDefault() {} }); return readonly;
    }, record) && replies[2]?.answers.q.answers[0] === 'Skip');
  } finally {
    orchestrator.runs.delete(room.id); orchestrator.inputHandles.delete(record.messageId);
  }
  persistence.addMessage(room.id, { id: 'deferred-message', roomId: room.id, authorType: 'bot', authorId: bot.id,
    text: 'Partial response', status: 'error', createdAt: Date.now(), deferredInputs: [{ requestId: 'deferred-fixture', status: 'deferred',
      questions: [{ id: 'q', question: 'Still answerable' }] }] });
  persistence.flushSync();
  check('deferred questions recover from saved messages without a live process', await page(async roomId => {
    await reloadFromMain(); await switchRoom(roomId); renderMessages();
    NativeInputUI.event({ kind: 'run_update', roomId, run: { status: 'done' } });
    const form = document.querySelector('.native-question');
    const button = [...form.querySelectorAll('button')].find(value => value.textContent === '回答问题');
    button.click(); const reopened = document.querySelector('.native-question');
    return reopened.textContent.includes('Still answerable') && !!reopened.querySelector('input');
  }, room.id));
};
