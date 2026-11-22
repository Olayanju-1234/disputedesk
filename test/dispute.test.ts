import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  appendTimeline,
  decide,
  outcomeOf,
  TIMELINE_LIMIT,
  type DisputeEvent,
  type DisputeRecord,
} from '../src/domain/dispute';
import { parsePaystackEvent } from '../src/domain/paystack';
import { rawFixture, type PaystackFixture } from './helpers';

function parsed(name: PaystackFixture): DisputeEvent {
  const result = parsePaystackEvent(rawFixture(name).toString('utf8'));
  assert.ok(result.ok, `fixture ${name} should parse`);
  return result.event;
}

function withData(name: PaystackFixture, patch: Record<string, unknown>): DisputeEvent {
  const body = JSON.parse(rawFixture(name).toString('utf8')) as { data: Record<string, unknown> };
  body.data = { ...body.data, ...patch };
  const result = parsePaystackEvent(JSON.stringify(body));
  assert.ok(result.ok);
  return result.event;
}

function recordFrom(event: DisputeEvent): DisputeRecord {
  return {
    key: `paystack:${event.snapshot.providerDisputeId}`,
    issueKey: 'DIS-1',
    issueId: '10001',
    snapshot: event.snapshot,
    timeline: [],
    alertsSent: [],
    createdAt: event.snapshot.updatedAt,
    updatedAt: event.snapshot.updatedAt,
  };
}

describe('parsePaystackEvent', () => {
  it('normalizes the recorded charge.dispute.create payload', () => {
    const event = parsed('charge.dispute.create');
    assert.equal(event.kind, 'created');
    assert.equal(event.dedupeKey, 'paystack:358950:charge.dispute.create:2020-11-24T18:00:02.000Z');
    assert.deepEqual(event.snapshot, {
      provider: 'paystack',
      providerDisputeId: '358950',
      status: 'awaiting-merchant-feedback',
      resolution: null,
      category: 'chargeback',
      amountMinor: 5800,
      currency: 'NGN',
      transactionReference: 'v3mjfgbnc19v97x',
      customerEmail: 'example@test.com',
      customerName: 'John Doe',
      customerMessage: 'Customer complained about debit without value',
      dueAt: '2020-11-25T18:00:00.000Z',
      resolvedAt: null,
      updatedAt: '2020-11-24T18:00:02.000Z',
      mode: 'live',
    });
  });

  it('maps remind and resolve events', () => {
    assert.equal(parsed('charge.dispute.remind').kind, 'reminder');
    const resolved = parsed('charge.dispute.resolve');
    assert.equal(resolved.kind, 'resolved');
    assert.equal(resolved.snapshot.resolution, 'auto-accepted');
    assert.equal(resolved.snapshot.resolvedAt, '2020-11-24T14:00:02.000Z');
  });

  it('gives a resend of the same event the same dedupe key', () => {
    assert.equal(
      parsed('charge.dispute.create').dedupeKey,
      parsed('charge.dispute.create').dedupeKey,
    );
    assert.notEqual(
      parsed('charge.dispute.create').dedupeKey,
      parsed('charge.dispute.remind').dedupeKey,
    );
  });

  it('falls back to the transaction amount when refund_amount is null', () => {
    assert.equal(
      withData('charge.dispute.create', { refund_amount: null }).snapshot.amountMinor,
      5800,
    );
  });

  it('rejects non-dispute events, bad JSON and payloads missing required fields', () => {
    assert.deepEqual(parsePaystackEvent('{"event":"charge.success","data":{}}'), {
      ok: false,
      reason: 'not-a-dispute-event',
      providerEvent: 'charge.success',
    });
    assert.deepEqual(parsePaystackEvent('{not json'), { ok: false, reason: 'invalid-json' });
    const noId = parsePaystackEvent(
      '{"event":"charge.dispute.create","data":{"status":"pending"}}',
    );
    assert.equal(noId.ok, false);
    assert.equal(!noId.ok && noId.reason, 'invalid-payload');
  });
});

describe('outcomeOf', () => {
  it('maps Paystack resolutions to won and lost', () => {
    assert.equal(outcomeOf({ status: 'awaiting-merchant-feedback', resolution: null }), 'open');
    assert.equal(outcomeOf({ status: 'resolved', resolution: 'declined' }), 'won');
    assert.equal(outcomeOf({ status: 'resolved', resolution: 'merchant-accepted' }), 'lost');
    assert.equal(outcomeOf({ status: 'resolved', resolution: 'auto-accepted' }), 'lost');
    assert.equal(
      outcomeOf({ status: 'resolved', resolution: 'something-new' }),
      'resolved-unknown',
    );
  });
});

describe('decide (stale-update guard)', () => {
  it('creates when there is no record yet', () => {
    assert.deepEqual(decide(undefined, parsed('charge.dispute.create')), { action: 'create' });
  });

  it('applies a newer resolve on top of an open dispute', () => {
    const open = recordFrom(
      withData('charge.dispute.create', { updated_at: '2020-11-24T13:00:00.000Z' }),
    );
    const resolve = withData('charge.dispute.resolve', {
      id: 358950,
      updated_at: '2020-11-24T20:00:00.000Z',
    });
    assert.deepEqual(decide(open, resolve), {
      action: 'update',
      statusChanged: true,
      outcomeChanged: true,
      dueAtChanged: true,
    });
  });

  it('ignores an older create that arrives after the resolve', () => {
    const resolved = recordFrom(
      withData('charge.dispute.resolve', { id: 358950, updated_at: '2020-11-24T20:00:00.000Z' }),
    );
    assert.deepEqual(decide(resolved, parsed('charge.dispute.create')), {
      action: 'ignore',
      reason: 'stale',
    });
  });

  it('on a timestamp tie, keeps resolved over open', () => {
    const at = '2020-11-24T18:00:02.000Z';
    const resolved = recordFrom(withData('charge.dispute.resolve', { id: 358950, updated_at: at }));
    assert.equal(decide(resolved, parsed('charge.dispute.remind')).action, 'ignore');
    const open = recordFrom(parsed('charge.dispute.create'));
    const tieResolve = withData('charge.dispute.resolve', { id: 358950, updated_at: at });
    assert.equal(decide(open, tieResolve).action, 'update');
  });

  it('treats an unchanged reminder as an update with nothing changed', () => {
    const open = recordFrom(parsed('charge.dispute.create'));
    assert.deepEqual(decide(open, parsed('charge.dispute.remind')), {
      action: 'update',
      statusChanged: false,
      outcomeChanged: false,
      dueAtChanged: false,
    });
  });
});

describe('appendTimeline', () => {
  it('keeps only the most recent entries', () => {
    let timeline: DisputeRecord['timeline'] = [];
    for (let i = 0; i < TIMELINE_LIMIT + 5; i++) {
      timeline = appendTimeline(timeline, { at: String(i), kind: 'reminder', status: 'pending' });
    }
    assert.equal(timeline.length, TIMELINE_LIMIT);
    assert.equal(timeline[0]?.at, '5');
  });
});
