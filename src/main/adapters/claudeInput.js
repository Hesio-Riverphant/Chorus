'use strict';
const { randomUUID, createHash } = require('node:crypto');
const I18n = require('../../shared/i18n');
const { safeText } = require('./activities');
const { validateAnswers } = require('./inputAnswers');
const { QUESTION_TIMEOUT_MS } = require('./questionTool');

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'AskUserQuestion']);

// Implements Claude's stream-json host permission protocol. Grants live only
// inside this invocation and never modify native permission/config files.
function createClaudeInput({ prompt, permissionMode, probe = false, goal = false, write, end, emit,
  onPendingChange = () => {}, onExpire, onError, inputTimeoutMs = QUESTION_TIMEOUT_MS, approvalTimeoutMs = 30 * 60 * 1000 }) {
  const inputs = new Map(), nativeIds = new Map(), grants = new Set(), deferredInputs = [];
  const initializeId = 'chorus-input-initialize';
  let closed = false, initialized = false, resultReceived = false;
  const send = value => write(JSON.stringify(value) + '\n');
  const reply = (id, response) => send({ type: 'control_response', response: { subtype: 'success', request_id: id, response } });
  const deny = (id, message) => reply(id, { behavior: 'deny', message });
  function remove(requestId, reason) {
    const input = inputs.get(requestId);
    if (!input) return;
    clearTimeout(input.timer); inputs.delete(requestId); nativeIds.delete(input.nativeId);
    emit('input_resolved', { requestId, ...(reason ? { reason } : {}) });
    onPendingChange();
  }
  function fail(error) { onError(error instanceof Error ? error : new Error(error)); }
  function defer() {
    for (const [requestId, input] of inputs) if (input.questions) {
      deferredInputs.push({ requestId, questions: input.questions, status: 'deferred' });
    }
  }
  function stop({ preserveQuestions = false } = {}) {
    if (closed) return;
    closed = true;
    if (preserveQuestions) defer();
    for (const requestId of [...inputs.keys()]) remove(requestId, preserveQuestions ? 'deferred' : 'cancelled');
    grants.clear();
  }
  function questionsFor(input) {
    if (!Array.isArray(input.questions) || !input.questions.length || input.questions.length > 10) throw new Error(I18n.t('提问数量无效'));
    const texts = new Set();
    return input.questions.map((question, index) => {
      if (!question || typeof question.question !== 'string' || !question.question.trim() || question.question.length > 3000 ||
          texts.has(question.question) || question.isSecret || !Array.isArray(question.options) || question.options.length > 20 ||
          question.options.some(option => !option || typeof option.label !== 'string' || !option.label.trim() || option.label.length > 200)) {
        throw new Error(I18n.t('Claude 提问格式不受支持'));
      }
      texts.add(question.question);
      return { id: `q${index}`, header: safeText(question.header, 100), question: safeText(question.question, 3000),
        isOther: true, multiSelect: question.multiSelect === true,
        options: question.options.map(option => ({ label: safeText(option.label, 200), description: safeText(option.description, 1000) })) };
    });
  }
  function request(value) {
    const nativeId = value.request_id, data = value.request;
    if (typeof nativeId !== 'string' || !nativeId || nativeId.length > 300 || !data || typeof data !== 'object') {
      throw new Error(I18n.t('Claude 交互请求格式无效'));
    }
    if (nativeIds.has(nativeId)) return;
    if (data.subtype !== 'can_use_tool') {
      send({ type: 'control_response', response: { subtype: 'error', request_id: nativeId, error: I18n.t('Chorus 不支持此交互请求') } });
      return;
    }
    const tool = data.tool_name, input = data.input;
    if (typeof tool !== 'string' || !tool || tool.length > 200 || !input || typeof input !== 'object' || Array.isArray(input)) {
      deny(nativeId, I18n.t('Claude 交互请求格式无效')); return;
    }
    if (probe || inputs.size >= 8 || permissionMode === 'read_only' && !READ_ONLY_TOOLS.has(tool)) {
      deny(nativeId, I18n.t('当前权限不允许此工具；请调整成员权限后重试')); return;
    }
    const rawDetail = JSON.stringify({ tool, input, reason: data.decision_reason, blockedPath: data.blocked_path }, null, 2);
    if (rawDetail.length > 16000) { deny(nativeId, I18n.t('授权范围过大或格式无效，已拒绝')); return; }
    const key = createHash('sha256').update(JSON.stringify([tool, input])).digest('hex');
    if (tool !== 'AskUserQuestion' && grants.has(key)) { reply(nativeId, { behavior: 'allow', updatedInput: input }); return; }
    const requestId = randomUUID();
    const pending = { nativeId, tool, input, key };
    if (tool === 'AskUserQuestion') {
      try { pending.questions = questionsFor(input); }
      catch (error) { deny(nativeId, error.message); return; }
    }
    const timeoutMs = pending.questions ? inputTimeoutMs : approvalTimeoutMs;
    pending.timer = setTimeout(() => {
      if (closed || !inputs.has(requestId)) return;
      try {
        if (pending.questions) {
          stop({ preserveQuestions: true });
          onExpire(new Error(I18n.t('等待回复超时；问题已保留，回答后可继续')));
        } else {
          deny(nativeId, I18n.t('授权等待超时，已拒绝'));
          remove(requestId, 'expired');
        }
      } catch (error) { fail(error); }
    }, timeoutMs);
    inputs.set(requestId, pending); nativeIds.set(nativeId, requestId); onPendingChange();
    const common = { requestId, isBlocking: true, expiresAt: Date.now() + timeoutMs };
    emit('input_request', pending.questions ? { ...common, questions: pending.questions } : {
      ...common, type: 'approval', decisions: ['accept', 'acceptForSession', 'decline'],
      detail: safeText(rawDetail, 16000) + '\n\n' + I18n.t('会话内允许仅适用于本次运行中完全相同的工具与参数，不修改原生配置。'),
    });
  }
  return {
    start() {
      if (!goal) send({ type: 'control_request', request_id: initializeId, request: { subtype: 'initialize' } });
    },
    consume(value) {
      if (!value || typeof value !== 'object' || closed) return false;
      if (value.type === 'control_request') { request(value); return true; }
      if (value.type === 'control_cancel_request') {
        remove(nativeIds.get(value.request_id), 'cancelled'); return true;
      }
      if (value.type === 'control_response' && value.response?.request_id === initializeId && !goal) {
        if (initialized) return true;
        if (value.response.subtype !== 'success') throw new Error(I18n.t('Claude 交互初始化失败'));
        initialized = true;
        send({ type: 'user', message: { role: 'user', content: prompt } });
        return true;
      }
      if (value.type === 'result' && !goal) {
        resultReceived = true; stop(); end();
      }
      return false;
    },
    respondInput(requestId, answers) {
      const pending = inputs.get(requestId);
      if (closed || !pending) throw new Error(I18n.t('该提问已结束，请重新发送消息'));
      if (pending.questions) {
        const validated = validateAnswers(pending.questions, answers), nativeAnswers = Object.create(null);
        for (let i = 0; i < pending.questions.length; i++) {
          const question = pending.questions[i], original = pending.input.questions[i];
          const values = validated[question.id].answers;
          if (!question.multiSelect && values.length !== 1) throw new Error(I18n.t('回答格式无效'));
          nativeAnswers[original.question] = values.map(value => {
            const index = question.options.findIndex(option => option.label === value);
            return index >= 0 ? original.options[index].label : value;
          }).join(', ');
        }
        reply(pending.nativeId, { behavior: 'allow', updatedInput: { ...pending.input, answers: nativeAnswers } });
      } else {
        const decision = answers?.decision;
        if (!['accept', 'acceptForSession', 'decline'].includes(decision)) throw new Error(I18n.t('授权选项无效'));
        if (decision === 'decline') deny(pending.nativeId, I18n.t('用户拒绝了此工具调用'));
        else {
          reply(pending.nativeId, { behavior: 'allow', updatedInput: pending.input });
          if (decision === 'acceptForSession') grants.add(pending.key);
        }
      }
      remove(requestId); return { ok: true };
    },
    stop,
    get pending() { return inputs.size > 0; },
    get deferredInputs() { return deferredInputs; },
    get resultVerified() { return initialized && resultReceived; },
  };
}

module.exports = { createClaudeInput };
