import type { DisputeEvent, DisputeEventKind, DisputeSnapshot } from './dispute';

export const PAYSTACK_DISPUTE_EVENTS: Record<string, DisputeEventKind> = {
  'charge.dispute.create': 'created',
  'charge.dispute.remind': 'reminder',
  'charge.dispute.resolve': 'resolved',
};

export type ParseFailure = 'invalid-json' | 'not-a-dispute-event' | 'invalid-payload';

export type ParseResult =
  | { ok: true; event: DisputeEvent }
  | { ok: false; reason: ParseFailure; providerEvent?: string; detail?: string };

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoOrNull(value: unknown): string | null {
  const s = str(value);
  return s !== null && !Number.isNaN(Date.parse(s)) ? s : null;
}

function customerName(customer: Json | undefined): string | null {
  if (!customer) return null;
  const name = [str(customer.first_name), str(customer.last_name)].filter(Boolean).join(' ');
  return name.length > 0 ? name : null;
}

function firstMessage(messages: unknown): string | null {
  if (!Array.isArray(messages)) return null;
  const first: unknown = messages[0];
  return isObject(first) ? str(first.body) : null;
}

export function parsePaystackEvent(rawBody: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (!isObject(parsed)) return { ok: false, reason: 'invalid-payload', detail: 'body' };

  const providerEvent = str(parsed.event) ?? undefined;
  const kind = providerEvent ? PAYSTACK_DISPUTE_EVENTS[providerEvent] : undefined;
  if (!providerEvent || !kind) return { ok: false, reason: 'not-a-dispute-event', providerEvent };

  const data = parsed.data;
  if (!isObject(data))
    return { ok: false, reason: 'invalid-payload', providerEvent, detail: 'data' };
  const transaction = isObject(data.transaction) ? data.transaction : undefined;
  const customer = isObject(data.customer) ? data.customer : undefined;

  const id = num(data.id) ?? str(data.id);
  const status = str(data.status);
  const updatedAt =
    isoOrNull(data.updated_at) ?? isoOrNull(data.updatedAt) ?? isoOrNull(data.created_at);
  const amountMinor = num(data.refund_amount) ?? num(transaction?.amount);
  const currency = str(data.currency) ?? str(transaction?.currency);
  const reference = str(transaction?.reference) ?? str(data.transaction_reference);

  const missing = Object.entries({ id, status, updatedAt, amountMinor, currency, reference })
    .filter(([, value]) => value === null)
    .map(([field]) => field);
  if (missing.length > 0) {
    return { ok: false, reason: 'invalid-payload', providerEvent, detail: missing.join(',') };
  }

  const snapshot: DisputeSnapshot = {
    provider: 'paystack',
    providerDisputeId: String(id),
    status: status!,
    resolution: str(data.resolution),
    category: str(data.category) ?? 'unknown',
    amountMinor: amountMinor!,
    currency: currency!,
    transactionReference: reference!,
    customerEmail: str(customer?.email),
    customerName: customerName(customer),
    customerMessage: firstMessage(data.messages),
    dueAt: isoOrNull(data.dueAt) ?? isoOrNull(data.due_at),
    resolvedAt: isoOrNull(data.resolvedAt) ?? isoOrNull(data.resolved_at),
    updatedAt: updatedAt!,
    mode: data.domain === 'live' ? 'live' : 'test',
  };

  return {
    ok: true,
    event: {
      kind,
      providerEvent,
      dedupeKey: `paystack:${snapshot.providerDisputeId}:${providerEvent}:${snapshot.updatedAt}`,
      snapshot,
    },
  };
}
