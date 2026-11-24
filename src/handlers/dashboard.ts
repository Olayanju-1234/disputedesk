import { kvs } from '@forge/kvs';
import Resolver from '@forge/resolver';
import { kvsStore } from '../adapters/kvs-store';
import { log } from '../adapters/log';
import { buildDashboard, type Dashboard } from '../domain/dashboard';
import { outcomeOf } from '../domain/dispute';
import type { EvidenceState } from '../domain/evidence';
import type { DeadLetter } from '../domain/ports';
import type { ResponseRecord } from '../domain/response';
import { MissingDeadLetterError, replayDeadLetter } from './dead-letters';

export interface DashboardData extends Dashboard {
  deadLetters: Array<Pick<DeadLetter, 'id' | 'failedAt' | 'attempts' | 'error' | 'disputeKey'>>;
}

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

async function loadDashboard(): Promise<DashboardData> {
  const [records, deadLetters] = await Promise.all([
    kvsStore.listDisputes(),
    kvsStore.listDeadLetters(),
  ]);
  const open = records.filter((r) => outcomeOf(r.snapshot) === 'open');
  const evidence: Record<string, EvidenceState | undefined> = {};
  const responses: Record<string, ResponseRecord | undefined> = {};
  await Promise.all(
    open.map(async (r) => {
      [evidence[r.key], responses[r.key]] = await Promise.all([
        kvs.get<EvidenceState>(`evidence:${r.key}`),
        kvs.get<ResponseRecord>(`response:${r.key}`),
      ]);
    }),
  );
  return {
    ...buildDashboard(records, evidence, responses, new Date()),
    deadLetters: deadLetters
      .sort((a, b) => b.failedAt.localeCompare(a.failedAt))
      .map(({ id, failedAt, attempts, error, disputeKey }) => ({
        id,
        failedAt,
        attempts,
        error,
        disputeKey,
      })),
  };
}

async function run<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof MissingDeadLetterError)) log.error('dashboard.resolver_failed', { error });
    return { ok: false, error };
  }
}

const resolver = new Resolver();

resolver.define('getDashboard', () => run(loadDashboard));

resolver.define('replayDeadLetter', ({ payload }) =>
  run(async () => {
    const id =
      typeof (payload as { id?: unknown }).id === 'string' ? (payload as { id: string }).id : '';
    await replayDeadLetter(id);
    return loadDashboard();
  }),
);

export const dashboardResolver = resolver.getDefinitions();
