import { kvs, WhereConditions } from '@forge/kvs';
import type { DisputeRecord } from '../domain/dispute';
import type { DeadLetter, DisputeStore } from '../domain/ports';

const DISPUTE_PREFIX = 'dispute:';
const PROCESSED_PREFIX = 'evt:';
const DEAD_LETTER_PREFIX = 'dlq:';
const PROCESSED_TTL = { value: 30, unit: 'DAYS' } as const;

async function listByPrefix<T>(prefix: string): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  do {
    let query = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
    if (cursor) query = query.cursor(cursor);
    const page = await query.getMany<T>();
    items.push(...page.results.map((r) => r.value));
    cursor = page.nextCursor;
  } while (cursor);
  return items;
}

export const kvsStore: DisputeStore & {
  listDeadLetters(): Promise<DeadLetter[]>;
  getDeadLetter(id: string): Promise<DeadLetter | undefined>;
  deleteDeadLetter(id: string): Promise<void>;
} = {
  getDispute: (key) => kvs.get<DisputeRecord>(`${DISPUTE_PREFIX}${key}`),
  saveDispute: (record) => kvs.set(`${DISPUTE_PREFIX}${record.key}`, record),
  isProcessed: async (dedupeKey) =>
    (await kvs.get(`${PROCESSED_PREFIX}${dedupeKey}`)) !== undefined,
  markProcessed: (dedupeKey) =>
    kvs.set(`${PROCESSED_PREFIX}${dedupeKey}`, new Date().toISOString(), { ttl: PROCESSED_TTL }),
  listDisputes: () => listByPrefix<DisputeRecord>(DISPUTE_PREFIX),
  deadLetter: (entry) => kvs.set(`${DEAD_LETTER_PREFIX}${entry.id}`, entry),
  listDeadLetters: () => listByPrefix<DeadLetter>(DEAD_LETTER_PREFIX),
  getDeadLetter: (id) => kvs.get<DeadLetter>(`${DEAD_LETTER_PREFIX}${id}`),
  deleteDeadLetter: (id) => kvs.delete(`${DEAD_LETTER_PREFIX}${id}`),
};
