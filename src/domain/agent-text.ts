import type { DashboardRow } from './dashboard';
import { describeTimeLeft, hoursLeft } from './deadline';
import type { DisputeRecord } from './dispute';
import { formatAmount, outcomeOf } from './dispute';
import { classifyReason, evidenceChecklist, REASON_LABELS, type EvidenceState } from './evidence';
import { formatUtc } from './issue-content';
import { timelineLabel } from './panel';
import { describeResponse, isSimulated, type ResponseRecord } from './response';

/** Plain-text answers for Rovo and MCP tools: short, factual, no invented fields. */

export function openDisputesText(rows: DashboardRow[], now: Date): string {
  if (rows.length === 0) return 'There are no open disputes.';
  const lines = rows.map((r) => {
    const left = r.dueAt
      ? `${describeTimeLeft(hoursLeft(r.dueAt, now))} (due ${formatUtc(r.dueAt)})`
      : 'no deadline';
    const response = r.responseStatus ? `response ${r.responseStatus}` : 'no response yet';
    return `- ${r.issueKey ?? r.key}: ${r.amount}, ${r.reasonLabel.toLowerCase()}, ${left}, evidence ${r.evidenceDone} of ${r.evidenceTotal}, ${response}${r.simulated ? ', simulator test data' : ''}`;
  });
  return `${rows.length} open dispute${rows.length === 1 ? '' : 's'}, most urgent first:\n${lines.join('\n')}`;
}

export function disputeText(
  record: DisputeRecord,
  evidence: EvidenceState,
  response: ResponseRecord | undefined,
  now: Date,
): string {
  const s = record.snapshot;
  const outcome = outcomeOf(s);
  const reason = classifyReason(s);
  const items = evidenceChecklist(reason);
  const lines: string[] = [
    `${record.issueKey ?? record.key}: Paystack dispute ${s.providerDisputeId}${isSimulated(s) ? ' (simulator test data)' : s.mode === 'test' ? ' (test mode)' : ''}`,
    `Amount: ${formatAmount(s.amountMinor, s.currency)} on transaction ${s.transactionReference}`,
    `Category: ${s.category}. Reason: ${REASON_LABELS[reason]}.`,
    `Customer: ${[s.customerName, s.customerEmail].filter(Boolean).join(', ') || 'unknown'}`,
  ];
  if (s.customerMessage) lines.push(`Customer said: "${s.customerMessage}"`);
  if (outcome === 'open') {
    lines.push(
      s.dueAt
        ? `Deadline: ${formatUtc(s.dueAt)}, ${describeTimeLeft(hoursLeft(s.dueAt, now))}. Paystack accepts the dispute and refunds the customer if nobody responds by then.`
        : 'Deadline: Paystack sent no deadline.',
    );
  } else {
    lines.push(`Outcome: ${outcome} (Paystack resolution: ${s.resolution ?? 'none'}).`);
  }
  lines.push(`Paystack status: ${s.status}`);
  lines.push(
    'Evidence checklist:',
    ...items.map((i) => `- [${evidence[i.id]?.done ? 'x' : ' '}] ${i.label}: ${i.hint}`),
  );
  lines.push(`Response: ${response ? describeResponse(response) : 'not sent yet.'}`);
  const recent = [...record.timeline].reverse().slice(0, 5);
  if (recent.length) {
    lines.push('Recent events:', ...recent.map((e) => `- ${formatUtc(e.at)}: ${timelineLabel(e)}`));
  }
  return lines.join('\n');
}

export interface PolicyHit {
  title: string;
  url: string;
  excerpt: string;
}

export function policyText(query: string, hits: PolicyHit[]): string {
  if (hits.length === 0) {
    return `No Confluence pages matched "${query}". Do not assume a policy; ask the user where it is written down.`;
  }
  return [
    `Confluence pages matching "${query}":`,
    ...hits.map((h) => `- ${h.title} (${h.url})${h.excerpt ? `: ${h.excerpt}` : ''}`),
  ].join('\n');
}

/** Confluence search excerpts carry highlight markers; strip them and collapse whitespace. */
export function cleanExcerpt(raw: string): string {
  return raw
    .replace(/@@@(end)?hl@@@/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}
