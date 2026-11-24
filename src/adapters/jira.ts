import { asApp, route } from '@forge/api';
import type { AdfDoc } from '../domain/adf';
import { DISPUTE_PROPERTY_KEY, type DisputeProperty } from '../domain/issue-content';
import { pickPriority, pickTransition, type TransitionOption } from '../domain/jira-choices';
import {
  PermanentError,
  type IssueFieldUpdate,
  type IssueRef,
  type JiraGateway,
  type NewIssue,
} from '../domain/ports';
import { log } from './log';

type Route = ReturnType<typeof route>;
type Method = 'GET' | 'POST' | 'PUT';

const RETRYABLE_4XX = new Set([408, 409, 429]);

export class JiraRequestError extends Error {
  readonly status: number;

  constructor(status: number, body: string) {
    super(`Jira responded ${status}: ${body.slice(0, 300)}`);
    this.status = status;
  }
}

class PermanentJiraError extends PermanentError {}

function failure(status: number, body: string): Error {
  const err = new JiraRequestError(status, body);
  // 4xx means bad config or a bad request; retrying the same call won't change the answer.
  return status >= 400 && status < 500 && !RETRYABLE_4XX.has(status)
    ? new PermanentJiraError(err.message)
    : err;
}

async function jira<T>(method: Method, path: Route, body?: unknown): Promise<T> {
  const res = await asApp().requestJira(path, {
    method,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw failure(res.status, await res.text());
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

interface SearchResponse {
  issues?: Array<{ id: string; key: string }>;
}

interface TransitionsResponse {
  transitions: TransitionOption[];
}

interface EditMetaResponse {
  fields?: { priority?: { allowedValues?: Array<{ name: string }> } };
}

// JSM shows API comments to the customer unless they are marked internal.
const INTERNAL_COMMENT = [{ key: 'sd.public.comment', value: { internal: true } }];

function createFields(issue: NewIssue, withDueDate: boolean) {
  return {
    project: { key: issue.projectKey },
    issuetype: { name: issue.issueType },
    summary: issue.summary,
    description: issue.description,
    labels: issue.labels,
    ...(withDueDate && issue.dueDate ? { duedate: issue.dueDate } : {}),
  };
}

/** Priorities this issue's edit screen allows; empty when priority isn't editable there. */
async function editablePriorities(issueKey: string): Promise<string[]> {
  const meta = await jira<EditMetaResponse>('GET', route`/rest/api/3/issue/${issueKey}/editmeta`);
  return (meta.fields?.priority?.allowedValues ?? []).map((p) => p.name);
}

export const forgeJira: JiraGateway = {
  async findIssueByLabel(label) {
    const res = await jira<SearchResponse>('POST', route`/rest/api/3/search/jql`, {
      jql: `labels = "${label}" ORDER BY created ASC`,
      maxResults: 1,
      fields: ['key'],
    });
    const hit = res.issues?.[0];
    return hit ? { id: hit.id, key: hit.key } : null;
  },

  async createIssue(issue) {
    try {
      return await jira<IssueRef>('POST', route`/rest/api/3/issue`, {
        fields: createFields(issue, true),
      });
    } catch (err) {
      // JSM request types often leave Due date off the create screen; the deadline still lives in the description.
      if (!(err instanceof PermanentError) || !err.message.includes('duedate') || !issue.dueDate)
        throw err;
      log.warn('jira.create.duedate_rejected', { projectKey: issue.projectKey });
      return jira<IssueRef>('POST', route`/rest/api/3/issue`, {
        fields: createFields(issue, false),
      });
    }
  },

  async addComment(issueKey: string, body: AdfDoc) {
    await jira('POST', route`/rest/api/3/issue/${issueKey}/comment`, {
      body,
      properties: INTERNAL_COMMENT,
    });
  },

  async updateFields(issueKey: string, update: IssueFieldUpdate) {
    const fields: Record<string, unknown> = {};
    if (update.dueDate !== undefined) fields.duedate = update.dueDate;
    if (update.priority) {
      const name = pickPriority(await editablePriorities(issueKey), update.priority);
      if (!name) throw new Error('Priority is not editable on this issue');
      fields.priority = { name };
    }
    const body: Record<string, unknown> = { fields };
    if (update.addLabels?.length)
      body.update = { labels: update.addLabels.map((add) => ({ add })) };
    try {
      await jira('PUT', route`/rest/api/3/issue/${issueKey}`, body);
    } catch (err) {
      log.warn('jira.update_failed', {
        issueKey,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },

  async setDisputeProperty(issueKey: string, value: DisputeProperty) {
    await jira(
      'PUT',
      route`/rest/api/3/issue/${issueKey}/properties/${DISPUTE_PROPERTY_KEY}`,
      value,
    );
  },

  async transition(issueKey: string, targetNames: string[]) {
    const { transitions } = await jira<TransitionsResponse>(
      'GET',
      route`/rest/api/3/issue/${issueKey}/transitions`,
    );
    const match = pickTransition(transitions, targetNames);
    if (match) {
      await jira('POST', route`/rest/api/3/issue/${issueKey}/transitions`, {
        transition: { id: match.id },
      });
      return match.name;
    }
    log.warn('jira.transition.none_matched', {
      issueKey,
      wanted: targetNames,
      available: transitions.map((t) => t.name),
    });
    return null;
  },
};

/** The dispute marker on an issue, or null when the issue isn't a DisputeDesk ticket. */
export async function readDisputeProperty(issueKey: string): Promise<DisputeProperty | null> {
  try {
    const res = await jira<{ value?: DisputeProperty }>(
      'GET',
      route`/rest/api/3/issue/${issueKey}/properties/${DISPUTE_PROPERTY_KEY}`,
    );
    return res?.value ?? null;
  } catch (err) {
    if (err instanceof Error && err.message.includes('404')) return null;
    throw err;
  }
}
