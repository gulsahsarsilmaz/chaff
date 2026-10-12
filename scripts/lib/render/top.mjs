/**
 * `chaff top`: processes by memory, attributed to their project.
 */
import { paths } from '../paths.mjs';
import { gb } from './format.mjs';

export function renderTop(s, limit) {
  const procs = s.processes
    .filter((p) => p.type !== 'other')
    .sort((a, b) => b.rssMb - a.rssMb)
    .slice(0, limit);
  const L = ['', `  chaff top  ·  ${s.totals.nodeProcs} processes  ·  ${gb(s.totals.nodeRssMb)}GB`, '  ' + '─'.repeat(76)];
  L.push('     PID   RSS    CPU   AGE  TYPE          PROJECT');
  for (const p of procs) {
    const age = p.ageSec > 3600 ? `${Math.round(p.ageSec / 3600)}h` : `${Math.round(p.ageSec / 60)}m`;
    L.push(`  ${String(p.pid).padStart(6)} ${(p.rssMb + 'M').padStart(6)} ${(p.cpu.toFixed(0) + '%').padStart(5)} ${age.padStart(5)}  ${p.type.padEnd(13)} ${(p.project || '—').replace(paths.home, '~')}`);
  }
  // Roll up by project so the real cost centre is obvious.
  const byProj = {};
  for (const p of s.processes) {
    if (p.type === 'claude' || !p.project) continue;
    byProj[p.project] = (byProj[p.project] || 0) + p.rssMb;
  }
  const top = Object.entries(byProj).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (top.length) {
    L.push('', '  BY PROJECT');
    for (const [proj, mb] of top) L.push(`  ${(gb(mb) + 'GB').padStart(8)}  ${proj.replace(paths.home, '~')}`);
  }
  L.push('');
  return L.join('\n');
}
