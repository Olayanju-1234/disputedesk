import { disputeKey } from '../domain/dispute';
import { PermanentError, type QueuedDispute } from '../domain/ports';
import { processDisputeEvent, type ProcessDeps, type ProcessOutcome } from '../domain/process';

/** Forge redelivers a failed event at most 4 times; the last allowed failure goes to the dead-letter list. */
export const MAX_RETRIES = 3;

export interface QueueDelivery {
  body: QueuedDispute;
  eventId: string;
  retryCount: number;
}

export type ConsumeResult =
  | { kind: 'done'; outcome: ProcessOutcome }
  | { kind: 'retry'; afterSeconds: number; error: string }
  | { kind: 'dead-lettered'; error: string };

export function retryDelaySeconds(retryCount: number): number {
  return Math.min(900, 30 * 2 ** retryCount);
}

export async function consumeDispute(
  delivery: QueueDelivery,
  deps: ProcessDeps,
): Promise<ConsumeResult> {
  try {
    return { kind: 'done', outcome: await processDisputeEvent(delivery.body.event, deps) };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof PermanentError) && delivery.retryCount < MAX_RETRIES) {
      return { kind: 'retry', afterSeconds: retryDelaySeconds(delivery.retryCount), error };
    }
    const snapshot = delivery.body.event?.snapshot;
    await deps.store.deadLetter({
      id: delivery.eventId,
      failedAt: deps.now().toISOString(),
      attempts: delivery.retryCount + 1,
      error,
      disputeKey: snapshot ? disputeKey(snapshot.provider, snapshot.providerDisputeId) : null,
      message: delivery.body,
    });
    return { kind: 'dead-lettered', error };
  }
}
