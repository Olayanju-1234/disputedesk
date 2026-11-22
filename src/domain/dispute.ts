export type Provider = 'paystack';

export type DisputeEventKind = 'created' | 'reminder' | 'resolved';

export type Outcome = 'open' | 'won' | 'lost' | 'resolved-unknown';

export interface DisputeSnapshot {
  provider: Provider;
  providerDisputeId: string;
  status: string;
  resolution: string | null;
  category: string;
  amountMinor: number;
  currency: string;
  transactionReference: string;
  customerEmail: string | null;
  customerName: string | null;
  customerMessage: string | null;
  dueAt: string | null;
  resolvedAt: string | null;
  updatedAt: string;
  mode: 'test' | 'live';
}

export interface DisputeEvent {
  kind: DisputeEventKind;
  providerEvent: string;
  /** Same value for every delivery of the same event, including Paystack resends. */
  dedupeKey: string;
  snapshot: DisputeSnapshot;
}

export type TimelineKind = DisputeEventKind | 'stale-ignored' | 'deadline-alert' | 'ticket-created';

export interface TimelineEntry {
  at: string;
  kind: TimelineKind;
  status: string;
  note?: string;
}

export interface DisputeRecord {
  key: string;
  issueKey: string | null;
  issueId: string | null;
  snapshot: DisputeSnapshot;
  timeline: TimelineEntry[];
  /** Hours-left thresholds already alerted on, so each fires once. */
  alertsSent: number[];
  createdAt: string;
  updatedAt: string;
}

export type Decision =
  | { action: 'create' }
  | { action: 'update'; statusChanged: boolean; outcomeChanged: boolean; dueAtChanged: boolean }
  | { action: 'ignore'; reason: 'stale' };

export const TIMELINE_LIMIT = 50;

export function disputeKey(provider: Provider, providerDisputeId: string): string {
  return `${provider}:${providerDisputeId}`;
}

export function outcomeOf(snapshot: Pick<DisputeSnapshot, 'status' | 'resolution'>): Outcome {
  if (snapshot.status !== 'resolved') return 'open';
  switch (snapshot.resolution) {
    case 'declined':
      return 'won';
    case 'merchant-accepted':
    case 'auto-accepted':
      return 'lost';
    default:
      return 'resolved-unknown';
  }
}

function statusRank(status: string): number {
  return status === 'resolved' ? 1 : 0;
}

/** Positive when `a` is newer than `b`. Ties on timestamp go to the resolved state. */
export function compareSnapshots(a: DisputeSnapshot, b: DisputeSnapshot): number {
  const byTime = Date.parse(a.updatedAt) - Date.parse(b.updatedAt);
  if (byTime !== 0) return byTime;
  return statusRank(a.status) - statusRank(b.status);
}

export function decide(existing: DisputeRecord | undefined, event: DisputeEvent): Decision {
  if (!existing) return { action: 'create' };
  if (compareSnapshots(existing.snapshot, event.snapshot) > 0) {
    return { action: 'ignore', reason: 'stale' };
  }
  const before = existing.snapshot;
  const after = event.snapshot;
  return {
    action: 'update',
    statusChanged: before.status !== after.status,
    outcomeChanged: outcomeOf(before) !== outcomeOf(after),
    dueAtChanged: before.dueAt !== after.dueAt,
  };
}

export function appendTimeline(timeline: TimelineEntry[], entry: TimelineEntry): TimelineEntry[] {
  return [...timeline, entry].slice(-TIMELINE_LIMIT);
}

export function formatAmount(amountMinor: number, currency: string): string {
  const major = amountMinor / 100;
  try {
    return new Intl.NumberFormat('en-NG', { style: 'currency', currency }).format(major);
  } catch {
    return `${currency} ${major.toFixed(2)}`;
  }
}
