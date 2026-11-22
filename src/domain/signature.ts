import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_TOLERANCE_SECONDS = 300;

export type HeaderMap = Record<string, string | string[] | undefined>;

export type SignatureScheme = 'paystack-signature' | 'x-paystack-signature';

export type VerifyFailure =
  | 'no-secret-configured'
  | 'missing-signature'
  | 'malformed-signature'
  | 'timestamp-out-of-tolerance'
  | 'signature-mismatch';

export type VerifyResult =
  { ok: true; scheme: SignatureScheme; keyId?: string } | { ok: false; reason: VerifyFailure };

export interface PaystackSecrets {
  /** Webhook signing secrets (whsec_...). More than one during a rotation overlap. */
  signingSecrets: string[];
  /** Secret API key (sk_...), used by the legacy x-paystack-signature header. */
  secretKey?: string;
}

const HEX_SHA512 = /^[0-9a-f]{128}$/;

export function headerValue(headers: HeaderMap, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

export interface ParsedPaystackSignature {
  timestamp: number;
  signatures: Array<{ keyId: string; hex: string }>;
}

export function parsePaystackSignatureHeader(header: string): ParsedPaystackSignature | null {
  let timestamp: number | null = null;
  const signatures: ParsedPaystackSignature['signatures'] = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      if (timestamp !== null || !/^[0-9]+$/.test(value)) return null;
      timestamp = Number(value);
    } else if (key === 'v1') {
      const colon = value.indexOf(':');
      if (colon !== -1)
        signatures.push({ keyId: value.slice(0, colon), hex: value.slice(colon + 1) });
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

function hmacSha512(secret: string, ...parts: Array<string | Buffer>): Buffer {
  const hmac = createHmac('sha512', secret);
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}

function matchesHex(expected: Buffer, hex: string): boolean {
  if (!HEX_SHA512.test(hex)) return false;
  return timingSafeEqual(expected, Buffer.from(hex, 'hex'));
}

export function verifyPaystackSignature(
  rawBody: Buffer,
  header: string,
  signingSecrets: string[],
  nowSeconds: number,
): VerifyResult {
  const parsed = parsePaystackSignatureHeader(header);
  if (!parsed) return { ok: false, reason: 'malformed-signature' };
  if (Math.abs(nowSeconds - parsed.timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp-out-of-tolerance' };
  }
  for (const secret of signingSecrets) {
    const expected = hmacSha512(secret, `${parsed.timestamp}.`, rawBody);
    for (const { keyId, hex } of parsed.signatures) {
      if (matchesHex(expected, hex)) return { ok: true, scheme: 'paystack-signature', keyId };
    }
  }
  return { ok: false, reason: 'signature-mismatch' };
}

export function verifyLegacySignature(
  rawBody: Buffer,
  header: string,
  secretKey: string,
): VerifyResult {
  if (!HEX_SHA512.test(header)) return { ok: false, reason: 'malformed-signature' };
  return matchesHex(hmacSha512(secretKey, rawBody), header)
    ? { ok: true, scheme: 'x-paystack-signature' }
    : { ok: false, reason: 'signature-mismatch' };
}

export function verifyPaystackRequest(
  rawBody: string | Buffer,
  headers: HeaderMap,
  secrets: PaystackSecrets,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const timestamped = headerValue(headers, 'paystack-signature');
  const legacy = headerValue(headers, 'x-paystack-signature');
  const hasSigningSecret = secrets.signingSecrets.length > 0;

  // With a signing secret configured, the timestamped header is authoritative; falling back to the
  // legacy header on failure would let a captured old event skip the replay window.
  if (timestamped && hasSigningSecret) {
    return verifyPaystackSignature(body, timestamped, secrets.signingSecrets, nowSeconds);
  }
  if (legacy && secrets.secretKey) return verifyLegacySignature(body, legacy, secrets.secretKey);
  if (!hasSigningSecret && !secrets.secretKey) return { ok: false, reason: 'no-secret-configured' };
  return { ok: false, reason: 'missing-signature' };
}

export interface SignOptions {
  signingSecret?: string;
  keyId?: string;
  secretKey?: string;
  nowSeconds?: number;
}

/** Produces the headers Paystack would send for this body. Used by the admin test-dispute simulator. */
export function signPaystackBody(rawBody: string, options: SignOptions): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.signingSecret) {
    const t = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const hex = hmacSha512(options.signingSecret, `${t}.`, rawBody).toString('hex');
    headers['paystack-signature'] = `t=${t},v1=${options.keyId ?? 'whk_disputedesk'}:${hex}`;
  }
  if (options.secretKey) {
    headers['x-paystack-signature'] = hmacSha512(options.secretKey, rawBody).toString('hex');
  }
  return headers;
}
