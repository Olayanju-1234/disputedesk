import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import type { QueuedDispute } from '../src/domain/ports';
import { signPaystackBody, type PaystackSecrets } from '../src/domain/signature';
import { buildPaystackDisputeEvent, newSimDispute } from '../src/domain/simulator';
import { handlePaystackWebhook, type WebhookDeps } from '../src/handlers/webhook';
import { rawFixture } from './helpers';

const SECRET_KEY = 'sk_test_disputedesk_fixture_key';
const NOW = new Date('2026-11-22T12:00:00.000Z');

let queued: QueuedDispute[];
let logs: string[];
let secrets: PaystackSecrets;
let enqueue: WebhookDeps['enqueue'];

const deps = (): WebhookDeps => ({
  secrets: () => Promise.resolve(secrets),
  enqueue,
  now: () => NOW,
  log: (msg) => logs.push(msg),
});

function forgeHeaders(headers: Record<string, string>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), [v]]));
}

beforeEach(() => {
  queued = [];
  logs = [];
  secrets = { signingSecrets: [], secretKey: SECRET_KEY };
  enqueue = (message) => {
    queued.push(message);
    return Promise.resolve();
  };
});

describe('handlePaystackWebhook', () => {
  it('verifies the recorded payload, queues it and answers 200', async () => {
    const body = rawFixture('charge.dispute.create').toString('utf8');
    const res = await handlePaystackWebhook(
      {
        method: 'POST',
        body,
        headers: forgeHeaders(signPaystackBody(body, { secretKey: SECRET_KEY })),
      },
      deps(),
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.headers['Content-Type'], ['application/json']);
    assert.equal(queued.length, 1);
    assert.equal(
      queued[0]?.event.dedupeKey,
      'paystack:358950:charge.dispute.create:2020-11-24T18:00:02.000Z',
    );
    assert.equal(queued[0]?.scheme, 'x-paystack-signature');
    assert.equal(queued[0]?.receivedAt, NOW.toISOString());
  });

  it('answers 401 and queues nothing for a forged signature', async () => {
    const body = rawFixture('charge.dispute.create').toString('utf8');
    const forged = signPaystackBody(body, { secretKey: 'sk_test_attacker_key' });
    const res = await handlePaystackWebhook(
      { method: 'POST', body, headers: forgeHeaders(forged) },
      deps(),
    );
    assert.equal(res.statusCode, 401);
    assert.equal(queued.length, 0);
    assert.deepEqual(logs, ['webhook.rejected']);
  });

  it('answers 503 while no secret is configured so Paystack retries later', async () => {
    secrets = { signingSecrets: [] };
    const body = rawFixture('charge.dispute.create').toString('utf8');
    const res = await handlePaystackWebhook(
      {
        method: 'POST',
        body,
        headers: forgeHeaders(signPaystackBody(body, { secretKey: SECRET_KEY })),
      },
      deps(),
    );
    assert.equal(res.statusCode, 503);
  });

  it('acknowledges signed non-dispute events without queueing them', async () => {
    const body = JSON.stringify({ event: 'charge.success', data: { id: 1 } });
    const res = await handlePaystackWebhook(
      {
        method: 'POST',
        body,
        headers: forgeHeaders(signPaystackBody(body, { secretKey: SECRET_KEY })),
      },
      deps(),
    );
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /charge\.success/);
    assert.equal(queued.length, 0);
  });

  it('answers 400 for a signed dispute event it cannot read', async () => {
    const body = JSON.stringify({ event: 'charge.dispute.create', data: { status: 'pending' } });
    const res = await handlePaystackWebhook(
      {
        method: 'POST',
        body,
        headers: forgeHeaders(signPaystackBody(body, { secretKey: SECRET_KEY })),
      },
      deps(),
    );
    assert.equal(res.statusCode, 400);
    assert.equal(queued.length, 0);
  });

  it('answers 500 when the queue is unavailable so Paystack redelivers', async () => {
    enqueue = () => Promise.reject(new Error('queue down'));
    const body = rawFixture('charge.dispute.create').toString('utf8');
    const res = await handlePaystackWebhook(
      {
        method: 'POST',
        body,
        headers: forgeHeaders(signPaystackBody(body, { secretKey: SECRET_KEY })),
      },
      deps(),
    );
    assert.equal(res.statusCode, 500);
  });

  it('rejects methods other than POST', async () => {
    const res = await handlePaystackWebhook({ method: 'GET', body: '', headers: {} }, deps());
    assert.equal(res.statusCode, 405);
  });

  it('accepts what the admin simulator sends, with the timestamped scheme', async () => {
    secrets = { signingSecrets: ['whsec_simulator_secret'], secretKey: SECRET_KEY };
    const dispute = newSimDispute(NOW, 16, 12345);
    const body = buildPaystackDisputeEvent(dispute, 'create', NOW);
    const headers = signPaystackBody(body, {
      signingSecret: 'whsec_simulator_secret',
      secretKey: SECRET_KEY,
      nowSeconds: Math.floor(NOW.getTime() / 1000),
    });
    const res = await handlePaystackWebhook(
      { method: 'POST', body, headers: forgeHeaders(headers) },
      deps(),
    );
    assert.equal(res.statusCode, 200);
    assert.equal(queued[0]?.scheme, 'paystack-signature');
    assert.equal(queued[0]?.event.snapshot.mode, 'test');
    assert.equal(queued[0]?.event.snapshot.dueAt, '2026-11-23T04:00:00.000Z');
  });
});
