import type { DisputeSnapshot } from './dispute';

export type DisputeReason = 'not-received' | 'not-recognised' | 'duplicate' | 'fraud' | 'other';

export interface EvidenceItem {
  id: string;
  label: string;
  hint: string;
}

export interface EvidenceTick {
  done: boolean;
  by: string | null;
  at: string;
}

export type EvidenceState = Record<string, EvidenceTick>;

export const REASON_LABELS: Record<DisputeReason, string> = {
  'not-received': 'Goods or service not received',
  'not-recognised': 'Charge not recognised',
  duplicate: 'Charged more than once',
  fraud: 'Fraud claim',
  other: 'Other chargeback',
};

const RECEIPT: EvidenceItem = {
  id: 'receipt',
  label: 'Transaction receipt',
  hint: 'Paystack accepts .pdf, .jpg or .jpeg. Name it after the transaction reference.',
};

const CUSTOMER_COMMS: EvidenceItem = {
  id: 'customer-comms',
  label: 'Messages with the customer',
  hint: 'Emails or chats about this order, especially any that confirm delivery or use.',
};

const ORDER_DETAILS: EvidenceItem = {
  id: 'order-details',
  label: 'Order details',
  hint: 'What was bought, when, for how much, and the name on the order.',
};

const CHECKLISTS: Record<DisputeReason, EvidenceItem[]> = {
  'not-received': [
    RECEIPT,
    {
      id: 'proof-of-delivery',
      label: 'Proof of delivery',
      hint: 'Delivery confirmation, tracking or a signed note, with the delivery date and address.',
    },
    {
      id: 'service-record',
      label: 'Record that the service was provided',
      hint: 'For services: usage logs, access records or a completion note.',
    },
    CUSTOMER_COMMS,
  ],
  'not-recognised': [
    RECEIPT,
    ORDER_DETAILS,
    {
      id: 'customer-identity',
      label: 'Customer contact details on the order',
      hint: 'The email and phone number used, to show they match the cardholder.',
    },
    CUSTOMER_COMMS,
  ],
  duplicate: [
    RECEIPT,
    {
      id: 'distinct-orders',
      label: 'Proof the charges are separate orders',
      hint: 'Two receipts or order records with different items, dates or references.',
    },
    {
      id: 'refund-record',
      label: 'Refund record, if one charge was refunded',
      hint: 'The refund reference and date from Paystack.',
    },
  ],
  fraud: [
    RECEIPT,
    {
      id: 'customer-details',
      label: 'Customer name, email and phone',
      hint: 'Paystack asks for these when you add evidence to a fraud claim.',
    },
    {
      id: 'delivery-details',
      label: 'Delivery address and date',
      hint: 'Where and when the goods or service reached the customer.',
    },
    {
      id: 'service-details',
      label: 'What was provided',
      hint: 'A short description of the product or service the customer received.',
    },
    {
      id: 'past-orders',
      label: 'Earlier successful orders by the same customer',
      hint: 'Undisputed past orders with the same card, email or address.',
    },
  ],
  other: [RECEIPT, ORDER_DETAILS, CUSTOMER_COMMS],
};

export function classifyReason(
  snapshot: Pick<DisputeSnapshot, 'category' | 'customerMessage'>,
): DisputeReason {
  if (snapshot.category === 'fraud') return 'fraud';
  const message = snapshot.customerMessage ?? '';
  if (/twice|duplicate|double|more than once/i.test(message)) return 'duplicate';
  if (/recogni[sz]e|unknown charge|unauthori[sz]ed|didn'?t make/i.test(message))
    return 'not-recognised';
  if (
    /never (arrived|came)|not (received|delivered|arrived)|without value|no value|not as described/i.test(
      message,
    )
  ) {
    return 'not-received';
  }
  return 'other';
}

export function evidenceChecklist(reason: DisputeReason): EvidenceItem[] {
  return CHECKLISTS[reason];
}

export function evidenceProgress(
  items: EvidenceItem[],
  state: EvidenceState,
): { done: number; total: number } {
  return { done: items.filter((item) => state[item.id]?.done).length, total: items.length };
}

export function toggleEvidence(
  items: EvidenceItem[],
  state: EvidenceState,
  itemId: string,
  done: boolean,
  by: string | null,
  at: string,
): EvidenceState {
  if (!items.some((item) => item.id === itemId)) throw new Error(`Unknown evidence item ${itemId}`);
  return { ...state, [itemId]: { done, by, at } };
}
