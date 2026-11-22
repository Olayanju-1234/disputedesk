import type { WebTriggerRequest, WebTriggerResponse } from '@forge/api';
import { InvocationError, InvocationErrorCode, type AsyncEvent } from '@forge/events';
import { forgeJira } from './adapters/jira';
import { kvsStore } from './adapters/kvs-store';
import { log } from './adapters/log';
import { enqueueDispute } from './adapters/queue';
import { getConfig, getPaystackSecrets } from './adapters/settings';
import type { QueuedDispute } from './domain/ports';
import { sweepDeadlines, type ProcessDeps } from './domain/process';
import { consumeDispute } from './handlers/consumer';
import { handlePaystackWebhook } from './handlers/webhook';

export { adminResolver } from './handlers/admin';

type Body = Record<string, unknown>;

const processDeps: ProcessDeps = {
  store: kvsStore,
  jira: forgeJira,
  config: getConfig,
  now: () => new Date(),
};

export function webhook(request: WebTriggerRequest): Promise<WebTriggerResponse> {
  return handlePaystackWebhook(request, {
    secrets: getPaystackSecrets,
    enqueue: enqueueDispute,
    now: () => new Date(),
    log: log.info,
  });
}

export async function consume(event: AsyncEvent<Body>): Promise<InvocationError | undefined> {
  const message = event.body as unknown as QueuedDispute;
  const delivery = {
    body: message,
    eventId: event.eventId,
    retryCount: event.retryContext?.retryCount ?? 0,
  };
  const result = await consumeDispute(delivery, processDeps);
  log.info('consumer.result', {
    dedupeKey: message.event?.dedupeKey,
    retryCount: delivery.retryCount,
    ...result,
  });
  if (result.kind === 'retry') {
    return new InvocationError({
      retryAfter: result.afterSeconds,
      retryReason: InvocationErrorCode.FUNCTION_RETRY_REQUEST,
    });
  }
  return undefined;
}

export async function sweep(): Promise<void> {
  const result = await sweepDeadlines({ store: kvsStore, jira: forgeJira, now: () => new Date() });
  log.info('sweep.done', { ...result });
}
