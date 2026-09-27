import { getSchema } from './schemas.js';

export const POLICIES = {
  log_error: {
    escalate_at: 3,
    suppress_labels: ['expected_noise'],
    describe(answer) {
      if (
        this.suppress_labels.includes(answer.category.label) &&
        answer.novel.probability < 0.5
      ) {
        return { action: 'suppress', reason: `known benign condition (${answer.category.label}) and not novel (p=${fmt(answer.novel.probability)})` };
      }
      if (answer.severity.index >= this.escalate_at) {
        return { action: 'page_oncall', reason: `severity ${answer.severity.level} >= threshold, cause ${answer.category.label}` };
      }
      return { action: 'record', reason: `severity ${answer.severity.level} below page threshold` };
    },
  },
  incident_route: {
    escalate_at: 0.8,
    describe(answer) {
      if (answer.needs_human.probability >= this.escalate_at) {
        return { action: 'queue_for_human', reason: `needs_human p=${fmt(answer.needs_human.probability)} >= ${this.escalate_at}` };
      }
      if (answer.team.label === 'other') {
        return { action: 'queue_for_human', reason: 'router had no confident owner' };
      }
      return { action: `route:${answer.team.label}`, reason: `urgency ${answer.urgency.level}, confidence ${fmt(answer.team.confidence)}` };
    },
  },
  pr_triage: {
    escalate_at: 0.6,
    describe(answer) {
      const flags = [];
      if (answer.touches_sensitive.probability >= this.escalate_at) flags.push('sensitive-area');
      if (answer.change_type.label === 'migration') flags.push('migration');
      if (answer.review_depth.index >= 3) flags.push('large blast radius');
      if (!flags.length) return { action: `review:${answer.review_depth.level}`, reason: answer.change_type.label };
      const detail = flags.filter((f) => f !== answer.change_type.label);
      return {
        action: `review:${answer.review_depth.level}+request_human`,
        reason: detail.length
          ? `${answer.change_type.label}; ${detail.join(', ')} (sensitive p=${fmt(answer.touches_sensitive.probability)})`
          : `${answer.change_type.label} (sensitive p=${fmt(answer.touches_sensitive.probability)})`,
      };
    },
  },
  deploy_risk: {
    hold_at: 0.7,
    hold_index: 3,
    describe(answer) {
      if (answer.rollback.label === 'irreversible') {
        return { action: 'require_manual_approval', reason: 'change is irreversible; approval is mandatory' };
      }
      if (answer.should_block.probability >= this.hold_at) {
        return { action: 'require_manual_approval', reason: `should_block p=${fmt(answer.should_block.probability)} >= ${this.hold_at}` };
      }
      if (answer.risk.index >= this.hold_index) {
        return { action: 'require_manual_approval', reason: `risk ${answer.risk.level} >= ${this.hold_index}` };
      }
      return { action: 'allow_deploy', reason: `risk ${answer.risk.level}, rollback ${answer.rollback.label}` };
    },
  },
};

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(2) : String(n);
}

export function getPolicy(domain) {
  const policy = POLICIES[domain];
  if (!policy) throw new Error(`no policy for domain "${domain}"`);
  return policy;
}

export function applyPolicy(domain, answers) {
  const schema = getSchema(domain);
  const policy = getPolicy(domain);
  for (const key of Object.keys(schema.questions)) {
    if (!answers?.[key]) throw new Error(`answer for "${key}" is missing; cannot apply policy`);
  }
  const result = policy.describe(answers);
  return {
    domain,
    action: result.action,
    reason: result.reason,
    threshold: policyEscalation(policy),
    answers,
  };
}

function policyEscalation(policy) {
  return policy.escalate_at ?? policy.hold_at ?? policy.hold_index ?? null;
}
