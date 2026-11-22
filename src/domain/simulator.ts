export type SimScenario = 'create' | 'remind' | 'resolve-won' | 'resolve-lost' | 'resolve-timeout';

export interface SimDispute {
  id: number;
  transactionId: number;
  reference: string;
  amountMinor: number;
  category: 'chargeback' | 'fraud';
  customer: { firstName: string; lastName: string; email: string };
  message: string;
  createdAt: string;
  dueAt: string;
}

const EVENT_FOR: Record<SimScenario, string> = {
  create: 'charge.dispute.create',
  remind: 'charge.dispute.remind',
  'resolve-won': 'charge.dispute.resolve',
  'resolve-lost': 'charge.dispute.resolve',
  'resolve-timeout': 'charge.dispute.resolve',
};

const RESOLUTION_FOR: Partial<Record<SimScenario, string>> = {
  'resolve-won': 'declined',
  'resolve-lost': 'merchant-accepted',
  'resolve-timeout': 'auto-accepted',
};

const SAMPLE_CUSTOMERS = [
  {
    firstName: 'Adaeze',
    lastName: 'Okafor',
    email: 'adaeze.okafor@example.com',
    message: 'I was debited twice for one order',
  },
  {
    firstName: 'Tunde',
    lastName: 'Bakare',
    email: 'tunde.bakare@example.com',
    message: 'Customer says the order never arrived',
  },
  {
    firstName: 'Ngozi',
    lastName: 'Eze',
    email: 'ngozi.eze@example.com',
    message: 'Cardholder does not recognise this charge',
  },
];

export function newSimDispute(now: Date, hoursUntilDue: number, seed: number): SimDispute {
  const pick = SAMPLE_CUSTOMERS[seed % SAMPLE_CUSTOMERS.length] ?? SAMPLE_CUSTOMERS[0]!;
  return {
    id: 900000 + (seed % 100000),
    transactionId: 5000000000 + seed,
    reference: `dd-test-${seed.toString(36)}`,
    amountMinor: 1500000 + (seed % 7) * 250000,
    category: seed % 3 === 2 ? 'fraud' : 'chargeback',
    customer: { firstName: pick.firstName, lastName: pick.lastName, email: pick.email },
    message: pick.message,
    createdAt: now.toISOString(),
    dueAt: new Date(now.getTime() + hoursUntilDue * 3_600_000).toISOString(),
  };
}

/** A Paystack-shaped dispute event, in test mode, for the signed simulator. */
export function buildPaystackDisputeEvent(
  dispute: SimDispute,
  scenario: SimScenario,
  now: Date,
): string {
  const resolved = scenario.startsWith('resolve');
  const nowIso = now.toISOString();
  return JSON.stringify({
    event: EVENT_FOR[scenario],
    data: {
      id: dispute.id,
      refund_amount: dispute.amountMinor,
      currency: 'NGN',
      status: resolved ? 'resolved' : 'awaiting-merchant-feedback',
      resolution: RESOLUTION_FOR[scenario] ?? null,
      domain: 'test',
      transaction: {
        id: dispute.transactionId,
        domain: 'test',
        status: scenario === 'resolve-won' || !resolved ? 'success' : 'reversed',
        reference: dispute.reference,
        amount: dispute.amountMinor,
        currency: 'NGN',
        channel: 'card',
        paid_at: dispute.createdAt,
        created_at: dispute.createdAt,
      },
      transaction_reference: null,
      category: dispute.category,
      customer: {
        first_name: dispute.customer.firstName,
        last_name: dispute.customer.lastName,
        email: dispute.customer.email,
      },
      dueAt: dispute.dueAt,
      resolvedAt: resolved ? nowIso : null,
      history: [{ status: 'pending', by: dispute.customer.email, createdAt: dispute.createdAt }],
      messages: [
        { sender: dispute.customer.email, body: dispute.message, createdAt: dispute.createdAt },
      ],
      created_at: dispute.createdAt,
      updated_at: nowIso,
    },
  });
}
