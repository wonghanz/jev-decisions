import {
  DecisionError,
  assertInputBudget,
  buildPayload,
  normalizeResponse,
} from './questions.js';
import { redact } from './redact.js';

export const DEFAULT_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DEFAULT_MODEL = '~typesafe/jev-latest';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(t);
        reject(new DecisionError('aborted', 'aborted'));
      }
      signal.addEventListener?.('abort', () => {
        clearTimeout(t);
        reject(new DecisionError('aborted', 'aborted'));
      });
    }
  });
}

export function hasApiKey(env = process.env) {
  return Boolean(env.OPENROUTER_API_KEY || env.JEV_API_KEY);
}

export function resolveApiKey(env = process.env) {
  const key = env.OPENROUTER_API_KEY || env.JEV_API_KEY;
  if (!key) {
    throw new DecisionError(
      'no API key found; set OPENROUTER_API_KEY, or run the local baseline instead',
      'config',
    );
  }
  return key;
}

async function postOnce(url, headers, body, timeoutMs) {
  const fetchImpl = globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new DecisionError('global fetch is unavailable; needs Node 18+', 'runtime');
  }
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new DecisionError(`decision request timed out after ${timeoutMs}ms`, 'timeout', true);
    }
    throw new DecisionError(`decision request failed: ${error?.message ?? error}`, 'network', true);
  }

  const text = await response.text();
  if (!response.ok) {
    throw new DecisionError(
      `decision endpoint returned ${response.status}: ${text.slice(0, 300)}`,
      'http',
      RETRYABLE_STATUS.has(response.status),
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new DecisionError('decision endpoint returned non-JSON body', 'parse', false);
  }
}

export async function decide(domain, state, schema, options = {}) {
  const {
    endpoint = DEFAULT_ENDPOINT,
    model = DEFAULT_MODEL,
    timeoutMs = 5_000,
    maxAttempts = 2,
    backoffMs = 250,
    redactOptions,
    apiKey,
  } = options;

  const questions = Object.fromEntries(
    Object.entries(schema.questions).map(([key, question]) => [key, question]),
  );
  const redacted = redact(state, redactOptions);
  const input = { model, state: redacted.value, questions };
  assertInputBudget(input);

  const token = apiKey ?? resolveApiKey();
  const headers = {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const json = await postOnce(endpoint, headers, buildPayload(input), timeoutMs);
      const answersRaw = json?.answers ?? json?.data?.[0]?.answers ?? json?.choices?.[0]?.message;
      if (!answersRaw || typeof answersRaw !== 'object') {
        throw new DecisionError(
          `unexpected response shape; expected an "answers" object. Got keys: ${Object.keys(json ?? {}).join(',') || 'none'}`,
          'parse',
        );
      }
      return {
        source: 'jev',
        answers: normalizeResponse(schema, answersRaw),
        usage: json.usage ?? null,
        redactedFields: redacted.hits,
      };
    } catch (error) {
      lastError = error instanceof DecisionError ? error : new DecisionError(String(error?.message ?? error), 'unknown');
      if (!lastError.retryable || attempt === maxAttempts) break;
      await sleep(backoffMs * attempt);
    }
  }
  throw lastError;
}

export function safeDecide(domain, state, schema, options = {}) {
  return decide(domain, state, schema, options).then(
    (result) => ({ ok: true, ...result }),
    (error) => ({
      ok: false,
      source: 'error',
      error: { kind: error?.kind ?? 'unknown', message: error?.message ?? String(error) },
      answers: null,
    }),
  );
}
