import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanExcerpt,
  cleanSearchText,
  disputeText,
  openDisputesText,
  policyText,
} from '../src/domain/agent-text';
import { buildDashboard } from '../src/domain/dashboard';
import type { DisputeRecord } from '../src/domain/dispute';
import { parsePaystackEvent } from '../src/domain/paystack';
import { rawFixture } from './helpers';

const NOW = new Date('2020-11-25T14:00:00.000Z');

function record(patch: Record<string, unknown> = {}): DisputeRecord {
  const body = JSON.parse(rawFixture('charge.dispute.create').toString('utf8')) as {
    data: Record<string, unknown>;
  };
  body.data = { ...body.data, ...patch };
  const parsed = parsePaystackEvent(JSON.stringify(body));
  assert.ok(parsed.ok);
  return {
    key: 'paystack:358950',
    issueKey: 'DIS-7',
    issueId: '1',
    snapshot: parsed.event.snapshot,
    timeline: [
      { at: '2020-11-24T18:00:03.000Z', kind: 'created', status: 'awaiting-merchant-feedback' },
      { at: '2020-11-24T18:00:04.000Z', kind: 'ticket-created', status: 'x', note: 'DIS-7' },
    ],
    alertsSent: [],
    createdAt: '2020-11-24T18:00:03.000Z',
    updatedAt: '2020-11-24T18:00:04.000Z',
  };
}

describe('agent tool text', () => {
  it('lists open disputes with deadline, evidence and response', () => {
    const dashboard = buildDashboard([record()], {}, {}, NOW);
    const text = openDisputesText(dashboard.open, NOW);
    assert.match(text, /^1 open dispute, most urgent first:/);
    assert.match(
      text,
      /DIS-7: .*58\.00, goods or service not received, 4\.0 h left \(due 25 Nov 2020 18:00 UTC\)/,
    );
    assert.match(text, /evidence 0 of 4, no response yet/);
  });

  it('says plainly when nothing is open', () => {
    assert.equal(openDisputesText([], NOW), 'There are no open disputes.');
  });

  it('describes one dispute with only stored facts', () => {
    const text = disputeText(
      record(),
      { receipt: { done: true, by: null, at: NOW.toISOString() } },
      undefined,
      NOW,
    );
    assert.match(text, /^DIS-7: Paystack dispute 358950/);
    assert.match(text, /Customer said: "Customer complained about debit without value"/);
    assert.match(text, /Deadline: 25 Nov 2020 18:00 UTC, 4\.0 h left\./);
    assert.match(text, /- \[x\] Transaction receipt/);
    assert.match(text, /- \[ \] Proof of delivery/);
    assert.match(text, /Response: not sent yet\./);
    assert.match(text, /Recent events:\n- 24 Nov 2020 18:00 UTC: Ticket DIS-7 created/);
  });

  it('reports the outcome instead of a deadline once resolved', () => {
    const text = disputeText(
      record({ status: 'resolved', resolution: 'declined' }),
      {},
      undefined,
      NOW,
    );
    assert.match(text, /Outcome: won \(Paystack resolution: declined\)\./);
    assert.doesNotMatch(text, /Deadline:/);
  });

  it('tells the agent not to assume a policy when search finds nothing', () => {
    assert.match(policyText('refund', []), /Do not assume a policy/);
    assert.match(
      policyText('refund', [
        { title: 'Refund policy', url: 'https://x/wiki/p/1', excerpt: 'Refunds within 7 days' },
      ]),
      /- Refund policy \(https:\/\/x\/wiki\/p\/1\): Refunds within 7 days/,
    );
  });

  it('cleans Confluence highlight markers from excerpts', () => {
    assert.equal(
      cleanExcerpt('We @@@hl@@@refund@@@endhl@@@ <b>within</b>\n 7 days'),
      'We refund within 7 days',
    );
  });

  it('cleans Confluence titles, including HTML entities', () => {
    assert.equal(
      cleanSearchText('G&#39;day @@@hl@@@Team@@@endhl@@@ &amp; friends'),
      "G'day Team & friends",
    );
    assert.equal(cleanSearchText('Caf&#xe9; &unknown; ok'), 'Café &unknown; ok');
  });
});
