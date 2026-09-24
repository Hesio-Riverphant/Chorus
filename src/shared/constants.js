'use strict';

// Internal normalized events emitted by CLI adapters
const RoomEvent = {
  TEXT_DELTA: 'text_delta',
  TOOL_CALL: 'tool_call',
  ACTIVITY: 'activity',
  SESSION: 'session',
  USAGE: 'usage',
  ERROR: 'error',
  DONE: 'done',
};

const MessageStatus = {
  STREAMING: 'streaming',
  DONE: 'done',
  ERROR: 'error',
  ABORTED: 'aborted',
};

const AuthorType = { HUMAN: 'human', BOT: 'bot', SYSTEM: 'system' };

const RunStatus = {
  IDLE: 'idle',
  RUNNING: 'running',
  STOPPING: 'stopping',
  DONE: 'done',
  STOPPED: 'stopped',
  ERROR: 'error',
  BUDGET: 'budget',
};

const PermissionMode = { READ_ONLY: 'read_only', WORKSPACE: 'workspace', FULL: 'full' };
const SpeakMode = { PARALLEL: 'parallel', SEQUENTIAL: 'sequential', HOST: 'host' };
const RoutingMode = { MODERATOR: 'moderator', ALL: 'all' };

// How monetary cost is derived. The room never calls the model itself, so the
// real price is unknown unless the user supplies it.
const CostMode = { NONE: 'none', CLI: 'cli', CUSTOM: 'custom' };

const DEFAULTS = {
  perEdgeMentionCap: 2,        // A may @B at most N times per run
  maxCliCallsPerRun: 20,       // absolute ceiling of bot turns per run
  tokenBudgetPerRun: 0,        // reported usage soft cap; 0 = off, active work completes
  costBudgetPerRun: 0,         // USD from reported usage; 0 = off
  catchupMessages: 20,         // first-in-room transcript size
  historyTokenBudget: 0,       // old transcript estimate cap; 0 = no token cap
  autoCollapseProcess: true,   // only confirmed public process output; tool details stay independent
  maxParallel: 3,              // concurrent bot turns
  noBytesTimeoutMs: 90000,     // liveness: no output before marking failure
  costMode: CostMode.NONE,     // default: tokens only, no invented cost
  priceInputPer1M: 0.28,       // custom estimate defaults (DeepSeek V3-ish)
  priceOutputPer1M: 0.42,
  defaultCwd: '',              // '' = project root
};

const CLI_TYPES = {
  claude: { label: 'Claude Code' },
  codex: { label: 'Codex' },
  kimi: { label: 'Kimi' },
};

// Approximate USD prices per 1K tokens, only used when a CLI does not report cost.
// Blended fallbacks; everything produced from this table is labelled "estimated".
const PRICE_PER_1K = {
  claude: { input: 0.003, output: 0.015 },
  codex: { input: 0.0025, output: 0.010 },
  kimi: { input: 0.00015, output: 0.0006 },
  fallback: { input: 0.003, output: 0.015 },
};

module.exports = {
  RoomEvent, MessageStatus, AuthorType, RunStatus,
  PermissionMode, SpeakMode, RoutingMode, CostMode, DEFAULTS, CLI_TYPES, PRICE_PER_1K,
};
