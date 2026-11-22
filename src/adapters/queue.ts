import { Queue } from '@forge/events';
import type { QueuedDispute } from '../domain/ports';

export const DISPUTE_QUEUE = 'dispute-events';

const queue = new Queue({ key: DISPUTE_QUEUE });

export async function enqueueDispute(message: QueuedDispute): Promise<void> {
  const { provider, providerDisputeId } = message.event.snapshot;
  await queue.push({
    body: message as unknown as Record<string, unknown>,
    // One event per dispute at a time, so two deliveries can't both decide "create" and open two tickets.
    concurrency: { key: `${provider}-${providerDisputeId}`, limit: 1 },
  });
}
