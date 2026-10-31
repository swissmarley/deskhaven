import type { UsageSnapshot } from '@deskhaven/shared';

/**
 * What agents that were fired spent today: the office's "today" (the header) minus today's spend of
 * the agents still on staff. Below a hundredth of a cent it is rounding noise and reads as 0.
 */
export function firedAgentsToday(
  usage: Pick<UsageSnapshot, 'today' | 'perAgentToday'> | null | undefined,
): number {
  if (!usage?.perAgentToday) return 0;
  let staff = 0;
  for (const t of Object.values(usage.perAgentToday)) staff += t.costUsd;
  const gap = usage.today.costUsd - staff;
  return gap > 0.0001 ? gap : 0;
}
