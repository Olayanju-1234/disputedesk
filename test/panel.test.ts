import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { DisputeEvent } from '../src/domain/dispute';
import { buildPanel } from '../src/domain/panel';
import { parsePaystackEvent } from '../src/domain/paystack';
import { processDisputeEvent } from '../src/domain/process';
import { configured, FakeJira, MemoryStore } from './fakes';
import { rawFixture, type PaystackFixture } from './helpers';

function event(name: PaystackFixture, patch: Record<string, unknown> = {}): DisputeEvent {
  const body = JSON.parse(rawFixture(name).toString('utf8')) as { data: Record<string, unknown> };
  body.data = { ...body.data, id: 358950, ...patch };
  const result = parsePaystackEvent(JSON.stringify(body));
  assert.ok(result.ok);
  return result.event;
}

let store: MemoryStore;
let jira: FakeJira;
const deps = () => ({
  store,
  jira,
  config: configured,
  now: () => new Date('2020-11-24T19:00:00.000Z'),
});

beforeEach(() => {
  store = new MemoryStore();
  jira = new FakeJira();
});

describe('dispute issue property', () => {
  it('is written when the ticket is created and follows the outcome', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    assert.deepEqual(jira.properties.get('DIS-1'), {
      disputeKey: 'paystack:358950',
      provider: 'paystack',
      providerDisputeId: '358950',
      status: 'awaiting-merchant-feedback',
      outcome: 'open',
      category: 'chargeback',
      amountMinor: 5800,
      currency: 'NGN',
      dueAt: '2020-11-25T18:00:00.000Z',
    });
    await processDisputeEvent(
      event('charge.dispute.resolve', { updated_at: '2020-11-25T18:00:05.000Z' }),
      deps(),
    );
    assert.equal(jira.properties.get('DIS-1')?.outcome, 'lost');
  });
});

describe('buildPanel', () => {
  it('shows the reason, the evidence list and the newest events first', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    await processDisputeEvent(event('charge.dispute.remind'), deps());
    const record = store.disputes.get('paystack:358950');
    assert.ok(record);
    const panel = buildPanel(record, {
      receipt: { done: true, by: 'acc', at: '2020-11-24T19:05:00.000Z' },
    });
    assert.equal(panel.reasonLabel, 'Goods or service not received');
    assert.match(panel.amount, /58\.00/);
    assert.equal(panel.customer, 'John Doe');
    assert.deepEqual(
      { done: panel.evidence.done, total: panel.evidence.total },
      { done: 1, total: 4 },
    );
    assert.deepEqual(
      panel.timeline.map((row) => row.label),
      ['Paystack sent a reminder', 'Ticket DIS-1 created', 'Paystack opened the dispute'],
    );
  });
});
