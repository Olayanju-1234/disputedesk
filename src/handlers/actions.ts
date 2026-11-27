import { asUser, route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { kvsStore } from '../adapters/kvs-store';
import { log } from '../adapters/log';
import { doc, panel, paragraph, strong, text } from '../domain/adf';
import {
  cleanExcerpt,
  disputeText,
  openDisputesText,
  policyText,
  type PolicyHit,
} from '../domain/agent-text';
import { buildDashboard } from '../domain/dashboard';
import type { EvidenceState } from '../domain/evidence';
import { APP_LABEL, DISPUTE_PROPERTY_KEY, type DisputeProperty } from '../domain/issue-content';
import type { ResponseRecord } from '../domain/response';

/**
 * Rovo agent and MCP tools. Every Jira and Confluence read runs as the calling user, so the agent
 * only ever sees disputes and pages that person can already open.
 */

type Payload = Record<string, unknown> & { context?: { jira?: { issueKey?: string } } };

const ISSUE_KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

class ToolError extends Error {}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function issueKeyFrom(payload: Payload): string {
  const key = (str(payload.issueKey) || str(payload.context?.jira?.issueKey)).toUpperCase();
  if (!ISSUE_KEY.test(key)) {
    throw new ToolError('Tell me which dispute ticket you mean, for example DIS-6.');
  }
  return key;
}

async function userJson<T>(
  path: ReturnType<typeof route>,
  init?: { method?: string; body?: string },
): Promise<{ status: number; body: T | null }> {
  const res = await asUser().requestJira(path, {
    method: init?.method,
    body: init?.body,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  });
  const raw = await res.text();
  return { status: res.status, body: raw ? (JSON.parse(raw) as T) : null };
}

async function visibleDisputeKeys(): Promise<Set<string>> {
  const { status, body } = await userJson<{ issues?: Array<{ key: string }> }>(
    route`/rest/api/3/search/jql`,
    {
      method: 'POST',
      body: JSON.stringify({
        jql: `labels = "${APP_LABEL}" ORDER BY created DESC`,
        maxResults: 100,
        fields: ['key'],
      }),
    },
  );
  if (status !== 200) throw new Error(`Jira search failed (${status})`);
  return new Set((body?.issues ?? []).map((i) => i.key));
}

async function run(name: string, payload: Payload, fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof ToolError) return message;
    log.error('action.failed', {
      action: name,
      error: message,
      payloadKeys: Object.keys(payload ?? {}),
    });
    return `DisputeDesk could not complete that: ${message}`;
  }
}

export function listOpenDisputesAction(payload: Payload): Promise<string> {
  return run('list-open-disputes', payload, async () => {
    const [records, visible] = await Promise.all([kvsStore.listDisputes(), visibleDisputeKeys()]);
    const mine = records.filter((r) => r.issueKey && visible.has(r.issueKey));
    const evidence: Record<string, EvidenceState | undefined> = {};
    const responses: Record<string, ResponseRecord | undefined> = {};
    await Promise.all(
      mine.map(async (r) => {
        [evidence[r.key], responses[r.key]] = await Promise.all([
          kvs.get<EvidenceState>(`evidence:${r.key}`),
          kvs.get<ResponseRecord>(`response:${r.key}`),
        ]);
      }),
    );
    const now = new Date();
    return openDisputesText(buildDashboard(mine, evidence, responses, now).open, now);
  });
}

export function getDisputeAction(payload: Payload): Promise<string> {
  return run('get-dispute', payload, async () => {
    const issueKey = issueKeyFrom(payload);
    const { status, body } = await userJson<{ value?: DisputeProperty }>(
      route`/rest/api/3/issue/${issueKey}/properties/${DISPUTE_PROPERTY_KEY}`,
    );
    if (status !== 200 || !body?.value) {
      throw new ToolError(
        `${issueKey} is not a DisputeDesk dispute, or you don't have access to it.`,
      );
    }
    const key = body.value.disputeKey;
    const [record, evidence, response] = await Promise.all([
      kvsStore.getDispute(key),
      kvs.get<EvidenceState>(`evidence:${key}`),
      kvs.get<ResponseRecord>(`response:${key}`),
    ]);
    if (!record) throw new ToolError(`No DisputeDesk record found for ${issueKey}.`);
    return disputeText(record, evidence ?? {}, response, new Date());
  });
}

interface ConfluenceSearch {
  results?: Array<{ title?: string; excerpt?: string; url?: string; content?: { title?: string } }>;
  _links?: { base?: string };
}

export function findPolicyPagesAction(payload: Payload): Promise<string> {
  return run('find-policy-pages', payload, async () => {
    const query = str(payload.query).replace(/["\\]/g, ' ').slice(0, 100);
    if (!query)
      throw new ToolError('What should I search Confluence for, for example "refund policy"?');
    const cql = `type = page AND siteSearch ~ "${query}"`;
    const res = await asUser().requestConfluence(
      route`/wiki/rest/api/search?cql=${cql}&limit=5&excerpt=highlight`,
      { headers: { Accept: 'application/json' } },
    );
    if (res.status === 401 || res.status === 403 || res.status === 404) {
      throw new ToolError(
        'I could not search Confluence. DisputeDesk may not be installed in Confluence on this site, or you may not have access.',
      );
    }
    if (!res.ok) throw new Error(`Confluence search failed (${res.status})`);
    const body = (await res.json()) as ConfluenceSearch;
    const base = body._links?.base ?? '';
    const hits: PolicyHit[] = (body.results ?? []).map((r) => ({
      title: r.title ?? r.content?.title ?? 'Untitled page',
      url: `${base}${r.url ?? ''}`,
      excerpt: cleanExcerpt(r.excerpt ?? ''),
    }));
    return policyText(query, hits);
  });
}

export function saveEvidenceDraftAction(payload: Payload): Promise<string> {
  return run('save-evidence-draft', payload, async () => {
    const issueKey = issueKeyFrom(payload);
    const draft = str(payload.draft);
    if (!draft) throw new ToolError('There is no draft to save yet.');
    const property = await userJson<{ value?: DisputeProperty }>(
      route`/rest/api/3/issue/${issueKey}/properties/${DISPUTE_PROPERTY_KEY}`,
    );
    if (property.status !== 200) {
      throw new ToolError(
        `${issueKey} is not a DisputeDesk dispute, or you don't have access to it.`,
      );
    }
    const body = doc(
      panel(
        'info',
        paragraph(
          strong('Evidence draft from the Dispute analyst. '),
          text('Not sent to Paystack. Review it, then respond from the DisputeDesk panel.'),
        ),
      ),
      ...draft
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean)
        .slice(0, 30)
        .map((p) => paragraph(text(p.slice(0, 4000)))),
    );
    const { status } = await userJson(route`/rest/api/3/issue/${issueKey}/comment`, {
      method: 'POST',
      body: JSON.stringify({
        body,
        properties: [{ key: 'sd.public.comment', value: { internal: true } }],
      }),
    });
    if (status !== 201) throw new Error(`Jira refused the note (${status})`);
    return `Saved the draft as an internal note on ${issueKey}. Nothing was sent to Paystack.`;
  });
}
