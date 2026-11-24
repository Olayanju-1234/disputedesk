import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import {
  PaystackError,
  type EvidenceInput,
  type PaystackDisputeClient,
  type ResolveInput,
} from '../src/adapters/paystack';
import type { DisputeSnapshot } from '../src/domain/dispute';
import { parsePaystackEvent } from '../src/domain/paystack';
import {
  canRespond,
  describeResponse,
  ResponseValidationError,
  submitResponse,
  type AttachmentFile,
  type ResponseDeps,
} from '../src/domain/response';
import { rawFixture } from './helpers';

function snapshot(patch: Record<string, unknown> = {}): DisputeSnapshot {
  const body = JSON.parse(rawFixture('charge.dispute.create').toString('utf8')) as {
    data: Record<string, unknown>;
  };
  body.data = { ...body.data, ...patch };
  const parsed = parsePaystackEvent(JSON.stringify(body));
  assert.ok(parsed.ok);
  return parsed.event.snapshot;
}

class FakePaystack implements PaystackDisputeClient {
  calls: string[] = [];
  resolved: ResolveInput[] = [];
  failOn: Partial<Record<'evidence' | 'upload-url' | 'upload' | 'resolve', PaystackError>> = {};
  private fail(step: keyof FakePaystack['failOn']) {
    const err = this.failOn[step];
    if (err) {
      delete this.failOn[step];
      throw err;
    }
  }
  addEvidence() {
    this.calls.push('evidence');
    this.fail('evidence');
    return Promise.resolve({ id: 21 });
  }
  getUploadUrl(_id: string, filename: string) {
    this.calls.push(`upload-url:${filename}`);
    this.fail('upload-url');
    return Promise.resolve({ signedUrl: 'https://s3/signed', fileName: 'paystack-file-1' });
  }
  uploadFile() {
    this.calls.push('upload');
    this.fail('upload');
    return Promise.resolve();
  }
  resolve(_id: string, input: ResolveInput) {
    this.calls.push('resolve');
    this.fail('resolve');
    this.resolved.push(input);
    return Promise.resolve();
  }
}

const RECEIPT: AttachmentFile = {
  bytes: new Uint8Array([37, 80, 68, 70]),
  filename: 'receipt.pdf',
  mimeType: 'application/pdf',
};

const FRAUD_EVIDENCE: EvidenceInput = {
  customerEmail: 'example@test.com',
  customerName: 'John Doe',
  customerPhone: '08000000000',
  serviceDetails: 'Two pairs of shoes delivered to the customer',
};

let paystack: FakePaystack;
let downloads: string[];
const deps = (file: AttachmentFile = RECEIPT): ResponseDeps => ({
  paystack,
  downloadAttachment: (id) => {
    downloads.push(id);
    return Promise.resolve(file);
  },
  now: () => new Date('2020-11-24T20:00:00.000Z'),
});

beforeEach(() => {
  paystack = new FakePaystack();
  downloads = [];
});

const contest = {
  action: 'contest' as const,
  message: 'Goods were delivered',
  attachmentId: '10001',
};

