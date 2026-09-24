'use strict';
const I18n = require('../../shared/i18n');

// The same validation protects live protocol replies and deferred continuations.
function validateAnswers(questions, answers) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 10 ||
      !answers || typeof answers !== 'object' || Array.isArray(answers) ||
      Object.keys(answers).some(key => !questions.some(question => question.id === key))) throw new Error(I18n.t('回答格式无效'));
  const response = Object.create(null);
  for (const question of questions) {
    const values = answers[question.id]?.answers;
    if (!Array.isArray(values) || !values.length || values.length > 10 ||
        values.some(value => typeof value !== 'string' || !value.trim() || value.length > 16000)) throw new Error(I18n.t('请回答所有问题'));
    if (question.optionOnly && (values.length !== 1 || !question.options?.some(option => option.label === values[0]))) throw new Error(I18n.t('请选择提供的选项'));
    response[question.id] = { answers: values };
  }
  if (JSON.stringify(response).length > 64000) throw new Error(I18n.t('回答过长'));
  return response;
}

module.exports = { validateAnswers };
