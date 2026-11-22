import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { DisputeEvent } from '../src/domain/dispute';
import { parsePaystackEvent } from '../src/domain/paystack';
import { PermanentError } from '../src/domain/ports';
import {
  LOST_TRANSITIONS,
  processDisputeEvent,
  sweepDeadlines,
  WON_TRANSITIONS,
} from '../src/domain/process';
import { configured, FakeJira, MemoryStore } from './fakes';
import { rawFixture, type PaystackFixture } from './helpers';

function event(name: PaystackFixture, patch: Record<string, unknown> = {}): DisputeEvent {
  const body = JSON.parse(rawFixture(name).toString('utf8')) as { data: Record<string, unknown> };
  body.data = { ...body.data, id: 358950, ...patch };
  const result = parsePaystackEvent(JSON.stringify(body));
  assert.ok(result.ok);
  return result.event;
}

const NOW = new Date('2020-11-24T19:00:00.000Z');
let store: MemoryStore;
let jira: FakeJira;
const deps = () => ({ store, jira, config: configured, now: () => NOW });

beforeEach(() => {
  store = new MemoryStore();
  jira = new FakeJira();
});

describe('processDisputeEvent', () => {
  it('creates a labelled ticket with a due date for a new dispute', async () => {
    assert.equal(await processDisputeEvent(event('charge.dispute.create'), deps()), 'created');
    const create = jira.calls[0];
    assert.equal(create?.op, 'create');
    assert.ok(create?.op === 'create');
    assert.deepEqual(create.issue.labels, ['disputedesk', 'dd-paystack-358950']);
    assert.equal(create.issue.dueDate, '2020-11-25');
    assert.match(create.issue.summary, /^Chargeback .*58\.00 on v3mjfgbnc19v97x \(John Doe\)$/);
    const record = store.disputes.get('paystack:358950');
    assert.equal(record?.issueKey, 'DIS-1');
    assert.deepEqual(
      record?.timeline.map((t) => t.kind),
      ['created', 'ticket-created'],
    );
  });

  it('skips a duplicate delivery without touching Jira', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    const before = jira.calls.length;
    assert.equal(await processDisputeEvent(event('charge.dispute.create'), deps()), 'duplicate');
    assert.equal(jira.calls.length, before);
  });

  it('records an unchanged reminder without commenting', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    jira.calls.length = 0;
    assert.equal(await processDisputeEvent(event('charge.dispute.remind'), deps()), 'updated');
    assert.deepEqual(jira.calls, []);
    assert.equal(store.disputes.get('paystack:358950')?.timeline.at(-1)?.kind, 'reminder');
  });

  it('comments on a status change', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    jira.calls.length = 0;
    const moved = event('charge.dispute.remind', {
      status: 'awaiting-bank-feedback',
      updated_at: '2020-11-24T20:00:00.000Z',
    });
    await processDisputeEvent(moved, deps());
    assert.deepEqual(jira.ops(), ['comment']);
  });

  it('closes the ticket as lost when Paystack auto-accepts', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    jira.calls.length = 0;
    const resolve = event('charge.dispute.resolve', { updated_at: '2020-11-25T18:00:05.000Z' });
    assert.equal(await processDisputeEvent(resolve, deps()), 'updated');
    assert.deepEqual(jira.ops(), ['comment', 'update', 'transition']);
    const labels = jira.calls.find((c) => c.op === 'update' && c.update.addLabels);
    assert.deepEqual(labels?.op === 'update' && labels.update.addLabels, ['dd-lost']);
    const transition = jira.calls.at(-1);
    assert.deepEqual(transition?.op === 'transition' && transition.targets, LOST_TRANSITIONS);
  });

  it('closes the ticket as won when the dispute is declined', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    jira.calls.length = 0;
    const won = event('charge.dispute.resolve', {
      resolution: 'declined',
      dueAt: '2020-11-25T18:00:00.000Z',
      updated_at: '2020-11-26T10:00:00.000Z',
    });
    await processDisputeEvent(won, deps());
    const transition = jira.calls.at(-1);
    assert.deepEqual(transition?.op === 'transition' && transition.targets, WON_TRANSITIONS);
  });

  it('creates the ticket already resolved when the resolve event arrives first', async () => {
    const resolve = event('charge.dispute.resolve', { updated_at: '2020-11-25T18:00:05.000Z' });
    assert.equal(await processDisputeEvent(resolve, deps()), 'created');
    assert.deepEqual(jira.ops(), ['create', 'comment', 'update', 'transition']);
  });

  it('ignores a create that arrives after the resolve', async () => {
    await processDisputeEvent(
      event('charge.dispute.resolve', { updated_at: '2020-11-25T18:00:05.000Z' }),
      deps(),
    );
    jira.calls.length = 0;
    assert.equal(await processDisputeEvent(event('charge.dispute.create'), deps()), 'stale');
    assert.deepEqual(jira.calls, []);
    assert.equal(store.disputes.get('paystack:358950')?.snapshot.status, 'resolved');
    assert.equal(store.disputes.get('paystack:358950')?.timeline.at(-1)?.kind, 'stale-ignored');
  });

  it('reuses the ticket from an earlier attempt that crashed before saving', async () => {
    jira.labelled.set('dd-paystack-358950', { id: '10042', key: 'DIS-42' });
    assert.equal(await processDisputeEvent(event('charge.dispute.create'), deps()), 'created');
    assert.equal(jira.ops().includes('create'), false);
    assert.equal(store.disputes.get('paystack:358950')?.issueKey, 'DIS-42');
  });

  it('does not mark the event processed when Jira fails, so the retry runs again', async () => {
    jira.failNext.create = new Error('Jira 503');
    await assert.rejects(processDisputeEvent(event('charge.dispute.create'), deps()), /Jira 503/);
    assert.equal(store.processed.size, 0);
    assert.equal(await processDisputeEvent(event('charge.dispute.create'), deps()), 'created');
  });

  it('fails permanently when no project is configured', async () => {
    const unconfigured = {
      ...deps(),
      config: () => Promise.resolve({ projectKey: null, issueType: 'Task' }),
    };
    await assert.rejects(
      processDisputeEvent(event('charge.dispute.create'), unconfigured),
      PermanentError,
    );
  });
});

