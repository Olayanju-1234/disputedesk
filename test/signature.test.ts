import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  parsePaystackSignatureHeader,
  signPaystackBody,
  verifyPaystackRequest,
  type PaystackSecrets,
} from '../src/domain/signature';
import { rawFixture } from './helpers';

// Golden HMACs computed independently with `openssl dgst -sha512 -hmac` over the fixture bytes.
const SECRET_KEY = 'sk_test_disputedesk_fixture_key';
const SIGNING_SECRET = 'whsec_disputedesk_fixture_secret';
const T = 1760270400;
const GOLDEN = {
  create: {
    legacy:
      'c92bdc69dddb58e22175ed6dba312e106782b24252b8faae5236f8ed12fc43231793dc2460599ba40dfaeb85e7ab8855b540cdc2045c8cafdd916e1324cc11e4',
    v1: 'f863a21f7144308185b49986fc636f115d671cbd9bb31a83f8f2eb6355b45f6b4c4995d1123fbe8d628da98810b387edc38c91547d271f6772c039b401360bef',
  },
  resolve: {
    legacy:
      '894f0e29ff85446324fd30825a1898e9d24cbfa5abbf483dcd13aeb0aaa48497d5d0920b4fe8f8463211950e4a4559b85755d48c66e982cb415868ee8f5a41e4',
    v1: 'a472f81409f9de084806461878e9744dd866905527570c803e768ab814ba7cb02ac97ce7525b84a8e375f08ef316fa3ca277b73936950dae07e07f9287c8e195',
  },
};

const legacyOnly: PaystackSecrets = { signingSecrets: [], secretKey: SECRET_KEY };
const signingOnly: PaystackSecrets = { signingSecrets: [SIGNING_SECRET] };
const both: PaystackSecrets = { signingSecrets: [SIGNING_SECRET], secretKey: SECRET_KEY };

const create = rawFixture('charge.dispute.create');
const resolve = rawFixture('charge.dispute.resolve');

function flipLastByte(body: Buffer): Buffer {
  const copy = Buffer.from(body);
  copy[copy.length - 2] = (copy[copy.length - 2] ?? 0) ^ 1;
  return copy;
}

describe('x-paystack-signature (legacy, secret key)', () => {
  it('accepts the recorded create payload', () => {
    const result = verifyPaystackRequest(
      create,
      { 'x-paystack-signature': [GOLDEN.create.legacy] },
      legacyOnly,
    );
    assert.deepEqual(result, { ok: true, scheme: 'x-paystack-signature' });
  });

  it('accepts the recorded resolve payload passed as a string body', () => {
    const result = verifyPaystackRequest(
      resolve.toString('utf8'),
      { 'x-paystack-signature': [GOLDEN.resolve.legacy] },
      legacyOnly,
    );
    assert.equal(result.ok, true);
  });

  it('rejects a body changed by one byte', () => {
    const result = verifyPaystackRequest(
      flipLastByte(create),
      { 'x-paystack-signature': [GOLDEN.create.legacy] },
      legacyOnly,
    );
    assert.deepEqual(result, { ok: false, reason: 'signature-mismatch' });
  });

  it('rejects the same event re-serialized with different spacing', () => {
    const reserialized = JSON.stringify(JSON.parse(create.toString('utf8')), null, 2);
    const result = verifyPaystackRequest(
      reserialized,
      { 'x-paystack-signature': [GOLDEN.create.legacy] },
      legacyOnly,
    );
    assert.deepEqual(result, { ok: false, reason: 'signature-mismatch' });
  });

  it('rejects the right signature made with a different key', () => {
    const result = verifyPaystackRequest(
      create,
      { 'x-paystack-signature': [GOLDEN.create.legacy] },
      { signingSecrets: [], secretKey: 'sk_test_someone_else' },
    );
    assert.deepEqual(result, { ok: false, reason: 'signature-mismatch' });
  });

  it('rejects uppercase or truncated hex as malformed', () => {
    for (const sig of [GOLDEN.create.legacy.toUpperCase(), GOLDEN.create.legacy.slice(0, 64)]) {
      const result = verifyPaystackRequest(create, { 'x-paystack-signature': sig }, legacyOnly);
      assert.deepEqual(result, { ok: false, reason: 'malformed-signature' });
    }
  });

  it('reads header names case-insensitively', () => {
    const result = verifyPaystackRequest(
      create,
      { 'X-Paystack-Signature': GOLDEN.create.legacy },
      legacyOnly,
    );
    assert.equal(result.ok, true);
  });
});

