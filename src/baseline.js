const STOPWORDS = new Set(
  `a an the and or of to in for on with by is are be this that it its from as at not no nor but
   if then than so such can could will would should may might must has have had was were being been
   does did done into onto their there here which who whom whose what when where how all any each
   some most more other others per via using used use given needs need rather less fewer about
`.split(/\s+/),
);

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((token) => token.length > 2 && !STOPWORDS.has(token));
}

function stateText(state) {
  if (typeof state === 'string') return state;
  const parts = [];
  const walk = (value) => {
    if (typeof value === 'string') parts.push(value);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(String(value));
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  walk(state);
  return parts.join(' ');
}

function numberField(state, names) {
  for (const name of names) {
    const value = state?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

function boolField(state, names) {
  for (const name of names) {
    const value = state?.[name];
    if (typeof value === 'boolean') return value;
  }
  return null;
}

export function lexicalChoice(text, criteria) {
  const haystack = new Set(tokenize(text));
  const scores = [];
  for (const [label, description] of Object.entries(criteria)) {
    const needles = new Set(tokenize(`${label.replaceAll('_', ' ')} ${description}`));
    let overlap = 0;
    for (const needle of needles) if (haystack.has(needle)) overlap += 1;
    scores.push({ label, overlap });
  }
  scores.sort((a, b) => b.overlap - a.overlap);
  const total = scores.reduce((sum, s) => sum + s.overlap, 0);
  const best = scores[0];
  if (!best || best.overlap === 0) {
    const fallback = 'other' in criteria ? 'other' : Object.keys(criteria)[0];
    return { label: fallback, confidence: 0 };
  }
  const runnerUp = scores[1]?.overlap ?? 0;
  const margin = best.overlap - runnerUp;
  const confidence = Math.min(0.95, 0.35 + 0.15 * margin + 0.5 * (best.overlap / Math.max(total, 1)));
  return { label: best.label, confidence };
}

function clampIndex(value, length) {
  return Math.min(length - 1, Math.max(0, Math.round(value)));
}

function ordinalFrom(text, orderedTerms) {
  const lower = String(text).toLowerCase();
  let best = -1;
  for (let i = 0; i < orderedTerms.length; i += 1) {
    if (lower.includes(orderedTerms[i])) best = i;
  }
  return best;
}

const SEVERITY_TERMS = ['cosmetic', 'low', 'medium', 'high', 'critical'];
const URGENCY_TERMS = ['none', 'low', 'normal', 'high', 'urgent'];
const DEPTH_TERMS = ['skim', 'standard', 'thorough', 'two'];
const RISK_TERMS = ['negligible', 'low', 'moderate', 'high', 'severe'];

export const RULES = {
  log_error: {
    severity(state, text) {
      const legend = this.legend;
      let index = 1;
      const rate = numberField(state, ['error_rate', 'errorRate', 'failure_rate']);
      if (rate !== null) index = Math.max(index, Math.min(4, Math.round(rate * 8)));
      if (/\bdown|outage|all users|total|data loss|corrupt/i.test(text)) index = 4;
      else if (/\btimeout|unreachable|exhausted|refused|oom|panic/i.test(text)) index = Math.max(index, 3);
      else if (/\bdegrad|slow|retry/i.test(text)) index = Math.max(index, 2);
      else if (/\bdeprecated|warning|notice|typo/i.test(text)) index = Math.min(index, 1);
      return { index: clampIndex(index, legend.length), level: legend[clampIndex(index, legend.length)] };
    },
    novel(state, text) {
      const seen = numberField(state, ['occurrences', 'seen_count', 'times_seen', 'count']);
      if (seen !== null) return { probability: seen <= 1 ? 0.85 : seen <= 5 ? 0.5 : 0.15 };
      if (/known|expected|recurring|flaky|routine/i.test(text)) return { probability: 0.2 };
      return { probability: 0.6 };
    },
  },
  incident_route: {
    urgency(state, text) {
      const legend = this.legend;
      let index = 2;
      const days = numberField(state, ['days_waiting', 'customer_count', 'affected_users']);
      if (days !== null && days >= 3) index = 3;
      if (/down|outage|cannot (pay|log in|access)|blocked/i.test(text)) index = 4;
      else if (/question|asking|curious|how do i/i.test(text)) index = 1;
      return { index: clampIndex(index, legend.length), level: legend[clampIndex(index, legend.length)] };
    },
    needs_human(state, text) {
      if (/refund|charge twice|lawsuit|legal|escalat|delete my account/i.test(text)) return { probability: 0.9 };
      if (/outage|down|data loss/i.test(text)) return { probability: 0.75 };
      if (/docs|how do i|question|pricing page/i.test(text)) return { probability: 0.15 };
      return { probability: 0.45 };
    },
  },
  pr_triage: {
    review_depth(state, text) {
      const legend = this.legend;
      let index = 1;
      const loc = numberField(state, ['loc_added', 'loc_changed', 'files_changed']);
      if (loc !== null) index = loc > 400 ? 3 : loc > 120 ? 2 : loc > 0 ? 1 : 1;
      if (/migration|drop table|delete from|schema|auth|payment/i.test(text)) index = Math.max(index, 2);
      if (/\b(readme|docs?|comment)\b|typo/i.test(text)) index = 0;
      return { index: clampIndex(index, legend.length), level: legend[clampIndex(index, legend.length)] };
    },
    touches_sensitive(state, text) {
      if (/password|token|oauth|permission|role|acl|authentic|authoriz/i.test(text)) return { probability: 0.9 };
      if (/payment|refund|charge|card|billing|pii|ssn|email address/i.test(text)) return { probability: 0.85 };
      if (/test|fixture|mock|readme|docs/i.test(text)) return { probability: 0.1 };
      return { probability: 0.3 };
    },
  },
  deploy_risk: {
    risk(state, text) {
      const legend = this.legend;
      let index = 1;
      if (/destructive|drop |truncate|irreversible|no rollback|delete/i.test(text)) index = 4;
      else if (/migration|backfill|schema/i.test(text)) index = 3;
      else if (/config|flag|feature toggle/i.test(text)) index = 2;
      else if (/docs|comment|typo|test only/i.test(text)) index = 0;
      const replicas = numberField(state, ['replicas_affected', 'services_affected']);
      if (replicas !== null && replicas > 5) index = Math.max(index, 3);
      return { index: clampIndex(index, legend.length), level: legend[clampIndex(index, legend.length)] };
    },
    should_block(state, text) {
      if (/irreversible|drop table|truncate|no backup|destructive/i.test(text)) return { probability: 0.9 };
      if (/migration|backfill/i.test(text)) return { probability: 0.6 };
      if (/flag|config|docs|typo/i.test(text)) return { probability: 0.1 };
      return { probability: 0.35 };
    },
  },
};

export function baselineDecide(domain, state, schema) {
  const text = stateText(state);
  const rules = RULES[domain] ?? {};
  const answers = {};
  for (const [key, question] of Object.entries(schema.questions)) {
    if (question.type === 'choice') {
      const picked = lexicalChoice(text, question.criteria);
      answers[key] = { type: 'choice', label: picked.label, confidence: picked.confidence };
    } else if (question.type === 'score') {
      const terms =
        key === 'severity' ? SEVERITY_TERMS
        : key === 'urgency' ? URGENCY_TERMS
        : key === 'review_depth' ? DEPTH_TERMS
        : key === 'risk' ? RISK_TERMS
        : question.legend.map((l) => l.toLowerCase());
      const rule = rules[key];
      if (typeof rule === 'function') {
        const result = rule.call({ legend: question.legend }, state, text);
        answers[key] = { type: 'score', ...result };
      } else {
        const explicit = ordinalFrom(text, terms);
        const index = explicit >= 0 ? clampIndex(explicit, question.legend.length) : Math.floor((question.legend.length - 1) / 2);
        answers[key] = { type: 'score', index, level: question.legend[index] };
      }
    } else {
      const rule = rules[key];
      const probability = typeof rule === 'function'
        ? rule.call({}, state, text).probability
        : 0.5;
      answers[key] = { type: 'noul', probability };
    }
  }
  return { source: 'baseline', answers, usage: null, redactedFields: 0 };
}
