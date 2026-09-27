import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choice, noul, score, normalizeAnswer, assertInputBudget, DecisionError } from '../src/questions.js';
import { redact } from '../src/redact.js';
import { SCHEMAS, DOMAINS, getSchema } from '../src/schemas.js';

test('choice requires at least two options', () => {
  assert.throws(() => choice('x', { only: 'one' }), DecisionError);
});

test('score requires a legend array', () => {
  assert.throws(() => score('x', null), DecisionError);
  assert.throws(() => score('x', ['one']), DecisionError);
});

test('normalizeAnswer accepts noul probability', () => {
  const q = noul('is it?');
  assert.deepEqual(normalizeAnswer('k', q, { noul: 0.42 }), { type: 'noul', probability: 0.42 });
  assert.deepEqual(normalizeAnswer('k', q, { probability: 1.7 }), { type: 'noul', probability: 1 });
  assert.deepEqual(normalizeAnswer('k', q, 0.1), { type: 'noul', probability: 0.1 });
});

test('normalizeAnswer rejects out-of-space choices', () => {
  const q = choice('which?', { a: 'first', b: 'second' });
  assert.throws(() => normalizeAnswer('k', q, { choice: 'zzz' }), /outside the criteria space/);
  assert.deepEqual(normalizeAnswer('k', q, { choice: 'a', confidence: 0.9 }), {
    type: 'choice',
    label: 'a',
    confidence: 0.9,
  });
});

test('normalizeAnswer clamps score index into the legend', () => {
  const q = score('how bad?', ['low', 'mid', 'high']);
  assert.equal(normalizeAnswer('k', q, { score: 99 }).index, 2);
  assert.equal(normalizeAnswer('k', q, { index: -4 }).index, 0);
  assert.equal(normalizeAnswer('k', q, { score: 1 }).level, 'mid');
});

test('input budget rejects oversized state', () => {
  const huge = 'x'.repeat(200_000);
  assert.throws(() => assertInputBudget({ state: { m: huge }, questions: {} }), /over the/);
});

test('redact removes credential shapes without touching ordinary text', () => {
  // Fixtures are assembled at runtime so no credential literal ever exists in a committed
  // file, while still matching the exact shapes redact() must catch.
  const aws = `AKIA${'IOSFODNN' + '7EXAMPLE'}`;
  const plain = 'connection refused redis://cache-eu-1:6379';
  assert.equal(redact(plain).hits, 0);
  assert.equal(redact(plain).value, plain);

  const leaky = `key ${aws} and password=${'hunter2' + 'secret'} and https://${'u'}:${'p'}@host/x`;
  const { value, hits } = redact(leaky);
  assert.ok(hits >= 3, `expected >=3 redactions, got ${hits}`);
  assert.ok(!value.includes(aws));
  assert.ok(!value.includes('hunter2secret'));
  assert.ok(value.includes('password='), 'key name should survive, value should not');
});

test('redact walks nested structures', () => {
  const openaiish = `sk-${'abcdefghijklmnop' + '1234567890'}`;
  const hfish = `hf_${'x'.repeat(22)}`;
  const input = { a: [openaiish, { b: hfish }] };
  const { value, hits } = redact(input);
  assert.equal(hits, 2);
  assert.ok(!JSON.stringify(value).includes('abcdefghijklmnop'));
});

test('every bundled schema is internally valid', () => {
  for (const domain of DOMAINS) {
    const schema = getSchema(domain);
    assert.ok(Object.keys(schema.questions).length >= 2, domain);
    assert.ok(schema.labelKey in schema.questions, `${domain} labelKey`);
  }
});

test('criteria spaces all offer an escape hatch', () => {
  for (const domain of DOMAINS) {
    for (const [key, q] of Object.entries(SCHEMAS[domain].questions)) {
      if (q.type === 'choice') {
        assert.ok('other' in q.criteria, `${domain}.${key} has no "other" option`);
      }
    }
  }
});

test('unknown domain fails loudly', () => {
  assert.throws(() => getSchema('nope'), /unknown domain/);
});
