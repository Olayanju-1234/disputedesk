import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { parsePaystackEvent } from '../src/domain/paystack';
import type { QueuedDispute } from '../src/domain/ports';
import {
  buildPaystackDisputeEvent,
  newSimDispute,
  type SimScenario,
} from '../src/domain/simulator';
import { consumeDispute, MAX_RETRIES, retryDelaySeconds } from '../src/handlers/consumer';
import { configured, FakeJira, MemoryStore } from './fakes';
import { rawFixture } from './helpers';

const NOW = new Date('2020-11-24T19:00:00.000Z');
let store: MemoryStore;
let jira: FakeJira;
const deps = () => ({ store, jira, config: configured, now: () => NOW });

function message(): QueuedDispute {
  const parsed = parsePaystackEvent(rawFixture('charge.dispute.create').toString('utf8'));
  assert.ok(parsed.ok);
  return {
    version: 1,
    event: parsed.event,
    receivedAt: NOW.toISOString(),
    scheme: 'x-paystack-signature',
    source: 'webhook',
  };
}

beforeEach(() => {
  store = new MemoryStore();
  jira = new FakeJira();
});

describe('consumeDispute', () => {
  it('processes a delivery', async () => {
    const result = await consumeDispute({ body: message(), eventId: 'e1', retryCount: 0 }, deps());
    assert.deepEqual(result, { kind: 'done', outcome: 'created' });
  });

  it('asks for a retry with backoff on a transient failure', async () => {
    jira.failNext.create = new Error('Jira responded 503');
    const result = await consumeDispute({ body: message(), eventId: 'e1', retryCount: 1 }, deps());
    assert.deepEqual(result, { kind: 'retry', afterSeconds: 60, error: 'Jira responded 503' });
    assert.equal(store.deadLetters.length, 0);
  });

  it('dead-letters after the last allowed retry', async () => {
    jira.failNext.create = new Error('Jira responded 503');
    const result = await consumeDispute(
      { body: message(), eventId: 'e9', retryCount: MAX_RETRIES },
      deps(),
    );
    assert.equal(result.kind, 'dead-lettered');
    assert.equal(store.deadLetters[0]?.id, 'e9');
    assert.equal(store.deadLetters[0]?.attempts, MAX_RETRIES + 1);
    assert.equal(store.deadLetters[0]?.disputeKey, 'paystack:358950');
  });

  it('dead-letters a permanent failure on the first attempt', async () => {
    const unconfigured = {
      ...deps(),
      config: () => Promise.resolve({ projectKey: null, issueType: 'Task' }),
    };
    const result = await consumeDispute(
      { body: message(), eventId: 'e2', retryCount: 0 },
      unconfigured,
    );
    assert.equal(result.kind, 'dead-lettered');
    assert.match(store.deadLetters[0]?.error ?? '', /No Jira project configured/);
  });

  it('replaying a dead letter after fixing the cause creates the ticket', async () => {
    const unconfigured = {
      ...deps(),
      config: () => Promise.resolve({ projectKey: null, issueType: 'Task' }),
    };
    await consumeDispute({ body: message(), eventId: 'e3', retryCount: 0 }, unconfigured);
    const dead = store.deadLetters[0];
    assert.ok(dead);
    const replayed = await consumeDispute(
      { body: { ...dead.message, source: 'replay' }, eventId: 'e4', retryCount: 0 },
      deps(),
    );
    assert.deepEqual(replayed, { kind: 'done', outcome: 'created' });
  });

  it('caps the backoff at 15 minutes', () => {
    assert.deepEqual([0, 1, 2, 3, 10].map(retryDelaySeconds), [30, 60, 120, 240, 900]);
  });
});

describe('simulator lifecycle through the consumer', () => {
  it('runs create, remind and resolve for one simulated dispute', async () => {
    const dispute = newSimDispute(NOW, 16, 4242);
    const steps: SimScenario[] = ['create', 'remind', 'resolve-won'];
    const outcomes: string[] = [];
    for (const [i, scenario] of steps.entries()) {
      const at = new Date(NOW.getTime() + i * 60_000);
      const parsed = parsePaystackEvent(buildPaystackDisputeEvent(dispute, scenario, at));
      assert.ok(parsed.ok);
      const body: QueuedDispute = {
        version: 1,
        event: parsed.event,
        receivedAt: at.toISOString(),
        scheme: 'paystack-signature',
        source: 'simulator',
      };
      const result = await consumeDispute({ body, eventId: `s${i}`, retryCount: 0 }, deps());
      outcomes.push(result.kind === 'done' ? result.outcome : result.kind);
    }
    assert.deepEqual(outcomes, ['created', 'updated', 'updated']);
    const record = [...store.disputes.values()][0];
    assert.equal(record?.snapshot.resolution, 'declined');
    assert.equal(jira.calls.at(-1)?.op, 'transition');
  });
});
