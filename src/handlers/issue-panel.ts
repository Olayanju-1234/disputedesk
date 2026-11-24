import { kvs } from '@forge/kvs';
import Resolver from '@forge/resolver';
import { forgeHttp } from '../adapters/http';
import {
  downloadAttachmentContent,
  forgeJira,
  listAttachments,
  readDisputeProperty,
  type IssueAttachment,
} from '../adapters/jira';
import { kvsStore } from '../adapters/kvs-store';
import { log } from '../adapters/log';
import { createPaystackClient, type EvidenceInput } from '../adapters/paystack';
import { getPaystackSecrets } from '../adapters/settings';
import { doc, panel as adfPanel, paragraph, strong, text } from '../domain/adf';
import { appendTimeline, type DisputeRecord } from '../domain/dispute';
import {
  classifyReason,
  evidenceChecklist,
  toggleEvidence,
  type EvidenceState,
} from '../domain/evidence';
import { disputeProperty } from '../domain/issue-content';
import { buildPanel, type DisputePanel } from '../domain/panel';
import {
  describeResponse,
  EVIDENCE_FILE_TYPES,
  ResponseValidationError,
  submitResponse,
  type ResponseAction,
  type ResponseRecord,
} from '../domain/response';

const evidenceKey = (disputeKey: string) => `evidence:${disputeKey}`;
const responseKey = (disputeKey: string) => `response:${disputeKey}`;

interface PanelContext {
  accountId?: string;
  extension?: { issue?: { key?: string } };
}

export interface PanelData extends DisputePanel {
  attachments: IssueAttachment[];
}

type PanelResult = { ok: true; data: PanelData | null } | { ok: false; error: string };

class PanelError extends Error {}

interface Loaded {
  issueKey: string;
  record: DisputeRecord;
  evidence: EvidenceState;
  response: ResponseRecord | undefined;
}

async function load(issueKey: string): Promise<Loaded | null> {
  const marker = await readDisputeProperty(issueKey);
  if (!marker) return null;
  const [record, evidence, response] = await Promise.all([
    kvsStore.getDispute(marker.disputeKey),
    kvs.get<EvidenceState>(evidenceKey(marker.disputeKey)),
    kvs.get<ResponseRecord>(responseKey(marker.disputeKey)),
  ]);
  return record ? { issueKey, record, evidence: evidence ?? {}, response } : null;
}

async function toPanelData(loaded: Loaded): Promise<PanelData> {
  const panel = buildPanel(loaded.record, loaded.evidence, loaded.response);
  const attachments = panel.canRespond
    ? (await listAttachments(loaded.issueKey)).filter((a) => EVIDENCE_FILE_TYPES[a.mimeType])
    : [];
  return { ...panel, attachments };
}

async function require(issueKey: string): Promise<Loaded> {
  const loaded = await load(issueKey);
  if (!loaded) throw new PanelError('This issue is not a DisputeDesk dispute.');
  return loaded;
}

function issueKeyFrom(context: unknown): string {
  const key = (context as PanelContext).extension?.issue?.key;
  if (!key) throw new PanelError('This panel only works on an issue.');
  return key;
}

async function run(fn: () => Promise<PanelData | null>): Promise<PanelResult> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    if (!(err instanceof PanelError || err instanceof ResponseValidationError)) {
      log.error('panel.resolver_failed', { error });
    }
    return { ok: false, error };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function evidenceFrom(value: unknown): EvidenceInput | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const v = value as Record<string, unknown>;
  return {
    customerEmail: str(v.customerEmail),
    customerName: str(v.customerName),
    customerPhone: str(v.customerPhone),
    serviceDetails: str(v.serviceDetails),
    deliveryAddress: str(v.deliveryAddress) || undefined,
    deliveryDate: str(v.deliveryDate) || undefined,
  };
}

const resolver = new Resolver();

resolver.define('getDisputePanel', ({ context }) =>
  run(async () => {
    const loaded = await load(issueKeyFrom(context));
    return loaded ? toPanelData(loaded) : null;
  }),
);

resolver.define('setEvidence', ({ payload, context }) =>
  run(async () => {
    const loaded = await require(issueKeyFrom(context));
    const input = (payload ?? {}) as { itemId?: unknown; done?: unknown };
    const items = evidenceChecklist(classifyReason(loaded.record.snapshot));
    const accountId = (context as PanelContext).accountId ?? null;
    const next = toggleEvidence(
      items,
      loaded.evidence,
      str(input.itemId),
      input.done === true,
      accountId,
      new Date().toISOString(),
    );
    await kvs.set(evidenceKey(loaded.record.key), next);
    return toPanelData({ ...loaded, evidence: next });
  }),
);

resolver.define('submitResponse', ({ payload, context }) =>
  run(async () => {
    const loaded = await require(issueKeyFrom(context));
    const input = (payload ?? {}) as Record<string, unknown>;
    const action: ResponseAction = input.action === 'accept' ? 'accept' : 'contest';
    const attachmentId = str(input.attachmentId) || undefined;

    // The attachment id comes from the browser; only files on this issue may be sent to Paystack.
    const attachmentMeta = attachmentId
      ? (await listAttachments(loaded.issueKey)).find((a) => a.id === attachmentId)
      : undefined;
    if (attachmentId && !attachmentMeta) {
      throw new PanelError('That file is not attached to this ticket.');
    }

    const secrets = await getPaystackSecrets();
    const result = await submitResponse(
      loaded.record.snapshot,
      { action, message: str(input.message), attachmentId, evidence: evidenceFrom(input.evidence) },
      loaded.response,
      (context as PanelContext).accountId ?? null,
      {
        paystack: secrets.secretKey ? createPaystackClient(secrets.secretKey, forgeHttp) : null,
        downloadAttachment: async (id) => ({
          bytes: await downloadAttachmentContent(id),
          filename: attachmentMeta?.filename ?? 'evidence',
          mimeType: attachmentMeta?.mimeType ?? 'application/octet-stream',
        }),
        now: () => new Date(),
      },
    );

    await kvs.set(responseKey(loaded.record.key), result);
    const record: DisputeRecord = {
      ...loaded.record,
      timeline: appendTimeline(loaded.record.timeline, {
        at: result.at,
        kind: 'response',
        status: result.status,
        note: result.action === 'contest' ? 'contest' : 'accept',
      }),
      updatedAt: result.at,
    };
    await kvsStore.saveDispute(record);
    const tone =
      result.status === 'confirmed' || result.status === 'simulated' ? 'success' : 'warning';
    await forgeJira.addComment(
      loaded.issueKey,
      doc(
        adfPanel(
          tone,
          paragraph(strong(describeResponse(result)), text(` Message: ${result.message}`)),
        ),
      ),
    );
    await forgeJira.setDisputeProperty(loaded.issueKey, disputeProperty(record));
    log.info('panel.response_submitted', {
      disputeKey: record.key,
      action: result.action,
      status: result.status,
      attempts: result.attempts,
    });
    return toPanelData({ ...loaded, record, response: result });
  }),
);

export const issuePanelResolver = resolver.getDefinitions();
