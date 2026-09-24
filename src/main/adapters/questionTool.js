'use strict';

// A real application-hosted tool, advertised in the native thread contract.
// Ordinary prose never creates or resolves a question card.
const QUESTION_TIMEOUT_MS = 60_000;
const questionTool = {
  type: 'function', name: 'chorus_ask_user', deferLoading: false,
  description: 'Ask the user a question in a Chorus interactive card. Use this tool when a choice or clarification is needed; writing a question in text does not open a card. Await the actual answer. Unanswered questions are deferred after one minute and can be answered later.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['questions'],
    properties: { questions: { type: 'array', minItems: 1, maxItems: 3, items: {
      type: 'object', additionalProperties: false, required: ['id', 'question'],
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 100 },
        header: { type: 'string', maxLength: 100 },
        question: { type: 'string', minLength: 1, maxLength: 3000 },
        options: { type: 'array', maxItems: 10, items: {
          type: 'object', additionalProperties: false, required: ['label'],
          properties: { label: { type: 'string', minLength: 1, maxLength: 200 }, description: { type: 'string', maxLength: 1000 } },
        } },
      },
    } } },
  },
};
module.exports = { questionTool, QUESTION_TIMEOUT_MS };
