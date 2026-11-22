import { __requestAtlassianAsApp, type FetchMethod } from '@forge/api';
import { Queue, type PushEvent } from '@forge/events';
import type { QueuedDispute } from '../domain/ports';
import { log } from './log';

export const DISPUTE_QUEUE = 'dispute-events';

// @forge/events drops the API's errorMessage field on failure; log it so rejections are diagnosable.
const loggingClient: FetchMethod = async (url, init) => {
  const res = await __requestAtlassianAsApp(url, init);
  if (res.status < 400) return res;
  const text = await res.text();
  log.error('queue.push_rejected', { status: res.status, url, body: text.slice(0, 800) });
  return {
    ...res,
    status: res.status,
    statusText: res.statusText,
    ok: false,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text || '{}') as unknown),
  };
};

const queue = new Queue({ key: DISPUTE_QUEUE }, loggingClient);

interface EventsApiError {
  message?: string;
  errorCode?: unknown;
}

function isBadRequest(err: unknown): boolean {
  const e = err as EventsApiError;
  return e.errorCode === 400 || (typeof e.message === 'string' && e.message.startsWith('400'));
}

export async function enqueueDispute(message: QueuedDispute): Promise<void> {
  const { provider, providerDisputeId } = message.event.snapshot;
  const event: PushEvent = { body: message as unknown as Record<string, unknown> };
  try {
    // One event per dispute at a time, so two deliveries can't both decide "create" and open two tickets.
    await queue.push({
      ...event,
      concurrency: { key: `${provider}-${providerDisputeId}`, limit: 1 },
    });
  } catch (err) {
    if (!isBadRequest(err)) throw err;
    // Fallback if the platform rejects concurrency control; dedupe and the label lookup still guard creates.
    log.warn('queue.concurrency_rejected', { message: (err as EventsApiError).message });
    await queue.push(event);
  }
}
