import type { JiraPriority } from './deadline';

export interface TransitionOption {
  id: string;
  name: string;
  to?: { name?: string; statusCategory?: { key?: string } };
}

/** Prefer a transition named like one of the targets; otherwise any transition into a "done" status. */
export function pickTransition(
  transitions: TransitionOption[],
  targetNames: string[],
): TransitionOption | null {
  for (const target of targetNames.map((n) => n.toLowerCase())) {
    const named = transitions.find(
      (t) => t.name.toLowerCase() === target || t.to?.name?.toLowerCase() === target,
    );
    if (named) return named;
  }
  return transitions.find((t) => t.to?.statusCategory?.key === 'done') ?? null;
}

const PRIORITY_ALIASES: Record<JiraPriority, string[]> = {
  Highest: ['highest', 'critical', 'blocker', 'urgent', 'p1'],
  High: ['high', 'major', 'p2'],
  Medium: ['medium', 'normal', 'moderate', 'p3'],
};

/**
 * Maps our urgency level onto the site's own priority names. Falls back to rank: Jira lists priorities
 * highest first, so Highest takes the first entry, High the second and Medium the third.
 */
export function pickPriority(available: string[], level: JiraPriority): string | null {
  if (available.length === 0) return null;
  const lower = available.map((n) => n.toLowerCase());
  for (const alias of PRIORITY_ALIASES[level]) {
    const index = lower.indexOf(alias);
    if (index !== -1) return available[index] ?? null;
  }
  const rank = { Highest: 0, High: 1, Medium: 2 }[level];
  return available[Math.min(rank, available.length - 1)] ?? null;
}
