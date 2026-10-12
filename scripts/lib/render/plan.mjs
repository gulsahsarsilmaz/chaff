/**
 * `chaff plan`: actions grouped by tier, each with what it reclaims and why.
 */
import { paths } from '../paths.mjs';
import { gb } from './format.mjs';

export function renderPlan(plan) {
  const TIER = {
    1: ['TIER 1 — DEAD', 'provably safe: what this belongs to no longer exists'],
    2: ['TIER 2 — IDLE', 'safe, but costs a cold rebuild or a re-download'],
    3: ['TIER 3 — LIVE', 'touches running work or uncommitted code — never automatic'],
  };
  const L = [''];
  if (plan.breached.length) {
    L.push('  ⚠ thresholds breached:');
    for (const b of plan.breached) L.push(`      · ${b}`);
    L.push('');
  }
  for (const tier of [1, 2, 3]) {
    const as = plan.actions.filter((a) => a.tier === tier);
    if (!as.length) continue;
    L.push(`  ${TIER[tier][0]}  ·  ${as.length} action${as.length === 1 ? '' : 's'}  ·  ~${gb(as.reduce((n, a) => n + a.reclaimMb, 0))}GB`);
    L.push(`  ${TIER[tier][1]}`);
    for (const a of as.slice(0, 30)) {
      L.push(`      ${a.kind.padEnd(16)}${(gb(a.reclaimMb) + 'GB').padStart(8)}  ${a.target.replace(paths.home, '~')}${a.blocked ? `  [${a.blocked}]` : ''}`);
      L.push(`      ${' '.repeat(16)}          ↳ ${a.reason}`);
    }
    if (as.length > 30) L.push(`      … and ${as.length - 30} more`);
    L.push('');
  }
  if (!plan.actions.length) L.push('  Nothing to separate. Everything here is live.\n');
  const r = plan.reclaimable;
  L.push(`  reclaimable:  tier1 ${gb(r.tier1Mb)}GB   tier1+2 ${gb(r.tier1Mb + r.tier2Mb)}GB   all tiers ${gb(r.tier1Mb + r.tier2Mb + r.tier3Mb)}GB`);
  L.push(`  policy: ${plan.policy}`);
  L.push('');
  return L.join('\n');
}
