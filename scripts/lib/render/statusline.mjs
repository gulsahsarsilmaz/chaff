/**
 * The one-line summary for editor and shell statuslines. Runs on every prompt, so it only
 * formats a cached scan; it never measures anything itself.
 */
import { ANSI, gb } from './format.mjs';
import { breaches, junkMb } from '../../thresholds.mjs';

/**
 * Three ways to mark a breach, because a statusline is personal: `color` tints the metric
 * itself, `dots` keeps the emoji, `plain` marks nothing. NO_COLOR downgrades color to plain.
 */
export function renderStatusline(s, cfg) {
  const t = cfg.thresholds;
  const style = process.env.NO_COLOR && cfg.statuslineStyle === 'color' ? 'plain' : (cfg.statuslineStyle || 'color');
  const mark = (bad, text) => {
    if (style === 'dots') return `${bad ? '🔴' : '🟢'} ${text}`;
    if (style === 'color') return `${bad ? ANSI.red : ANSI.green}${text}${ANSI.off}`;
    return text;
  };
  // An inferred scope is flagged here too: the junk/worktree counts are only as complete
  // as the roots behind them, and this line is where most people read them.
  const scopeText = s.rootsRefused ? '⚠ no roots' : s.rootsInferred ? '⚠ cwd' : '';
  const scope = !scopeText ? ''
    : ' ' + (style === 'color' ? `${ANSI.yellow}${scopeText}${ANSI.off}` : scopeText);
  const over = new Set(breaches(s, t).map((b) => b.key));
  const junk = junkMb(s);
  // Counts of things a machine may simply not have — no daemons running, no worktrees
  // checked out — are dropped rather than shown as a green zero. A permanent `0d` on a
  // Rust or Python codebase is noise pretending to be a metric. Memory, disk and junk
  // always render: zero there is a real reading, not an absent concept.
  const segs = [
    [true, over.has('memory'), `${gb(s.totals.nodeRssMb)}G/${s.totals.nodeProcs}p`],
    [s.totals.daemons > 0, over.has('daemons'), `${s.totals.daemons}d`],
    [true, over.has('disk'), `${s.disk.freeGb}G free`],
    [true, over.has('junk'), `${gb(junk)}G junk`],
    [s.totals.worktrees > 0, over.has('worktrees'), `${s.totals.worktrees}wt`],
  ];
  return 'chaff' + scope + ' ' + segs.filter(([show]) => show).map(([, bad, text]) => mark(bad, text))
    .join(style === 'color' ? `${ANSI.dim} · ${ANSI.off}` : ' · ');
}
