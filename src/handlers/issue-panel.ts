import { kvs } from '@forge/kvs';
import Resolver from '@forge/resolver';
import { readDisputeProperty } from '../adapters/jira';
import { kvsStore } from '../adapters/kvs-store';
import { log } from '../adapters/log';
import {
  classifyReason,
  evidenceChecklist,
  toggleEvidence,
  type EvidenceState,
} from '../domain/evidence';
import { buildPanel, type DisputePanel } from '../domain/panel';

const evidenceKey = (disputeKey: string) => `evidence:${disputeKey}`;

interface PanelContext {
  accountId?: string;
  extension?: { issue?: { key?: string } };
}

type PanelResult = { ok: true; data: DisputePanel | null } | { ok: false; error: string };

class PanelError extends Error {}

async function loadPanel(issueKey: string): Promise<DisputePanel | null> {
  const marker = await readDisputeProperty(issueKey);
  if (!marker) return null;
  const [record, state] = await Promise.all([
    kvsStore.getDispute(marker.disputeKey),
    kvs.get<EvidenceState>(evidenceKey(marker.disputeKey)),
  ]);
  return record ? buildPanel(record, state ?? {}) : null;
}

function issueKeyFrom(context: unknown): string {
  const key = (context as PanelContext).extension?.issue?.key;
  if (!key) throw new PanelError('This panel only works on an issue.');
  return key;
}

async function run(fn: () => Promise<DisputePanel | null>): Promise<PanelResult> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof PanelError)) log.error('panel.resolver_failed', { error });
    return { ok: false, error };
  }
}

const resolver = new Resolver();

resolver.define('getDisputePanel', ({ context }) => run(() => loadPanel(issueKeyFrom(context))));

resolver.define('setEvidence', ({ payload, context }) =>
  run(async () => {
    const issueKey = issueKeyFrom(context);
    const input = (payload ?? {}) as { itemId?: unknown; done?: unknown };
    const itemId = typeof input.itemId === 'string' ? input.itemId : '';
    const done = input.done === true;
    const marker = await readDisputeProperty(issueKey);
    if (!marker) throw new PanelError('This issue is not a DisputeDesk dispute.');
    const record = await kvsStore.getDispute(marker.disputeKey);
    if (!record) throw new PanelError('No dispute record found for this issue.');
    const items = evidenceChecklist(classifyReason(record.snapshot));
    const current = (await kvs.get<EvidenceState>(evidenceKey(record.key))) ?? {};
    const accountId = (context as PanelContext).accountId ?? null;
    const next = toggleEvidence(items, current, itemId, done, accountId, new Date().toISOString());
    await kvs.set(evidenceKey(record.key), next);
    return buildPanel(record, next);
  }),
);

export const issuePanelResolver = resolver.getDefinitions();
