import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { baselineDecide } from './baseline.js';
import { decide } from './client.js';
import { applyPolicy } from './policy.js';
import { evaluateDomain, loadJsonl } from './eval.js';
import { DOMAINS, getSchema } from './schemas.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(HERE, '..', 'data');

export function loadFixtures(domain) {
  return loadJsonl(path.join(DATA_DIR, `${domain}.jsonl`));
}

export function makeAnswerer(mode = 'baseline', options = {}) {
  if (mode === 'jev') {
    return async (domain, state) => decide(domain, state, getSchema(domain), options);
  }
  if (mode !== 'baseline') throw new Error(`unknown mode "${mode}"; use 'baseline' or 'jev'`);
  return async (domain, state) => baselineDecide(domain, state, getSchema(domain));
}

export async function runPipeline({ domain, state, mode = 'baseline', options = {} }) {
  const schema = getSchema(domain);
  const result =
    mode === 'jev'
      ? await decide(domain, state, schema, options)
      : baselineDecide(domain, state, schema);
  return { ...result, domain, decision: applyPolicy(domain, result.answers) };
}

export async function evalAll({ mode = 'baseline', domains = DOMAINS, options = {} } = {}) {
  const answerer = makeAnswerer(mode, options);
  const reports = [];
  for (const domain of domains) {
    const report = await evaluateDomain({ domain, dataset: loadFixtures(domain), answerer });
    reports.push({ ...report, mode });
  }
  return reports;
}
