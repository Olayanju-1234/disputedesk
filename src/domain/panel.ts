import {
  formatAmount,
  outcomeOf,
  type DisputeRecord,
  type Outcome,
  type TimelineEntry,
} from './dispute';
import {
  classifyReason,
  evidenceChecklist,
  evidenceProgress,
  REASON_LABELS,
  type EvidenceItem,
  type EvidenceState,
} from './evidence';
import { canRespond, describeResponse, isSimulated, type ResponseRecord } from './response';

export interface PanelTimelineRow {
  at: string;
  label: string;
}

export interface DisputePanel {
  disputeKey: string;
  providerDisputeId: string;
  mode: 'test' | 'live';
  amount: string;
  transactionReference: string;
  customer: string | null;
  status: string;
  outcome: Outcome;
  reasonLabel: string;
  dueAt: string | null;
  evidence: { items: EvidenceItem[]; state: EvidenceState; done: number; total: number };
  timeline: PanelTimelineRow[];
  category: string;
  customerName: string | null;
  customerEmail: string | null;
  simulated: boolean;
  response: ResponseRecord | null;
  responseSummary: string | null;
  canRespond: boolean;
}

const PANEL_TIMELINE_LIMIT = 8;

export function timelineLabel(entry: TimelineEntry): string {
  switch (entry.kind) {
    case 'created':
      return 'Paystack opened the dispute';
    case 'reminder':
      return 'Paystack sent a reminder';
    case 'resolved':
      return `Paystack resolved it (${entry.status})`;
    case 'ticket-created':
      return `Ticket ${entry.note ?? ''} created`.replace('  ', ' ');
    case 'deadline-alert':
      return `Deadline warning sent (${entry.note ?? 'threshold'})`;
    case 'stale-ignored':
      return 'Ignored an older update that arrived late';
    case 'response':
      return `${entry.note === 'accept' ? 'Accepted the dispute' : 'Contested with evidence'} (${entry.status})`;
    default:
      return entry.kind;
  }
}

export function buildPanel(
  record: DisputeRecord,
  evidenceState: EvidenceState,
  response?: ResponseRecord,
): DisputePanel {
  const s = record.snapshot;
  const reason = classifyReason(s);
  const items = evidenceChecklist(reason);
  const progress = evidenceProgress(items, evidenceState);
  return {
    disputeKey: record.key,
    providerDisputeId: s.providerDisputeId,
    mode: s.mode,
    amount: formatAmount(s.amountMinor, s.currency),
    transactionReference: s.transactionReference,
    customer: s.customerName ?? s.customerEmail,
    status: s.status,
    outcome: outcomeOf(s),
    reasonLabel: REASON_LABELS[reason],
    dueAt: s.dueAt,
    evidence: { items, state: evidenceState, ...progress },
    category: s.category,
    customerName: s.customerName,
    customerEmail: s.customerEmail,
    simulated: isSimulated(s),
    response: response ?? null,
    responseSummary: response ? describeResponse(response) : null,
    canRespond: canRespond(s, response),
    timeline: [...record.timeline]
      .reverse()
      .slice(0, PANEL_TIMELINE_LIMIT)
      .map((entry) => ({ at: entry.at, label: timelineLabel(entry) })),
  };
}