describe('submitResponse', () => {
  it('contests a chargeback: uploads the receipt then declines with its file name', async () => {
    const result = await submitResponse(snapshot(), contest, undefined, 'acc-1', deps());
    assert.equal(result.status, 'confirmed');
    assert.deepEqual(paystack.calls, ['upload-url:receipt.pdf', 'upload', 'resolve']);
    assert.deepEqual(paystack.resolved[0], {
      resolution: 'declined',
      message: 'Goods were delivered',
      refundAmountMinor: 0,
      uploadedFilename: 'paystack-file-1',
      evidenceId: undefined,
    });
    assert.equal(result.attachmentName, 'receipt.pdf');
    assert.equal(result.by, 'acc-1');
  });

  it('adds evidence first for a fraud claim and passes its id', async () => {
    const fraud = snapshot({ category: 'fraud' });
    await submitResponse(fraud, { ...contest, evidence: FRAUD_EVIDENCE }, undefined, null, deps());
    assert.deepEqual(paystack.calls, ['evidence', 'upload-url:receipt.pdf', 'upload', 'resolve']);
    assert.equal(paystack.resolved[0]?.evidenceId, 21);
  });

  it('accepts with a full refund of the disputed amount', async () => {
    const result = await submitResponse(
      snapshot(),
      { action: 'accept', message: 'Refund the customer' },
      undefined,
      null,
      deps(),
    );
    assert.equal(result.status, 'confirmed');
    assert.deepEqual(paystack.calls, ['resolve']);
    assert.equal(paystack.resolved[0]?.resolution, 'merchant-accepted');
    assert.equal(paystack.resolved[0]?.refundAmountMinor, 5800);
  });

  it('records the response as unconfirmed when Paystack is unreachable, then retries without re-uploading', async () => {
    paystack.failOn.resolve = new PaystackError('Paystack unreachable: timeout', null);
    const first = await submitResponse(snapshot(), contest, undefined, null, deps());
    assert.equal(first.status, 'unconfirmed');
    assert.equal(first.uploadedFilename, 'paystack-file-1');
    assert.match(describeResponse(first), /did not confirm/);

    paystack.calls = [];
    const second = await submitResponse(snapshot(), contest, first, null, deps());
    assert.equal(second.status, 'confirmed');
    assert.equal(second.attempts, 2);
    assert.deepEqual(paystack.calls, ['resolve']);
  });

  it('does not add fraud evidence twice when a retry follows a failed resolve', async () => {
    const fraud = snapshot({ category: 'fraud' });
    paystack.failOn.resolve = new PaystackError('Paystack responded 502', 502);
    const first = await submitResponse(
      fraud,
      { ...contest, evidence: FRAUD_EVIDENCE },
      undefined,
      null,
      deps(),
    );
    paystack.calls = [];
    await submitResponse(fraud, { ...contest, evidence: FRAUD_EVIDENCE }, first, null, deps());
    assert.deepEqual(paystack.calls, ['resolve']);
  });

  it('reports a Paystack rejection with its reason', async () => {
    paystack.failOn['upload-url'] = new PaystackError('Dispute not found', 404);
    const result = await submitResponse(snapshot(), contest, undefined, null, deps());
    assert.equal(result.status, 'rejected');
    assert.equal(result.error, 'Dispute not found');
    assert.deepEqual(paystack.calls, ['upload-url:receipt.pdf']);
  });

  it('records simulator disputes without calling Paystack', async () => {
    const simulated = snapshot({
      domain: 'test',
      transaction: { reference: 'dd-test-abc', amount: 5800, currency: 'NGN' },
    });
    const result = await submitResponse(simulated, contest, undefined, null, deps());
    assert.equal(result.status, 'simulated');
    assert.deepEqual(paystack.calls, []);
    assert.deepEqual(downloads, ['10001']);
  });

  it('refuses a second response once one was confirmed', async () => {
    const first = await submitResponse(snapshot(), contest, undefined, null, deps());
    await assert.rejects(
      submitResponse(snapshot(), contest, first, null, deps()),
      ResponseValidationError,
    );
    assert.equal(canRespond(snapshot(), first), false);
  });

  it('validates the inputs before touching Paystack', async () => {
    await assert.rejects(
      submitResponse(snapshot(), { action: 'contest', message: ' ' }, undefined, null, deps()),
      /short message.*receipt/,
    );
    await assert.rejects(
      submitResponse(snapshot({ category: 'fraud' }), contest, undefined, null, deps()),
      /Fraud claims need: customer email, customer name, customer phone, what was provided/,
    );
    await assert.rejects(
      submitResponse(
        snapshot(),
        contest,
        undefined,
        null,
        deps({ ...RECEIPT, mimeType: 'image/png' }),
      ),
      /PDF or JPEG/,
    );
    await assert.rejects(
      submitResponse(
        snapshot({ status: 'resolved', resolution: 'declined' }),
        contest,
        undefined,
        null,
        deps(),
      ),
      /already resolved/,
    );
    assert.deepEqual(paystack.calls, []);
  });

  it('asks for the secret key when none is saved', async () => {
    await assert.rejects(
      submitResponse(snapshot(), contest, undefined, null, { ...deps(), paystack: null }),
      /secret key/,
    );
  });
});
