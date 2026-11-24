import { nextAlert } from './deadline';
import {
  appendTimeline,
  decide,
  disputeKey,
  outcomeOf,
  type DisputeEvent,
  type DisputeRecord,
} from './dispute';
import {
  APP_LABEL,
  deadlineAlertComment,
  disputeLabel,
  disputeProperty,
  dueDateChangeComment,
  issueDescription,
  issueSummary,
  jiraDueDate,
  outcomeComment,
  outcomeLabel,
  statusChangeComment,
} from './issue-content';
import {
  PermanentError,
  type AppConfig,
  type DisputeStore,
  type IssueRef,
  type JiraGateway,
} from './ports';

export interface ProcessDeps {
  store: DisputeStore;
  jira: JiraGateway;
  config: () => Promise<AppConfig>;
  now: () => Date;
}

export type ProcessOutcome = 'duplicate' | 'stale' | 'created' | 'updated';

export const WON_TRANSITIONS = ['Won', 'Resolved', 'Done', 'Closed'];
export const LOST_TRANSITIONS = ['Lost', 'Resolved', 'Done', 'Closed'];

async function ensureIssue(event: DisputeEvent, deps: ProcessDeps): Promise<IssueRef> {
  const label = disputeLabel(event.snapshot);
  // A retry after a crash between "issue created" and "record saved" must find that issue, not make a second one.
  const existing = await deps.jira.findIssueByLabel(label);
  if (existing) return existing;
  const config = await deps.config();
  if (!config.projectKey) {
    throw new PermanentError('No Jira project configured. Set one on the DisputeDesk admin page.');
  }
  return deps.jira.createIssue({
    projectKey: config.projectKey,
    issueType: config.issueType,
    summary: issueSummary(event.snapshot),
    description: issueDescription(event.snapshot),
    labels: [APP_LABEL, label],
    dueDate: jiraDueDate(event.snapshot.dueAt),
  });
}

async function applyOutcome(
  issueKey: string,
  record: DisputeRecord,
  deps: ProcessDeps,
): Promise<void> {
  const outcome = outcomeOf(record.snapshot);
  if (outcome === 'open') return;
  await deps.jira.addComment(issueKey, outcomeComment(record.snapshot));
  const label = outcomeLabel(record.snapshot);
  if (label) await deps.jira.updateFields(issueKey, { addLabels: [label] });
  await deps.jira.transition(issueKey, outcome === 'won' ? WON_TRANSITIONS : LOST_TRANSITIONS);
}

export async function processDisputeEvent(
  event: DisputeEvent,
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  if (await deps.store.isProcessed(event.dedupeKey)) return 'duplicate';

  const key = disputeKey(event.snapshot.provider, event.snapshot.providerDisputeId);
  const existing = await deps.store.getDispute(key);
  const decision = decide(existing, event);
  const nowIso = deps.now().toISOString();

  if (decision.action === 'ignore' && existing) {
    await deps.store.saveDispute({
      ...existing,
      timeline: appendTimeline(existing.timeline, {
        at: nowIso,
        kind: 'stale-ignored',
        status: event.snapshot.status,
        note: `${event.providerEvent} from ${event.snapshot.updatedAt} is older than the stored state`,
      }),
      updatedAt: nowIso,
    });
    await deps.store.markProcessed(event.dedupeKey);
    return 'stale';
  }

  if (decision.action === 'create' || !existing?.issueKey) {
    const issue = await ensureIssue(event, deps);
    const base: DisputeRecord = existing ?? {
      key,
      issueKey: null,
      issueId: null,
      snapshot: event.snapshot,
      timeline: [],
      alertsSent: [],
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    let timeline = appendTimeline(base.timeline, {
      at: nowIso,
      kind: event.kind,
      status: event.snapshot.status,
    });
    timeline = appendTimeline(timeline, {
      at: nowIso,
      kind: 'ticket-created',
      status: event.snapshot.status,
      note: issue.key,
    });
    const record: DisputeRecord = {
      ...base,
      issueKey: issue.key,
      issueId: issue.id,
      snapshot: event.snapshot,
      timeline,
      updatedAt: nowIso,
    };
    await deps.store.saveDispute(record);
    await deps.jira.setDisputeProperty(issue.key, disputeProperty(record));
    await applyOutcome(issue.key, record, deps);
    await deps.store.markProcessed(event.dedupeKey);
    return 'created';
  }

  const issueKey = existing.issueKey;
  const record: DisputeRecord = {
    ...existing,
    snapshot: event.snapshot,
    timeline: appendTimeline(existing.timeline, {
      at: nowIso,
      kind: event.kind,
      status: event.snapshot.status,
    }),
    updatedAt: nowIso,
  };
  // Save before side effects: a retry then sees no change and skips the comments instead of repeating them.
  await deps.store.saveDispute(record);
  await deps.jira.setDisputeProperty(issueKey, disputeProperty(record));

  if (decision.action === 'update') {
    if (decision.statusChanged && !decision.outcomeChanged) {
      await deps.jira.addComment(issueKey, statusChangeComment(existing.snapshot, event.snapshot));
    }
    if (decision.dueAtChanged && outcomeOf(event.snapshot) === 'open') {
      await deps.jira.updateFields(issueKey, { dueDate: jiraDueDate(event.snapshot.dueAt) });
      await deps.jira.addComment(issueKey, dueDateChangeComment(event.snapshot));
    }
    if (decision.outcomeChanged) await applyOutcome(issueKey, record, deps);
  }
  await deps.store.markProcessed(event.dedupeKey);
  return 'updated';
}

export interface SweepResult {
  checked: number;
  alerted: string[];
  failed: string[];
  priorityNotSet: string[];
}

export async function sweepDeadlines(deps: Omit<ProcessDeps, 'config'>): Promise<SweepResult> {
  const now = deps.now();
  const result: SweepResult = { checked: 0, alerted: [], failed: [], priorityNotSet: [] };
  const open = (await deps.store.listDisputes()).filter(
    (r) => r.issueKey && outcomeOf(r.snapshot) === 'open',
  );
  for (const record of open) {
    result.checked++;
    const alert = nextAlert(record.snapshot.dueAt, record.alertsSent, now);
    if (!alert || !record.issueKey || !record.snapshot.dueAt) continue;
    try {
      // Mark first so a failing Jira call can't make every 5-minute sweep comment again.
      await deps.store.saveDispute({
        ...record,
        alertsSent: [...new Set([...record.alertsSent, ...alert.covers])],
        timeline: appendTimeline(record.timeline, {
          at: now.toISOString(),
          kind: 'deadline-alert',
          status: record.snapshot.status,
          note: `${alert.thresholdHours}h threshold`,
        }),
        updatedAt: now.toISOString(),
      });
      await deps.jira.addComment(
        record.issueKey,
        deadlineAlertComment(alert, record.snapshot.dueAt),
      );
      result.alerted.push(record.issueKey);
    } catch {
      result.failed.push(record.issueKey);
      continue;
    }
    if (alert.thresholdHours > 0) {
      // Some JSM projects keep priority off the edit screen; the comment alone still warns the agent.
      try {
        await deps.jira.updateFields(record.issueKey, { priority: alert.priority });
      } catch {
        result.priorityNotSet.push(record.issueKey);
      }
    }
  }
  return result;
}
