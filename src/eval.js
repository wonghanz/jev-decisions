import { readFileSync } from 'node:fs';
import { getSchema } from './schemas.js';

export function loadJsonl(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('//'))
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`bad JSON on line ${i + 1} of ${path}: ${error.message}`);
      }
    });
}

function confusion(labels) {
  const matrix = {};
  for (const a of labels) {
    matrix[a] = {};
    for (const b of labels) matrix[a][b] = 0;
  }
  return matrix;
}

export function classificationMetrics(pairs) {
  const labels = [...new Set(pairs.flatMap((p) => [p.expected, p.predicted]))].sort();
  const matrix = confusion(labels);
  for (const { expected, predicted } of pairs) {
    if (!(expected in matrix)) matrix[expected] = {};
    matrix[expected][predicted] = (matrix[expected]?.[predicted] ?? 0) + 1;
  }
  const perClass = {};
  for (const label of labels) {
    const tp = matrix[label]?.[label] ?? 0;
    const fn = labels.reduce((s, o) => s + (o === label ? 0 : matrix[label]?.[o] ?? 0), 0);
    const fp = labels.reduce((s, o) => s + (o === label ? 0 : matrix[o]?.[label] ?? 0), 0);
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    perClass[label] = {
      support: tp + fn,
      tp,
      fp,
      fn,
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
    };
  }
  const correct = pairs.filter((p) => p.expected === p.predicted).length;
  const supported = labels.filter((l) => perClass[l].support > 0);
  return {
    n: pairs.length,
    accuracy: round(correct / Math.max(pairs.length, 1)),
    macroF1: round(supported.reduce((s, l) => s + perClass[l].f1, 0) / Math.max(supported.length, 1)),
    perClass,
    confusion: matrix,
  };
}

export function ordinalMetrics(pairs, legendLength) {
  if (!pairs.length) return { n: 0 };
  const absErr = pairs.map((p) => Math.abs(p.expected - p.predicted));
  const within1 = absErr.filter((e) => e <= 1).length;
  return {
    n: pairs.length,
    mae: round(absErr.reduce((s, e) => s + e, 0) / pairs.length),
    within1Accuracy: round(within1 / pairs.length),
    exactAccuracy: round(absErr.filter((e) => e === 0).length / pairs.length),
    scale: legendLength,
  };
}

export function binaryMetrics(pairs, steps = 11) {
  if (!pairs.length) return { n: 0 };
  const sweep = [];
  for (let i = 0; i < steps; i += 1) {
    const threshold = i / (steps - 1);
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const { positive, probability } of pairs) {
      const predicted = probability >= threshold;
      if (predicted && positive) tp += 1;
      else if (predicted && !positive) fp += 1;
      else if (!predicted && positive) fn += 1;
    }
    const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
    const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    sweep.push({
      threshold: round(threshold),
      precision: round(precision),
      recall: round(recall),
      f1: round(f1),
      flagged: tp + fp,
    });
  }
  const best = sweep.reduce((a, b) => (b.f1 > a.f1 ? b : a));
  const positives = pairs.filter((p) => p.positive).length;
  return {
    n: pairs.length,
    positiveRate: round(positives / pairs.length),
    bestThreshold: best.threshold,
    bestF1: best.f1,
    bestPrecision: best.precision,
    bestRecall: best.recall,
    sweep,
  };
}

function round(n) {
  return Math.round(n * 1000) / 1000;
}

