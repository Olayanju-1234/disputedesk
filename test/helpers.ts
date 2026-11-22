import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, 'fixtures', 'paystack');

export type PaystackFixture =
  'charge.dispute.create' | 'charge.dispute.remind' | 'charge.dispute.resolve';

/** Raw bytes exactly as recorded from Paystack's documented samples. */
export function rawFixture(name: PaystackFixture): Buffer {
  return readFileSync(join(FIXTURES, `${name}.json`));
}

export function jsonFixture(name: PaystackFixture): unknown {
  return JSON.parse(rawFixture(name).toString('utf8'));
}
