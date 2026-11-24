import { hoursLeft } from './deadline';
import { formatAmount, outcomeOf, type DisputeRecord, type Outcome } from './dispute';
import {
  classifyReason,
  evidenceChecklist,
  evidenceProgress,
  REASON_LABELS,
  type EvidenceState,
} from './evidence';
import { isSimulated, type ResponseRecord, type ResponseStatus } from './response';

export const DUE_SOON_HOURS = 4;
const RECENT_LIMIT = 10;

export interface DashboardRow {
  key: string;
  issueKey: string | null;
  amount: string;
  reasonLabel: string;
  outcome: Outcome;
  dueAt: string | null;
  hoursLeft: number | null;
  evidenceDone: number;
  evidenceTotal: number;
  responseStatus: ResponseStatus | null;
  simulated: boolean;
  updatedAt: string;
}

export interface MoneyTotal {
  currency: string;
  amountMinor: number;
  formatted: string;
}

export interface Dashboard {
  generatedAt: string;
  totals: {
    open: number;
    dueSoon: number;
    overdue: number;
    won: number;
    lost: number;
    winRate: number | null;
  };
  atRisk: MoneyTotal[];
  recovered: MoneyTotal[];
  lostAmount: MoneyTotal[];
  open: DashboardRow[];
  recent: DashboardRow[];
  byOutcome: Array<{ label: string; count: number }>;
}

function sumByCurrency(records: DisputeRecord[]): MoneyTotal[] {
  const totals = new Map<string, number>();
  for (const r of records) {
    totals.set(
      r.snapshot.currency,
      (totals.get(r.snapshot.currency) ?? 0) + r.snapshot.amountMinor,
    );
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, amountMinor]) => ({
      currency,
      amountMinor,
      formatted: formatAmount(amountMinor, currency),
    }));
}

function toRow(
  record: DisputeRecord,
  evidence: EvidenceState | undefined,
  response: ResponseRecord | undefined,
  now: Date,
): DashboardRow {
  const s = record.snapshot;
  const reason = classifyReason(s);
  const progress = evidenceProgress(evidenceChecklist(reason), evidence ?? {});
  return {
    key: record.key,
    issueKey: record.issueKey,
    amount: formatAmount(s.amountMinor, s.currency),
    reasonLabel: REASON_LABELS[reason],
    outcome: outcomeOf(s),
    dueAt: s.dueAt,
    hoursLeft: s.dueAt ? hoursLeft(s.dueAt, now) : null,
    evidenceDone: progress.done,
    evidenceTotal: progress.total,
    responseStatus: response?.status ?? null,
    simulated: isSimulated(s),
    updatedAt: record.updatedAt,
  };
}

export function buildDashboard(
  records: DisputeRecord[],
  evidence: Record<string, EvidenceState | undefined>,
  responses: Record<string, ResponseRecord | undefined>,
  now: Date,
): Dashboard {
  const rows = records.map((r) => toRow(r, evidence[r.key], responses[r.key], now));
  const open = rows
    .filter((r) => r.outcome === 'open')
    .sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity));
  const resolved = rows.filter((r) => r.outcome !== 'open');
  const won = records.filter((r) => outcomeOf(r.snapshot) === 'won');
  const lost = records.filter((r) => outcomeOf(r.snapshot) === 'lost');
  const decided = won.length + lost.length;

  return {
    generatedAt: now.toISOString(),
    totals: {
      open: open.length,
      dueSoon: open.filter(
        (r) => r.hoursLeft !== null && r.hoursLeft > 0 && r.hoursLeft <= DUE_SOON_HOURS,
      ).length,
      overdue: open.filter((r) => r.hoursLeft !== null && r.hoursLeft <= 0).length,
      won: won.length,
      lost: lost.length,
      winRate: decided ? won.length / decided : null,
    },
    atRisk: sumByCurrency(records.filter((r) => outcomeOf(r.snapshot) === 'open')),
    recovered: sumByCurrency(won),
    lostAmount: sumByCurrency(lost),
    open,
    recent: resolved.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_LIMIT),
    byOutcome: [
      { label: 'Open', count: open.length },
      { label: 'Won', count: won.length },
      { label: 'Lost', count: lost.length },
    ].filter((o) => o.count > 0),
  };
}