describe('sweepDeadlines', () => {
  const at = (iso: string) => ({ store, jira, now: () => new Date(iso) });

  it('alerts once per threshold and raises priority', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    jira.calls.length = 0;
    const first = await sweepDeadlines(at('2020-11-25T14:30:00.000Z'));
    assert.deepEqual(first, { checked: 1, alerted: ['DIS-1'], failed: [], priorityNotSet: [] });
    assert.deepEqual(jira.ops(), ['comment', 'update']);
    const priority = jira.calls[1];
    assert.equal(priority?.op === 'update' && priority.update.priority, 'High');
    assert.deepEqual(store.disputes.get('paystack:358950')?.alertsSent, [8, 4]);

    jira.calls.length = 0;
    assert.deepEqual((await sweepDeadlines(at('2020-11-25T14:35:00.000Z'))).alerted, []);
    assert.deepEqual(jira.calls, []);
  });

  it('comments without a priority change once overdue', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    const record = store.disputes.get('paystack:358950');
    assert.ok(record);
    await store.saveDispute({ ...record, alertsSent: [8, 4, 1] });
    jira.calls.length = 0;
    await sweepDeadlines(at('2020-11-25T18:10:00.000Z'));
    assert.deepEqual(jira.ops(), ['comment']);
  });

  it('skips resolved disputes', async () => {
    await processDisputeEvent(
      event('charge.dispute.resolve', { updated_at: '2020-11-25T18:00:05.000Z' }),
      deps(),
    );
    jira.calls.length = 0;
    const result = await sweepDeadlines(at('2020-11-25T17:30:00.000Z'));
    assert.equal(result.checked, 0);
    assert.deepEqual(jira.calls, []);
  });

  it('keeps going when a priority update is rejected by the project screen', async () => {
    await processDisputeEvent(event('charge.dispute.create'), deps());
    jira.calls.length = 0;
    jira.failNext.update = new Error('priority is not on the edit screen');
    const result = await sweepDeadlines(at('2020-11-25T17:30:00.000Z'));
    assert.deepEqual(result.alerted, ['DIS-1']);
    assert.deepEqual(result.priorityNotSet, ['DIS-1']);
    assert.deepEqual(jira.ops(), ['comment']);
  });
});
