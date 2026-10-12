/**
 * A fingerprint of what a plan would do up to a tier, so consent given to one plan cannot be
 * spent on another. Shared by the MCP server, which shows a plan and later asks for it to be
 * applied, and by `chaff apply --expect`, which refuses when the plan it builds has changed.
 *
 * Sizes are left out on purpose: a cache that grew by a megabyte between plan and apply is
 * the same cleanup. A new target, a different pid or a different tier is not.
 */
import { createHash } from 'node:crypto';

export function planDigest(actions, maxTier) {
  const lines = actions
    .filter((a) => a.tier <= maxTier && !a.blocked)
    .map((a) => [a.tier, a.kind, a.target, a.pid ?? ''].join('\t'))
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
}