describe('Paystack-Signature (timestamped, signing secret)', () => {
  const header = (hex: string, t = T, kid = 'whk_3f9a1c2e') => `t=${t},v1=${kid}:${hex}`;

  it('accepts the recorded create payload and reports the key id', () => {
    const result = verifyPaystackRequest(
      create,
      { 'paystack-signature': [header(GOLDEN.create.v1)] },
      signingOnly,
      T,
    );
    assert.deepEqual(result, { ok: true, scheme: 'paystack-signature', keyId: 'whk_3f9a1c2e' });
  });

  it('accepts at exactly 300 seconds of skew and rejects at 301', () => {
    const headers = { 'paystack-signature': header(GOLDEN.create.v1) };
    assert.equal(verifyPaystackRequest(create, headers, signingOnly, T + 300).ok, true);
    assert.equal(verifyPaystackRequest(create, headers, signingOnly, T - 300).ok, true);
    assert.deepEqual(verifyPaystackRequest(create, headers, signingOnly, T + 301), {
      ok: false,
      reason: 'timestamp-out-of-tolerance',
    });
  });

  it('rejects a valid signature whose timestamp was edited', () => {
    const result = verifyPaystackRequest(
      create,
      { 'paystack-signature': header(GOLDEN.create.v1, T + 10) },
      signingOnly,
      T,
    );
    assert.deepEqual(result, { ok: false, reason: 'signature-mismatch' });
  });

  it('accepts when any of several v1 entries matches (secret rotation overlap)', () => {
    const stale = 'a'.repeat(128);
    const value = `t=${T},v1=whk_old:${stale},v1=whk_new:${GOLDEN.create.v1}`;
    const result = verifyPaystackRequest(create, { 'paystack-signature': value }, signingOnly, T);
    assert.deepEqual(result, { ok: true, scheme: 'paystack-signature', keyId: 'whk_new' });
  });

  it('accepts when the second configured secret matches', () => {
    const result = verifyPaystackRequest(
      create,
      { 'paystack-signature': header(GOLDEN.create.v1) },
      { signingSecrets: ['whsec_retired', SIGNING_SECRET] },
      T,
    );
    assert.equal(result.ok, true);
  });

  it('ignores unknown header fields', () => {
    const value = `t=${T},v0=legacy,scheme=x,v1=whk_1:${GOLDEN.create.v1}`;
    const result = verifyPaystackRequest(create, { 'paystack-signature': value }, signingOnly, T);
    assert.equal(result.ok, true);
  });

  it('treats a missing timestamp, a repeated timestamp or no v1 as malformed', () => {
    for (const value of [
      `v1=whk_1:${GOLDEN.create.v1}`,
      `t=${T},t=${T},v1=whk_1:${GOLDEN.create.v1}`,
      `t=${T}`,
      `t=12ab,v1=whk_1:${GOLDEN.create.v1}`,
    ]) {
      const result = verifyPaystackRequest(create, { 'paystack-signature': value }, signingOnly, T);
      assert.deepEqual(result, { ok: false, reason: 'malformed-signature' }, value);
    }
  });

  it('does not fall back to the legacy header when the timestamped one fails', () => {
    const result = verifyPaystackRequest(
      create,
      {
        'paystack-signature': header(GOLDEN.create.v1, T - 3600),
        'x-paystack-signature': GOLDEN.create.legacy,
      },
      both,
      T,
    );
    assert.deepEqual(result, { ok: false, reason: 'timestamp-out-of-tolerance' });
  });

  it('uses the legacy header when no signing secret is configured yet', () => {
    const result = verifyPaystackRequest(
      create,
      {
        'paystack-signature': header(GOLDEN.create.v1),
        'x-paystack-signature': GOLDEN.create.legacy,
      },
      legacyOnly,
      T,
    );
    assert.deepEqual(result, { ok: true, scheme: 'x-paystack-signature' });
  });
});

describe('configuration and missing headers', () => {
  it('reports when no secret is configured', () => {
    const result = verifyPaystackRequest(
      create,
      { 'x-paystack-signature': GOLDEN.create.legacy },
      { signingSecrets: [] },
    );
    assert.deepEqual(result, { ok: false, reason: 'no-secret-configured' });
  });

  it('reports a missing signature when no usable header is present', () => {
    assert.deepEqual(verifyPaystackRequest(create, {}, both, T), {
      ok: false,
      reason: 'missing-signature',
    });
    assert.deepEqual(verifyPaystackRequest(create, { 'paystack-signature': 'x' }, legacyOnly, T), {
      ok: false,
      reason: 'missing-signature',
    });
  });
});

describe('signPaystackBody (simulator)', () => {
  it('reproduces the golden signatures for a fixed timestamp', () => {
    const headers = signPaystackBody(create.toString('utf8'), {
      signingSecret: SIGNING_SECRET,
      secretKey: SECRET_KEY,
      keyId: 'whk_sim',
      nowSeconds: T,
    });
    assert.equal(headers['paystack-signature'], `t=${T},v1=whk_sim:${GOLDEN.create.v1}`);
    assert.equal(headers['x-paystack-signature'], GOLDEN.create.legacy);
  });

  it('produces headers that the verifier accepts', () => {
    const body = JSON.stringify({ event: 'charge.dispute.create', data: { id: 1 } });
    const headers = signPaystackBody(body, { signingSecret: SIGNING_SECRET, nowSeconds: T });
    assert.equal(verifyPaystackRequest(body, headers, signingOnly, T).ok, true);
    const parsed = parsePaystackSignatureHeader(headers['paystack-signature'] ?? '');
    assert.equal(parsed?.timestamp, T);
  });
});
