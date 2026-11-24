import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createPaystackClient, PaystackError, type HttpFetch } from '../src/adapters/paystack';

interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeHttp(responses: Array<{ status: number; body: unknown } | Error>) {
  const sent: Sent[] = [];
  const http: HttpFetch = (url, init) => {
    sent.push({
      url,
      method: init.method,
      headers: init.headers ?? {},
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : init.body,
    });
    const next = responses.shift();
    if (!next) throw new Error('no response queued');
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve({
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: () =>
        Promise.resolve(typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
    });
  };
  return { http, sent };
}

describe('Paystack dispute client', () => {
  it('adds fraud evidence with Paystack field names and returns the evidence id', async () => {
    const { http, sent } = fakeHttp([{ status: 200, body: { status: true, data: { id: 21 } } }]);
    const client = createPaystackClient('sk_test_x', http);
    const result = await client.addEvidence('624', {
      customerEmail: 'cus@example.com',
      customerName: 'Mensah King',
      customerPhone: '0802345167',
      serviceDetails: 'claim for buying product',
      deliveryDate: '2026-11-20',
    });
    assert.deepEqual(result, { id: 21 });
    assert.equal(sent[0]?.url, 'https://api.paystack.co/dispute/624/evidence');
    assert.equal(sent[0]?.method, 'POST');
    assert.equal(sent[0]?.headers.Authorization, 'Bearer sk_test_x');
    assert.deepEqual(sent[0]?.body, {
      customer_email: 'cus@example.com',
      customer_name: 'Mensah King',
      customer_phone: '0802345167',
      service_details: 'claim for buying product',
      delivery_date: '2026-11-20',
    });
  });

  it('asks for an upload URL with the file name as a query parameter', async () => {
    const { http, sent } = fakeHttp([
      { status: 200, body: { status: true, data: { signedUrl: 'https://s3/x', fileName: 'abc' } } },
    ]);
    const client = createPaystackClient('sk_test_x', http);
    assert.deepEqual(await client.getUploadUrl('624', 'receipt one.pdf'), {
      signedUrl: 'https://s3/x',
      fileName: 'abc',
    });
    assert.equal(
      sent[0]?.url,
      'https://api.paystack.co/dispute/624/upload_url?upload_filename=receipt+one.pdf',
    );
  });

  it('resolves with the uploaded file and evidence id', async () => {
    const { http, sent } = fakeHttp([{ status: 200, body: { status: true, data: {} } }]);
    await createPaystackClient('sk_test_x', http).resolve('624', {
      resolution: 'declined',
      message: 'Goods were delivered',
      refundAmountMinor: 0,
      uploadedFilename: 'abc',
      evidenceId: 21,
    });
    assert.equal(sent[0]?.method, 'PUT');
    assert.deepEqual(sent[0]?.body, {
      resolution: 'declined',
      message: 'Goods were delivered',
      refund_amount: 0,
      uploaded_filename: 'abc',
      evidence: 21,
    });
  });

  it('uploads raw bytes to the signed URL without the API key', async () => {
    const { http, sent } = fakeHttp([{ status: 200, body: '' }]);
    await createPaystackClient('sk_test_x', http).uploadFile(
      'https://s3.eu-west-1.amazonaws.com/files.paystack.co/abc',
      new Uint8Array([1, 2, 3]),
      'application/pdf',
    );
    assert.equal(sent[0]?.method, 'PUT');
    assert.equal(sent[0]?.headers.Authorization, undefined);
    assert.deepEqual(sent[0]?.body, new Uint8Array([1, 2, 3]));
  });

  it('marks a Paystack rejection as not retryable and keeps its message', async () => {
    const { http } = fakeHttp([
      { status: 404, body: { status: false, message: 'Dispute not found' } },
    ]);
    const err = await createPaystackClient('sk', http)
      .resolve('1', {
        resolution: 'declined',
        message: 'm',
        refundAmountMinor: 0,
      })
      .catch((e: unknown) => e);
    assert.ok(err instanceof PaystackError);
    assert.equal(err.message, 'Dispute not found');
    assert.equal(err.retryable, false);
  });

  it('marks network failures and 5xx as retryable', async () => {
    const down = fakeHttp([new Error('ECONNRESET')]);
    const e1 = await createPaystackClient('sk', down.http)
      .getUploadUrl('1', 'a.pdf')
      .catch((e: unknown) => e);
    assert.ok(e1 instanceof PaystackError && e1.retryable && e1.status === null);
    const busy = fakeHttp([{ status: 503, body: 'Service Unavailable' }]);
    const e2 = await createPaystackClient('sk', busy.http)
      .getUploadUrl('1', 'a.pdf')
      .catch((e: unknown) => e);
    assert.ok(e2 instanceof PaystackError && e2.retryable && e2.status === 503);
  });
});
