export const TOKEN_BUDGET = 32_000;
const CHARS_PER_TOKEN = 4;
export const MAX_INPUT_CHARS = TOKEN_BUDGET * CHARS_PER_TOKEN;

export class DecisionError extends Error {
  constructor(message, kind = 'unknown', retryable = false) {
    super(message);
    this.name = 'DecisionError';
    this.kind = kind;
    this.retryable = retryable;
  }
}

export function choice(instructions, criteria) {
  const options = Object.keys(criteria ?? {});
  if (options.length < 2) {
    throw new DecisionError('choice questions need at least two criteria options', 'schema');
  }
  return { type: 'choice', instructions, criteria };
}

export function noul(instructions) {
  return { type: 'noul', instructions };
}

export function score(instructions, legend) {
  if (!Array.isArray(legend) || legend.length < 2) {
    throw new DecisionError('score questions need a legend array of ordered levels', 'schema');
  }
  return { type: 'score', instructions, legend };
}

export function buildQuestions(domainSchema) {
  const out = {};
  for (const [key, q] of Object.entries(domainSchema.questions)) out[key] = q;
  return out;
}

export function buildPayload({ model, state, questions }) {
  return { model, state, questions };
}

export function estimateChars({ state, questions }) {
  return JSON.stringify(state).length + JSON.stringify(questions).length;
}

export function assertInputBudget(input) {
  const chars = estimateChars(input);
  if (chars > MAX_INPUT_CHARS) {
    throw new DecisionError(
      `input is ~${chars} chars, over the ${MAX_INPUT_CHARS}-char budget; summarize the state before sending`,
      'budget',
    );
  }
  return chars;
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      return Number(value);
    }
  }
  return null;
}

const RAW_TEXT_KEYS = ['choice', 'label', 'value', 'answer', 'selected', 'option'];
const RAW_PROB_KEYS = ['noul', 'probability', 'confidence', 'p', 'yes'];
const RAW_INDEX_KEYS = ['score', 'index', 'level', 'rank', 'value'];

export function normalizeAnswer(key, question, raw) {
  if (raw === null || raw === undefined) {
    throw new DecisionError(`no answer returned for question "${key}"`, 'parse');
  }
  if (question.type === 'noul') {
    const direct = typeof raw === 'number' || typeof raw === 'string' ? firstNumber(raw) : null;
    const box = typeof raw === 'object' ? raw : {};
    const p = direct ?? firstNumber(...RAW_PROB_KEYS.map((k) => box[k]));
    if (p === null) throw new DecisionError(`unparseable noul answer for "${key}"`, 'parse');
    const clamped = Math.min(1, Math.max(0, p));
    return { type: 'noul', probability: clamped };
  }
  const box = typeof raw === 'object' ? raw : { value: raw };
  if (question.type === 'choice') {
    const label = RAW_TEXT_KEYS.map((k) => box[k]).find((v) => typeof v === 'string' && v.length > 0);
    if (!label) throw new DecisionError(`unparseable choice answer for "${key}"`, 'parse');
    if (!(label in question.criteria)) {
      throw new DecisionError(`answer "${label}" is outside the criteria space for "${key}"`, 'parse');
    }
    const confidence = firstNumber(...RAW_PROB_KEYS.map((k) => box[k])) ?? 1;
    return { type: 'choice', label, confidence: Math.min(1, Math.max(0, confidence)) };
  }
  const index = firstNumber(...RAW_INDEX_KEYS.map((k) => box[k]));
  if (index === null) throw new DecisionError(`unparseable score answer for "${key}"`, 'parse');
  const clamped = Math.min(question.legend.length - 1, Math.max(0, Math.round(index)));
  return { type: 'score', index: clamped, level: question.legend[clamped] };
}

export function normalizeResponse(domainSchema, answersRaw = {}) {
  const out = {};
  for (const [key, question] of Object.entries(domainSchema.questions)) {
    out[key] = normalizeAnswer(key, question, answersRaw[key]);
  }
  return out;
}
