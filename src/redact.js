const SECRET_PATTERNS = [
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'api_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: 'hf_token', re: /\bhf_[A-Za-z0-9]{20,}\b/g },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\b/g },
  { name: 'url_credentials', re: /\/\/[^\s/@:]+:[^\s@]+@/g },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi },
  {
    name: 'kv_secret',
    re: /\b(password|passwd|secret|token|api_key|apikey|access_key|private_key|client_secret)\b(["']?\s*[:=]\s*)["']?[^\s"',;]{4,}["']?/gi,
    keepKey: true,
  },
];

const PII_PATTERNS = [
  { name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { name: 'card', re: /\b(?:\d[ -]*?){13,16}\b/g },
];

function redactString(text, patterns) {
  let hits = 0;
  let out = text;
  for (const pattern of patterns) {
    out = out.replace(pattern.re, (...args) => {
      hits += 1;
      if (pattern.keepKey) {
        const [, key, separator] = args;
        return `${key}${separator}«redacted:${pattern.name}»`;
      }
      return `«redacted:${pattern.name}»`;
    });
  }
  return { value: out, hits };
}

export function redact(value, options = {}) {
  const patterns = [...SECRET_PATTERNS];
  if (options.emails) patterns.push(PII_PATTERNS[0]);
  if (options.cards) patterns.push(PII_PATTERNS[1]);

  if (typeof value === 'string') return redactString(value, patterns);

  if (Array.isArray(value)) {
    let hits = 0;
    const items = value.map((entry) => {
      const result = redact(entry, options);
      hits += result.hits;
      return result.value;
    });
    return { value: items, hits };
  }

  if (value && typeof value === 'object') {
    let hits = 0;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
      const result = redact(entry, options);
      hits += result.hits;
      out[key] = result.value;
    }
    return { value: out, hits };
  }

  return { value, hits: 0 };
}

export function redactedPreview(value, options = {}) {
  const result = redact(value, options);
  return { state: result.value, redactedCount: result.hits };
}
