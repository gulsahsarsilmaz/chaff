/**
 * Small formatting primitives every screen shares: sizes, bars, width, colour, wrapping.
 */

export const gb = (mb) => (mb / 1024).toFixed(1);
export const bar = (pct, w = 20) => {
  const n = Math.max(0, Math.min(w, Math.round((pct / 100) * w)));
  return '█'.repeat(n) + '░'.repeat(w - n);
};

/** Terminal width, with a conservative default: piped output reports nothing. */
export const termWidth = (override) => +override || process.stdout.columns || +process.env.COLUMNS || 80;

export const useColor = (cfg) => !process.env.NO_COLOR && (cfg.statuslineStyle || 'color') !== 'plain';
export const paint = (cfg, bad, text) => (useColor(cfg) ? `${bad ? ANSI.red : ANSI.green}${text}${ANSI.off}` : text);

export const fit = (txt, n) => (txt.length <= n ? txt.padEnd(n) : txt.slice(0, n - 1) + '…');

export const wrap = (txt, n) => txt.split(' ').reduce((lines, w) => {
  const last = lines[lines.length - 1];
  if (last && (last + ' ' + w).length <= n) lines[lines.length - 1] = last + ' ' + w;
  else lines.push(w);
  return lines;
}, []);

export const ANSI = { red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', off: '\x1b[0m' };
