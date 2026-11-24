import { kvsStore } from '../adapters/kvs-store';
import { enqueueDispute } from '../adapters/queue';

export class MissingDeadLetterError extends Error {}

/** Puts a failed event back on the queue; dedupe in the consumer makes a double replay harmless. */
export async function replayDeadLetter(id: string): Promise<{ replayed: string }> {
  const entry = await kvsStore.getDeadLetter(id);
  if (!entry) throw new MissingDeadLetterError('That dead letter no longer exists.');
  await enqueueDispute({
    ...entry.message,
    source: 'replay',
    receivedAt: new Date().toISOString(),
  });
  await kvsStore.deleteDeadLetter(id);
  return { replayed: id };
}
