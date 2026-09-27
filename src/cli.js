#!/usr/bin/env node
import { DOMAINS } from './schemas.js';
import { evalAll, loadFixtures, runPipeline } from './pipeline.js';
import { formatReport } from './eval.js';
import { hasApiKey } from './client.js';

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        args[key] = next;
        i += 1;
      } else {
        args[key] = true;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

const USAGE = `jev-decisions — typed decision layer for backend engineering

  node src/cli.js demo                 run one example per domain through the local baseline
  node src/cli.js eval                 score the local baseline on bundled fixtures (no key needed)
  node src/cli.js eval --mode jev      score the hosted decision model instead (needs OPENROUTER_API_KEY)
  node src/cli.js ask --domain log_error --json '{"message":"connection refused ..."}'
  node src/cli.js list                 show domains and their question schemas
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] ?? 'help';

  if (command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  if (command === 'list') {
    const { SCHEMAS } = await import('./schemas.js');
    for (const domain of DOMAINS) {
      process.stdout.write(`\n${domain}\n`);
      for (const [key, q] of Object.entries(SCHEMAS[domain].questions)) {
        const space = q.type === 'choice' ? Object.keys(q.criteria).join('|')
          : q.type === 'score' ? q.legend.join('|')
          : '0..1';
        process.stdout.write(`  ${key} (${q.type}): ${space}\n`);
      }
    }
    return;
  }

  if (command === 'demo') {
    for (const domain of DOMAINS) {
      const example = loadFixtures(domain)[0];
      const result = await runPipeline({ domain, state: example.state, mode: 'baseline' });
      process.stdout.write(`\n[${domain}] ${summarize(example.state)}\n`);
      process.stdout.write(`  expected : ${JSON.stringify(example.expected)}\n`);
      process.stdout.write(`  answers  : ${render(result.answers)}\n`);
      process.stdout.write(`  ACTION   : ${result.decision.action}\n`);
      process.stdout.write(`  reason   : ${result.decision.reason}\n`);
    }
    return;
  }

  if (command === 'eval') {
    const mode = args.mode ?? 'baseline';
    if (mode === 'jev' && !hasApiKey()) {
      process.stderr.write(
        'eval --mode jev needs OPENROUTER_API_KEY. Run "npm run eval" for the offline baseline.\n',
      );
      process.exitCode = 2;
      return;
    }
    const domains = args.domain ? [args.domain] : DOMAINS;
    const reports = await evalAll({ mode, domains });
    for (const report of reports) process.stdout.write(`${formatReport(report)}\n`);
    const summary = reports.map((r) => {
      const choices = Object.values(r.choice);
      const acc = choices.length
        ? (choices.reduce((s, m) => s + m.accuracy, 0) / choices.length * 100).toFixed(1)
        : 'n/a';
      return `${r.domain}: choice accuracy ${acc}%  misses ${r.missCount}/${r.examples * 3}`;
    });
    process.stdout.write(`\n--- baseline summary (mode=${mode}) ---\n${summary.join('\n')}\n`);
    return;
  }

  if (command === 'ask') {
    const domain = args.domain;
    if (!domain) {
      process.stderr.write('ask needs --domain and --json\n');
      process.exitCode = 2;
      return;
    }
    const state = args.json ? JSON.parse(args.json) : {};
    const mode = args.mode ?? (hasApiKey() ? 'jev' : 'baseline');
    const result = await runPipeline({ domain, state, mode });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (command === 'live') {
    if (!hasApiKey()) {
      process.stderr.write(
        'live needs OPENROUTER_API_KEY — this package never invents a response when it is absent.\n',
      );
      process.exitCode = 2;
      return;
    }
    const example = loadFixtures('log_error')[0];
    const result = await runPipeline({ domain: 'log_error', state: example.state, mode: 'jev' });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
  process.exitCode = 2;
}

function summarize(state) {
  const text = typeof state === 'string' ? state : state.message ?? state.summary ?? state.title ?? JSON.stringify(state);
  return String(text).slice(0, 96);
}

function render(answers) {
  return Object.entries(answers)
    .map(([key, a]) => {
      if (a.type === 'choice') return `${key}=${a.label}(${a.confidence.toFixed(2)})`;
      if (a.type === 'score') return `${key}=${a.level}`;
      return `${key}=${a.probability.toFixed(2)}`;
    })
    .join('  ');
}

main().catch((error) => {
  process.stderr.write(`error: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
