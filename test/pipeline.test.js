import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baselineDecide, lexicalChoice } from '../src/baseline.js';
import { applyPolicy, POLICIES } from '../src/policy.js';
import { getSchema, DOMAINS } from '../src/schemas.js';
import { evalAll, loadFixtures } from '../src/pipeline.js';
import { classificationMetrics, binaryMetrics } from '../src/eval.js';
import { decide, DEFAULT_ENDPOINT } from '../src/client.js';
import { DecisionError } from '../src/questions.js';

const criteria = {
  dependency: 'downstream unreachable, connection refused, timeout',
  docs: 'documentation typo readme',
  other: 'nothing else fits',
};

test('lexicalChoice picks the overlapping option', () => {
  const picked = lexicalChoice('connection refused from downstream, timing out', criteria);
  assert.equal(picked.label, 'dependency');
  assert.ok(picked.confidence > 0);
});

test('lexicalChoice falls back to other with no overlap', () => {
  const picked = lexicalChoice('zzz qqq www', criteria);
  assert.equal(picked.label, 'other');
  assert.equal(picked.confidence, 0);
});

test('baseline answers every question in every schema', async () => {
  for (const domain of DOMAINS) {
    const schema = getSchema(domain);
    const example = loadFixtures(domain)[0];
    const result = baselineDecide(domain, example.state, schema);
    for (const key of Object.keys(schema.questions)) {
      assert.ok(result.answers[key], `${domain} missing answer for ${key}`);
    }
  }
});

test('policies never auto-execute a destructive action', () => {
  assert.equal(
    applyPolicy('deploy_risk', {
      risk: { type: 'score', index: 4, level: 'severe' },
      rollback: { type: 'choice', label: 'irreversible', confidence: 1 },
      should_block: { type: 'noul', probability: 0.99 },
    }).action,
    'require_manual_approval',
  );
  assert.equal(
    applyPolicy('deploy_risk', {
      risk: { type: 'score', index: 0, level: 'negligible' },
      rollback: { type: 'choice', label: 'automatic', confidence: 1 },
      should_block: { type: 'noul', probability: 0.02 },
    }).action,
    'allow_deploy',
  );
  for (const domain of DOMAINS) {
    for (const action of ['delete', 'destroy', 'drop', 'force_push']) {
      assert.ok(!POLICIES[domain].describe.toString().includes(`'${action}`), domain);
    }
  }
});

test('routing defers to a human when the owner is unclear', () => {
  const decision = applyPolicy('incident_route', {
    team: { type: 'choice', label: 'other', confidence: 0 },
    urgency: { type: 'score', index: 2, level: 'normal' },
    needs_human: { type: 'noul', probability: 0.2 },
  });
  assert.equal(decision.action, 'queue_for_human');
  assert.match(decision.reason, /no confident owner/);
});

test('applyPolicy refuses to run on partial answers', () => {
  assert.throws(() => applyPolicy('log_error', { category: { type: 'choice', label: 'config' } }), /missing/);
});

test('baseline metrics on bundled fixtures are reported, not asserted high', async () => {
  const reports = await evalAll({ mode: 'baseline' });
  assert.equal(reports.length, DOMAINS.length);
  for (const report of reports) {
    assert.ok(report.examples >= 12, `${report.domain} has too few fixtures`);
    assert.ok(report.missCount >= 0);
    for (const m of Object.values(report.choice)) {
      assert.ok(m.accuracy >= 0 && m.accuracy <= 1);
    }
    for (const m of Object.values(report.binary)) {
      assert.ok(m.bestThreshold >= 0 && m.bestThreshold <= 1);
    }
  }
});

test('classificationMetrics computes precision and recall', () => {
  const metrics = classificationMetrics([
    { expected: 'a', predicted: 'a' },
    { expected: 'a', predicted: 'b' },
    { expected: 'b', predicted: 'b' },
  ]);
  assert.equal(metrics.perClass.a.recall, 0.5);
  assert.equal(metrics.perClass.a.precision, 1);
  assert.equal(metrics.perClass.b.precision, 0.5);
  assert.equal(metrics.perClass.b.recall, 1);
  assert.equal(metrics.accuracy, 0.667);
});

test('binaryMetrics prefers a higher threshold for noisier scores', () => {
  const m = binaryMetrics([
    { positive: true, probability: 0.95 },
    { positive: true, probability: 0.8 },
    { positive: false, probability: 0.2 },
    { positive: false, probability: 0.1 },
  ]);
  assert.equal(m.bestF1, 1);
  assert.ok(m.bestThreshold > 0.2 && m.bestThreshold <= 0.8);
});

test('client requires a key and never fabricates an answer', async () => {
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.JEV_API_KEY;
  try {
    await assert.rejects(
      () => decide('log_error', { message: 'x' }, getSchema('log_error')),
      /no API key found/,
    );
  } finally {
    if (saved) process.env.OPENROUTER_API_KEY = saved;
  }
});

test('client posts the documented shape and parses answers', async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          answers: {
            category: { choice: 'dependency', confidence: 0.83 },
            severity: { score: 3 },
            novel: { noul: 0.7 },
          },
          usage: { prompt_tokens: 512, completion_tokens: 0 },
        }),
    };
  };
  try {
    const result = await decide(
      'log_error',
      { message: 'connection refused downstream' },
      getSchema('log_error'),
      { timeoutMs: 1000, maxAttempts: 1 },
    );
    assert.equal(result.source, 'jev');
    assert.equal(result.answers.category.label, 'dependency');
    assert.equal(result.answers.severity.level, 'high');
    assert.equal(calls[0].url, DEFAULT_ENDPOINT);
    assert.match(calls[0].init.headers.authorization, /^Bearer test-key$/);
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.state.message, 'connection refused downstream');
    assert.ok(body.questions.category.criteria.dependency.length > 10);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  }
});

test('client retries retryable http failures then gives up', async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts += 1;
    return { ok: false, status: 503, text: async () => 'upstream busy' };
  };
  try {
    await assert.rejects(
      () => decide('log_error', { message: 'x' }, getSchema('log_error'), { maxAttempts: 2, backoffMs: 1, timeoutMs: 500 }),
      (error) => error instanceof DecisionError && error.kind === 'http' && error.retryable,
    );
    assert.equal(attempts, 2);
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  }
});

test('client surfaces malformed responses as parse errors', async () => {
  const savedFetch = globalThis.fetch;
  const savedKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => 'not json at all' });
  try {
    await assert.rejects(
      () => decide('log_error', { message: 'x' }, getSchema('log_error'), { maxAttempts: 1, timeoutMs: 500 }),
      /non-JSON body/,
    );
  } finally {
    globalThis.fetch = savedFetch;
    if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = savedKey;
  }
});
