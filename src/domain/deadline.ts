export const ALERT_THRESHOLDS_HOURS = [8, 4, 1, 0] as const;

export type JiraPriority = 'Highest' | 'High' | 'Medium';

export interface DeadlineAlert {
  thresholdHours: number;
  hoursLeft: number;
  priority: JiraPriority;
  /** Every threshold this alert covers, so a sweep that ran late doesn't fire stale ones next. */
  covers: number[];
}

export function hoursLeft(dueAt: string, now: Date): number {
  return (Date.parse(dueAt) - now.getTime()) / 3_600_000;
}

export function priorityFor(thresholdHours: number): JiraPriority {
  if (thresholdHours <= 1) return 'Highest';
  if (thresholdHours <= 4) return 'High';
  return 'Medium';
}

/** The single most urgent alert that is due and not yet sent, or null. */
export function nextAlert(
  dueAt: string | null,
  alertsSent: number[],
  now: Date,
): DeadlineAlert | null {
  if (!dueAt || Number.isNaN(Date.parse(dueAt))) return null;
  const left = hoursLeft(dueAt, now);
  const crossed = ALERT_THRESHOLDS_HOURS.filter((t) => left <= t);
  const unsent = crossed.filter((t) => !alertsSent.includes(t));
  if (unsent.length === 0) return null;
  const thresholdHours = Math.min(...unsent);
  return {
    thresholdHours,
    hoursLeft: left,
    priority: priorityFor(thresholdHours),
    covers: crossed,
  };
}

export function describeTimeLeft(left: number): string {
  if (left <= 0) {
    const over = Math.abs(left);
    return over < 1 ? `overdue by ${Math.round(over * 60)} min` : `overdue by ${over.toFixed(1)} h`;
  }
  return left < 1 ? `${Math.round(left * 60)} min left` : `${left.toFixed(1)} h left`;
}
