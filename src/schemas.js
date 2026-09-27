import { choice, noul, score } from './questions.js';

export const DOMAINS = ['log_error', 'incident_route', 'pr_triage', 'deploy_risk'];

export const SCHEMAS = {
  log_error: {
    labelKey: 'category',
    questions: {
      category: choice(
        'What is the most likely root cause class for this error?',
        {
          dependency:
            'A downstream service or datastore is unreachable, refusing connections, timing out, or returning 5xx',
          config:
            'Bad, missing, or drifted configuration: unknown host, invalid credentials, rejected auth, missing or invalid flag',
          capacity:
            'Saturation or a limit being hit: out of memory, disk full, connection pool exhausted, rate limited, quota, queue depth',
          code_defect:
            'A bug in this service itself: null reference, assertion, unhandled case, panic, stack overflow, regression from a recent change',
          user_input:
            'Rejected client input: validation failure, malformed or invalid payload, schema mismatch, oversized body',
          expected_noise:
            'Benign known condition: routine retry that succeeded, client disconnect, graceful shutdown, cancelled request, probe',
          other: 'None of the other options explains this well',
        },
      ),
      severity: score('How severe is this error, given impact and blast radius?', [
        'cosmetic',
        'low',
        'medium',
        'high',
        'critical',
      ]),
      novel: noul(
        'Is this a new failure mode rather than a condition already seen repeatedly in this window?',
      ),
    },
  },

  incident_route: {
    labelKey: 'team',
    questions: {
      team: choice(
        'Which team owns the fix for this request?',
        {
          payments:
            'Charges, refunds, payouts, settlement, invoices, billing portal, card or bank processing',
          platform:
            'Shared infrastructure and runtime: build system, deployment, Kubernetes, databases, caches, message queues, networking',
          frontend:
            'User-facing web or mobile application behaviour, rendering, UI copy, client-side errors',
          identity:
            'Login, authentication, sessions, authorization and permissions, SSO, MFA, API keys and tokens',
          data: 'Pipelines, ETL, warehousing, analytics tables, data quality and freshness',
          other: 'Ownership is genuinely unclear or belongs elsewhere',
        },
      ),
      urgency: score('How urgent is this, given customer impact?', [
        'none',
        'low',
        'normal',
        'high',
        'urgent',
      ]),
      needs_human: noul('Does this request require a human to review it before any action is taken?'),
    },
  },

  pr_triage: {
    labelKey: 'change_type',
    questions: {
      change_type: choice(
        'What kind of change is this pull request?',
        {
          migration: 'Database or schema migration, backfill, data rewrite, table change',
          api_contract: 'Changes a public or cross-service interface: routes, request or response fields, protobuf, event schema',
          dependency: 'Adds, removes, or bumps a third-party library or package',
          refactor: 'Restructures code without intended behaviour change',
          hotfix: 'Small urgent fix to production behaviour, typically few lines',
          test_only: 'Adds or changes tests, fixtures, or coverage only',
          docs: 'Documentation, comments, or README changes only',
          other: 'None of the other options explains this well',
        },
      ),
      review_depth: score(
        'How much review attention does this change need, given blast radius?',
        ['skim', 'standard', 'thorough', 'two_reviewers'],
      ),
      touches_sensitive: noul(
        'Does this change touch authentication, payments, personal data, or privilege handling?',
      ),
    },
  },

  deploy_risk: {
    labelKey: 'risk',
    questions: {
      risk: score(
        'How risky is this deployment, considering irreversibility and blast radius?',
        ['negligible', 'low', 'moderate', 'high', 'severe'],
      ),
      rollback: choice(
        'If this deploy goes wrong, how hard is it to undo?',
        {
          automatic: 'Reverting the previous build is sufficient and safe',
          manual_steps: 'Needs a human to run commands or flip a flag afterwards',
          needs_backup: 'Requires restoring data from backup or snapshot',
          irreversible: 'Cannot be undone once applied, such as a destructive migration or external write',
          other: 'None of the other options explains this well',
        },
      ),
      should_block: noul(
        'Should this deployment be held for explicit human approval before proceeding?',
      ),
    },
  },
};

export function getSchema(domain) {
  const schema = DOMAINS.includes(domain) ? SCHEMAS[domain] : null;
  if (!schema) {
    throw new Error(`unknown domain "${domain}"; expected one of ${DOMAINS.join(', ')}`);
  }
  return schema;
}
