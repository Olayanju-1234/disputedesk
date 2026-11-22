import { bulletList, code, doc, heading, panel, paragraph, strong, text, type AdfDoc } from './adf';
import { describeTimeLeft, type DeadlineAlert } from './deadline';
import { formatAmount, outcomeOf, type DisputeSnapshot } from './dispute';

export const APP_LABEL = 'disputedesk';

export function disputeLabel(
  snapshot: Pick<DisputeSnapshot, 'provider' | 'providerDisputeId'>,
): string {
  return `dd-${snapshot.provider}-${snapshot.providerDisputeId}`;
}

export function outcomeLabel(snapshot: DisputeSnapshot): string | null {
  const outcome = outcomeOf(snapshot);
  return outcome === 'won' || outcome === 'lost' ? `dd-${outcome}` : null;
}

function categoryTitle(category: string): string {
  if (category === 'fraud') return 'Fraud claim';
  if (category === 'chargeback') return 'Chargeback';
  return 'Dispute';
}

export function formatUtc(iso: string): string {
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const time = d.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${date} ${time} UTC`;
}

export function jiraDueDate(dueAt: string | null): string | null {
  return dueAt ? new Date(dueAt).toISOString().slice(0, 10) : null;
}

export function issueSummary(s: DisputeSnapshot): string {
  const who = s.customerName ?? s.customerEmail;
  const base = `${categoryTitle(s.category)} ${formatAmount(s.amountMinor, s.currency)} on ${s.transactionReference}`;
  return (who ? `${base} (${who})` : base).slice(0, 255);
}

function detailItems(s: DisputeSnapshot) {
  return [
    [strong('Amount: '), text(formatAmount(s.amountMinor, s.currency))],
    [strong('Transaction: '), code(s.transactionReference)],
    [
      strong('Paystack dispute: '),
      code(s.providerDisputeId),
      text(s.mode === 'test' ? ' (test mode)' : ''),
    ],
    [strong('Category: '), text(categoryTitle(s.category))],
    [
      strong('Customer: '),
      text([s.customerName, s.customerEmail].filter(Boolean).join(', ') || 'unknown'),
    ],
    [strong('Provider status: '), code(s.status)],
  ];
}

export function issueDescription(s: DisputeSnapshot): AdfDoc {
  const deadline = s.dueAt
    ? panel(
        'warning',
        paragraph(
          strong(`Respond by ${formatUtc(s.dueAt)}. `),
          text(
            'Paystack accepts unanswered disputes on your behalf after the deadline and refunds the customer from your balance.',
          ),
        ),
      )
    : panel('info', paragraph(text('Paystack did not send a response deadline for this dispute.')));
  const nodes = [deadline, heading(3, 'Dispute details'), bulletList(detailItems(s))];
  if (s.customerMessage) {
    nodes.push(heading(3, 'What the customer said'), paragraph(text(s.customerMessage)));
  }
  nodes.push(paragraph(text('Created by DisputeDesk from a verified Paystack webhook.')));
  return doc(...nodes);
}

export function statusChangeComment(before: DisputeSnapshot, after: DisputeSnapshot): AdfDoc {
  return doc(
    paragraph(
      text('Paystack status changed from '),
      code(before.status),
      text(' to '),
      code(after.status),
      text('.'),
    ),
  );
}

export function dueDateChangeComment(after: DisputeSnapshot): AdfDoc {
  return doc(
    paragraph(
      text(
        after.dueAt
          ? `Paystack moved the response deadline to ${formatUtc(after.dueAt)}.`
          : 'Paystack removed the response deadline.',
      ),
    ),
  );
}

export function outcomeComment(s: DisputeSnapshot): AdfDoc {
  const outcome = outcomeOf(s);
  const amount = formatAmount(s.amountMinor, s.currency);
  const message =
    outcome === 'won'
      ? `Dispute won. Paystack resolved it as declined, so the ${amount} stays with you.`
      : outcome === 'lost'
        ? `Dispute lost (${s.resolution}). ${amount} is refunded to the customer from your Paystack balance.`
        : `Dispute resolved with resolution "${s.resolution ?? 'none'}".`;
  return doc(
    panel(
      outcome === 'won' ? 'success' : outcome === 'lost' ? 'error' : 'info',
      paragraph(strong(message)),
    ),
  );
}

export function deadlineAlertComment(alert: DeadlineAlert, dueAt: string): AdfDoc {
  const left = describeTimeLeft(alert.hoursLeft);
  const lead =
    alert.thresholdHours === 0
      ? `Deadline passed (${left}). Paystack may already have accepted this dispute for you.`
      : `${left} to respond (deadline ${formatUtc(dueAt)}). Priority raised to ${alert.priority}.`;
  return doc(panel(alert.thresholdHours <= 1 ? 'error' : 'warning', paragraph(strong(lead))));
}
