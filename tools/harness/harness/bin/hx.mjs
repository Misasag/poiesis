#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { context, options, required, out, fail, git, redactor } from './lib/util.mjs';
import { run } from './lib/run.mjs';
import { verify } from './lib/verify.mjs';
import { judge, calibration } from './lib/judge.mjs';
import { route, scoreboard, tune, policy } from './lib/route.mjs';
import { budgetStatus, budgetCheck } from './lib/budget.mjs';
import { provider } from './lib/prices.mjs';
import { ledger, outcome } from './lib/ledger.mjs';
import { mine, benchRun } from './lib/bench.mjs';
import { accountStatus } from './lib/openrouter.mjs';
import { gate } from './lib/gate.mjs';
import { exhaustedQuota } from './lib/quota.mjs';

const ctx = context(), argv = process.argv.slice(2), command = argv.shift(), o = options(argv);
try {
  let result;
  switch (command) {
    case 'run': result = await run(ctx, o); break;
    case 'verify': result = await verify(ctx, o); break;
    case 'judge': result = await judge(ctx, o); break;
    case 'gate': result = await gate(ctx, o); break;
    case 'route': {
      required(o, 'role'); result = route(ctx, o);
      if (!o.json && !o.explain) { out(result.model); process.exit(0); }
      if (o.explain && !o.json) {
        out(`model=${result.model} effort=${result.effort ?? 'default'} exploring=${result.exploring} utility=${result.utility?.toFixed(4)}`);
        for (const b of result.skipped.quota_exhausted) out(`skipped ${b.model}: quota ${b.quota} exhausted, resets ${b.reset}`);
        process.exit(0);
      }
      break;
    }
    case 'scoreboard': result = o._[0] === 'judge-calibration' ? calibration(ctx) : scoreboard(ctx, Boolean(o.write)); break;
    case 'judge-calibration': result = calibration(ctx); break;
    case 'outcome': required(o, 'run', 'result'); result = outcome(ctx, o.run, o.result, o.note); break;
    case 'tune': result = tune(ctx, Boolean(o.apply)); break;
    case 'budget': {
      if (o._[0] === 'check') { required(o, 'model'); result = budgetCheck(ctx, provider(ctx, o.model), o['estimate-usd']); if (!result.allowed) result.exit_code = 3; }
      else if (o._[0] === 'status') { const b = budgetStatus(ctx); result = { month_usd: b.month_usd, day_usd: b.day_usd, quota_runs_today: b.quota_today.length, limits: b.limits, openrouter: await accountStatus() }; }
      else fail('Usage: hx budget status|check [--model id]');
      break;
    }
    case 'bench':
      if (o._[0] === 'mine') result = await mine(ctx, o);
      else if (o._[0] === 'run') result = await benchRun(ctx, o);
      else fail('Usage: hx bench mine|run');
      break;
    case 'dogfood': result = await (await import('./lib/dogfood.mjs')).dogfood(ctx, o); break;
    case 'status': {
      const budget = budgetStatus(ctx), tickets = path.join(ctx.data, 'tickets'), exhausted = exhaustedQuota(ctx);
      const active = fs.existsSync(tickets) ? fs.readdirSync(tickets).filter(f => f.endsWith('.md')).filter(f => !/^state:\s*["']?(?:done|confirmed|確定)/mi.test(fs.readFileSync(path.join(tickets, f), 'utf8'))) : [];
      const branch = (await git(ctx.root, ['branch', '--show-current'])).stdout.trim() || '(detached)';
      const last = ledger(ctx).filter(r => !r.kind).slice(-5).map(r => ({ run_id: r.run_id, model: r.model, exit_code: r.exit_code, wall_s: r.wall_s }));
      result = { branch, active_tickets: active, policy_version: policy(ctx).version, month_usd: budget.month_usd, quota_runs_today: budget.quota_today.length, exhausted_quota: Object.fromEntries(Object.entries(exhausted).map(([key, e]) => [key, { exhausted_until: e.exhausted_until, source: e.source, seen_at: e.seen_at }])), last_runs: last };
      if (!o.json) {
        out(`branch=${branch} policy=${result.policy_version} month_usd=${budget.month_usd.toFixed(4)} quota_today=${budget.quota_today.length}`);
        out(`active_tickets=${active.length ? active.join(', ') : 'none'}`);
        for (const [key, e] of Object.entries(exhausted)) out(`exhausted ${key} until ${e.exhausted_until ?? 'state edited'} source=${e.source} seen=${e.seen_at}`);
        for (const r of last) out(`${r.run_id} ${r.model} exit=${r.exit_code} wall_s=${r.wall_s}`);
        if (!last.length) out('last_runs=none');
        process.exit(0);
      }
      break;
    }
    case 'help': case '--help': case undefined:
      out('hx run|verify|gate|judge|route|scoreboard|outcome|tune|budget|bench|dogfood|status|judge-calibration [--json]'); process.exit(0);
    default: fail(`Unknown command: ${command}`);
  }
  out(redactor()(result)); process.exitCode = result?.exit_code ?? 0;
} catch (error) {
  out({ error: redactor()(error.message), exit_code: error.exitCode ?? 1 }); process.exitCode = error.exitCode ?? 1;
}