export async function evaluateDomain({ domain, dataset, answerer }) {
  const schema = getSchema(domain);
  const choicePairs = [];
  const ordinalPairs = [];
  const binaryPairs = [];
  const perQuestion = {};
  const misses = [];
  let otherPicks = 0;
  let labelCount = 0;

  for (const example of dataset) {
    const result = await answerer(domain, example.state);
    for (const [key, question] of Object.entries(schema.questions)) {
      const answer = result.answers?.[key];
      const expected = example.expected?.[key];
      if (!answer) continue;
      perQuestion[key] ??= { observed: 0 };
      perQuestion[key].observed += 1;

      if (question.type === 'choice') {
        if (expected !== undefined) {
          choicePairs.push({ key, expected, predicted: answer.label });
          (perQuestion[key].pairs ??= []).push({ expected, predicted: answer.label });
          labelCount += 1;
          if (answer.label === 'other') otherPicks += 1;
          if (answer.label !== expected) {
            misses.push({ id: example.id ?? '?', key, expected, predicted: answer.label, confidence: round(answer.confidence) });
          }
        }
      } else if (question.type === 'score') {
        if (expected !== undefined) {
          const expectedIndex = typeof expected === 'number' ? expected : question.legend.indexOf(expected);
          (perQuestion[key].pairs ??= []).push({ expected: expectedIndex, predicted: answer.index });
          ordinalPairs.push({ key, expected: expectedIndex, predicted: answer.index });
          if (answer.index !== expectedIndex) {
            misses.push({ id: example.id ?? '?', key, expected: question.legend[expectedIndex], predicted: answer.level, confidence: null });
          }
        }
      } else {
        if (expected !== undefined) {
          const positive = expected === true || expected === 'true' || expected === 1;
          (perQuestion[key].pairs ??= []).push({ positive, probability: answer.probability });
          binaryPairs.push({ key, positive, probability: answer.probability });
          if (positive !== answer.probability >= 0.5) {
            misses.push({ id: example.id ?? '?', key, expected: positive, predicted: answer.probability >= 0.5, confidence: round(answer.probability) });
          }
        }
      }
    }
  }

  const report = {
    domain,
    examples: dataset.length,
    choice: {},
    ordinal: {},
    binary: {},
    otherRate: labelCount ? round(otherPicks / labelCount) : 0,
    misses: misses.slice(0, 12),
    missCount: misses.length,
  };

  const byKey = (rows, key) => rows.filter((r) => r.key === key);
  for (const [key, question] of Object.entries(schema.questions)) {
    if (question.type === 'choice') {
      const pairs = byKey(choicePairs, key);
      if (pairs.length) report.choice[key] = classificationMetrics(pairs);
    } else if (question.type === 'score') {
      const pairs = byKey(ordinalPairs, key);
      if (pairs.length) report.ordinal[key] = ordinalMetrics(pairs, question.legend.length);
    } else {
      const pairs = byKey(binaryPairs, key);
      if (pairs.length) report.binary[key] = binaryMetrics(pairs);
    }
  }
  return report;
}

export function formatReport(report) {
  const lines = [];
  lines.push(`\n=== ${report.domain} — ${report.examples} examples, ${report.missCount} misses ===`);
  for (const [key, m] of Object.entries(report.choice)) {
    lines.push(`  choice ${key}: accuracy ${(m.accuracy * 100).toFixed(1)}%  macro-F1 ${m.macroF1}  (n=${m.n})`);
    for (const [label, c] of Object.entries(m.perClass)) {
      if (!c.support) continue;
      lines.push(
        `    ${label.padEnd(16)} P ${c.precision.toFixed(2)}  R ${c.recall.toFixed(2)}  F1 ${c.f1.toFixed(2)}  n ${c.support}`,
      );
    }
  }
  for (const [key, m] of Object.entries(report.ordinal)) {
    lines.push(
      `  score  ${key}: exact ${(m.exactAccuracy * 100).toFixed(1)}%  within-1 ${(m.within1Accuracy * 100).toFixed(1)}%  MAE ${m.mae}  (n=${m.n})`,
    );
  }
  for (const [key, m] of Object.entries(report.binary)) {
    lines.push(
      `  noul   ${key}: best threshold ${m.bestThreshold} -> F1 ${m.bestF1} (P ${m.bestPrecision} / R ${m.bestRecall})  base rate ${m.positiveRate}  (n=${m.n})`,
    );
  }
  lines.push(`  "other" selected ${report.otherRate ? (report.otherRate * 100).toFixed(1) : '0.0'}% of the time (high = your answer space is wrong)`);
  for (const miss of report.misses) {
    lines.push(`    miss ${miss.id} ${miss.key}: expected ${miss.expected}, got ${miss.predicted}${miss.confidence !== null ? ` (conf ${miss.confidence})` : ''}`);
  }
  return lines.join('\n');
}
