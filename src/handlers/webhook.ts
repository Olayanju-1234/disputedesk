import { parsePaystackEvent } from '../domain/paystack';
import type { QueuedDispute } from '../domain/ports';
import { verifyPaystackRequest, type HeaderMap, type PaystackSecrets } from '../domain/signature';

export interface WebhookRequest {
  method: string;
  body: string;
  headers: HeaderMap;
}

export interface WebhookResponse {
  statusCode: number;
  headers: Record<string, string[]>;
  body: string;
}

export interface WebhookDeps {
  secrets: () => Promise<PaystackSecrets>;
  enqueue: (message: QueuedDispute) => Promise<void>;
  now: () => Date;
  log: (msg: string, fields: Record<string, unknown>) => void;
}

function json(statusCode: number, body: Record<string, unknown>): WebhookResponse {
  return {
    statusCode,
    headers: { 'Content-Type': ['application/json'] },
    body: JSON.stringify(body),
  };
}

export async function handlePaystackWebhook(
  req: WebhookRequest,
  deps: WebhookDeps,
): Promise<WebhookResponse> {
  if (req.method !== 'POST') return json(405, { error: 'method-not-allowed' });

  const now = deps.now();
  const verified = verifyPaystackRequest(
    req.body,
    req.headers,
    await deps.secrets(),
    Math.floor(now.getTime() / 1000),
  );
  if (!verified.ok) {
    deps.log('webhook.rejected', { reason: verified.reason });
    // 503 while unconfigured makes Paystack keep retrying (up to 72 h live) instead of dropping the event.
    return verified.reason === 'no-secret-configured'
      ? json(503, { error: verified.reason })
      : json(401, { error: 'invalid-signature' });
  }

  const parsed = parsePaystackEvent(req.body);
  if (!parsed.ok) {
    if (parsed.reason === 'not-a-dispute-event') {
      return json(200, { received: true, ignored: parsed.providerEvent ?? 'unknown' });
    }
    // Signed by Paystack but unreadable: a 4xx keeps it in Paystack's retry log until the parser is fixed.
    deps.log('webhook.unparseable', {
      reason: parsed.reason,
      detail: parsed.detail,
      event: parsed.providerEvent,
    });
    return json(400, { error: parsed.reason });
  }

  try {
    await deps.enqueue({
      version: 1,
      event: parsed.event,
      receivedAt: now.toISOString(),
      scheme: verified.scheme,
      source: 'webhook',
    });
  } catch (err) {
    deps.log('webhook.enqueue_failed', { error: err instanceof Error ? err.message : String(err) });
    return json(500, { error: 'enqueue-failed' });
  }
  deps.log('webhook.accepted', { dedupeKey: parsed.event.dedupeKey, scheme: verified.scheme });
  return json(200, { received: true });
}
