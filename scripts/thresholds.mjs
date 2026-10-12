/**
 * When is a machine over its limits? One answer, used by the plan, the status tiles, the
 * statusline and the SessionStart hook. They used to ask separately and disagree: the plan
 * counted build cache alone against `cacheGb` while everything on screen counted cache plus
 * output, and the hook carried its own copy of the defaults (a fixed 4GB memory limit where
 * the real default scales with RAM). Kept free of other chaff imports so the hooks stay cheap.
 */
import { totalmem } from 'node:os';

// A fixed RSS ceiling means different things on different machines: 4GB is most of an 8GB
// laptop and noise on a 64GB workstation, where the warning latches on and stays on until
// you stop reading it. Scale it to the machine; an explicit config value still wins.
export const defaultRssMb = () => Math.max(4096, Math.round((totalmem() / 1048576) * 0.35));

export const defaultThresholds = () => ({
  nodeRssMb: defaultRssMb(),  // ~35% of physical RAM, floor 4GB
  daemons: 4,
  diskFreeGb: 60,
  cacheGb: 3,                 // build cache + build output: what the statusline calls junk
  worktrees: 25,
  storeGb: 10,
});

/** Build cache plus build output, in MB: everything regenerable inside projects. */
export const junkMb = (s) => (s.totals.cacheMb || 0) + (s.totals.outputMb || 0);

const g = (mb) => (mb / 1024).toFixed(1);

/**
 * Every limit currently exceeded, as `{ key, text }`. `t` is a full thresholds object
 * (defaults merged with the user's). Keys: memory, daemons, disk, junk, worktrees, stores.
 */
export function breaches(s, t) {
  const out = [];
  const add = (key, text) => out.push({ key, text });
  if (s.totals.nodeRssMb > t.nodeRssMb) add('memory', `toolchain memory ${g(s.totals.nodeRssMb)}GB across ${s.totals.nodeProcs} processes > ${g(t.nodeRssMb)}GB`);
  if (s.totals.daemons > t.daemons) add('daemons', `${s.totals.daemons} build daemons > ${t.daemons}`);
  if (s.disk.freeGb < t.diskFreeGb) add('disk', `${s.disk.freeGb}GB disk free < ${t.diskFreeGb}GB`);
  if (junkMb(s) / 1024 > t.cacheGb) add('junk', `${g(junkMb(s))}GB of build cache and output > ${t.cacheGb}GB`);
  if (s.totals.worktrees > t.worktrees) add('worktrees', `${s.totals.worktrees} git worktrees > ${t.worktrees}`);
  if (s.totals.storeMb / 1024 > t.storeGb) add('stores', `${g(s.totals.storeMb)}GB of package stores > ${t.storeGb}GB`);
  return out;
}
