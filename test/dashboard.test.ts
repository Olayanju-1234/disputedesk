import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildDashboard } from '../src/domain/dashboard';
import type { DisputeRecord, DisputeSnapshot } from '../src/domain/dispute';
import { parsePaystackEvent } from '../src/domain/paystack';
import { rawFixture } from './helpers';

const NOW = new Date('2026-11-24T12:00:00.000Z');

function record(
  id: number,
  patch: Record<string, unknown>,
  updatedAt = NOW.toISOString(),
): DisputeRecord {
  const body = JSON.parse(rawFixture('charge.dispute.create').toString('utf8')) as {
    data: Record<string, unknown>;
  };
  body.data = { ...body.data, id, ...patch };
  const parsed = parsePaystackEvent(JSON.stringify(body));
  assert.ok(parsed.ok);
  const snapshot: DisputeSnapshot = parsed.event.snapshot;
  return {
    key: `paystack:${id}`,
    issueKey: `DIS-${id}`,
    issueId: String(id),
    snapshot,
    timeline: [],
    alertsSent: [],
    createdAt: updatedAt,
    updatedAt,
  };
}

const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

describe('buildDashboard', () => {
  const records = [
    record(1, { dueAt: hoursFromNow(10), refund_amount: 100000 }),
    record(2, { dueAt: hoursFromNow(2), refund_amount: 250000 }),
    record(3, { dueAt: hoursFromNow(-1), refund_amount: 50000 }),
    record(
      4,
      { status: 'resolved', resolution: 'declined', refund_amount: 300000 },
      '2026-11-23T10:00:00.000Z',
    ),
    record(
      5,
      { status: 'resolved', resolution: 'auto-accepted', refund_amount: 70000 },
      '2026-11-24T09:00:00.000Z',
    ),
    record(
      6,
      { status: 'resolved', resolution: 'merchant-accepted', refund_amount: 20000 },
      '2026-11-22T09:00:00.000Z',
    ),
  ];
  const dashboard = buildDashboard(
    records,
    { 'paystack:2': { receipt: { done: true, by: null, at: NOW.toISOString() } } },
    {
      'paystack:2': {
        action: 'contest',
        status: 'unconfirmed',
        message: 'm',
        at: NOW.toISOString(),
        by: null,
        attempts: 1,
        refundAmountMinor: 0,
      },
    },
    NOW,
  );

  it('counts open, due soon, overdue and the win rate', () => {
    assert.deepEqual(dashboard.totals, {
      open: 3,
      dueSoon: 1,
      overdue: 1,
      won: 1,
      lost: 2,
      winRate: 1 / 3,
    });
  });

  it('sums money at risk, recovered and lost per currency', () => {
    assert.equal(dashboard.atRisk[0]?.amountMinor, 400000);
    assert.equal(dashboard.atRisk[0]?.currency, 'NGN');
    assert.equal(dashboard.recovered[0]?.amountMinor, 300000);
    assert.equal(dashboard.lostAmount[0]?.amountMinor, 90000);
  });

  it('lists open disputes with the most urgent first', () => {
    assert.deepEqual(
      dashboard.open.map((r) => r.issueKey),
      ['DIS-3', 'DIS-2', 'DIS-1'],
    );
    const dis2 = dashboard.open[1];
    assert.equal(dis2?.evidenceDone, 1);
    assert.equal(dis2?.responseStatus, 'unconfirmed');
  });

  it('lists resolved disputes newest first', () => {
    assert.deepEqual(
      dashboard.recent.map((r) => [r.issueKey, r.outcome]),
      [
        ['DIS-5', 'lost'],
        ['DIS-4', 'won'],
        ['DIS-6', 'lost'],
      ],
    );
  });

  it('shows a win rate of null before anything is decided', () => {
    const fresh = buildDashboard([record(7, { dueAt: hoursFromNow(5) })], {}, {}, NOW);
    assert.equal(fresh.totals.winRate, null);
    assert.deepEqual(fresh.byOutcome, [{ label: 'Open', count: 1 }]);
  });
});
