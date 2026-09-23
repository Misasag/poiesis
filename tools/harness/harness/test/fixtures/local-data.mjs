import path from 'node:path';
import { write, writeJson } from '../../bin/lib/util.mjs';

// Historical routing expectations are intentionally independent of owner policy.
export const policy = {
  version: 2,
  data_policy: { allow_may_train: true, repo_visibility: 'public' },
  lambda_cost: .05, lambda_time: .0001, quota_first: true, explore_share: .2,
  min_n_for_promotion: 10, noninferiority_margin: .05,
  task_classes: ['app-backend', 'app-frontend', 'app-test', 'harness', 'docs', 'mechanical'],
  roles: {
    orchestrator: { fixed: true, incumbent: 'Claude Code session' },
    'worker-design': { incumbent: 'codex:gpt-6-astra', effort: 'xhigh', challengers: ['codex:gpt-6-sol', 'claude:opus', 'or:glm-5.3', 'or:kimi-k3'] },
    'worker-mech': { incumbent: 'codex:gpt-6-luna', effort: 'medium', challengers: ['codex:gpt-6-sol', 'or:glm-5.3-flash', 'or:deepseek-v4.1-flash', 'or:mimo-v2.6-pro', 'grok:default'] },
    reviewer: { incumbent: 'claude:opus', fallback: 'codex:gpt-6-sol' },
    gate: { incumbent: 'jev', effort: 'default' },
    judge: { incumbent: 'claude:opus', fallback: 'codex:gpt-6-sol', challengers: ['or:glm-5.3', 'or:deepseek-v4.1-flash'] },
    recon: { incumbent: 'grok:default' }
  }
};
export const limits = { metered: { monthly_usd: 30, daily_usd: 5, per_run_usd: 1, conservative_default_usd: .5 }, quota: { runs_per_day: null, per_model_runs_per_day: null } };
export const subscriptions = [
  { id: 'chatgpt', label: 'ChatGPT', covers: ['codex'], monthly_fee_usd: null },
  { id: 'claude', label: 'Claude', covers: ['claude'], monthly_fee_usd: null },
  { id: 'supergrok', label: 'SuperGrok', covers: ['grok'], monthly_fee_usd: null }
];
export function seedLocalData(ctx) {
  writeJson(path.join(ctx.data, 'routing/policy.json'), policy);
  writeJson(path.join(ctx.data, 'budget/limits.json'), limits);
  writeJson(path.join(ctx.data, 'budget/subscriptions.json'), subscriptions);
  // An empty ledger is part of the fixture, rather than an absent live file.
  write(path.join(ctx.data, 'ledger/runs.jsonl'), '');
}
