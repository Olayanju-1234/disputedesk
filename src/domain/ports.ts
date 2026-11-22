import type { AdfDoc } from './adf';
import type { JiraPriority } from './deadline';
import type { DisputeEvent, DisputeRecord } from './dispute';
import type { SignatureScheme } from './signature';

export interface AppConfig {
  projectKey: string | null;
  issueType: string;
}

export const DEFAULT_CONFIG: AppConfig = { projectKey: null, issueType: 'Task' };

export type EventSource = 'webhook' | 'simulator' | 'replay';

/** What the webhook puts on the queue. Versioned so old messages survive a deploy. */
export interface QueuedDispute {
  version: 1;
  event: DisputeEvent;
  receivedAt: string;
  scheme: SignatureScheme | 'replay';
  source: EventSource;
}

export interface DeadLetter {
  id: string;
  failedAt: string;
  attempts: number;
  error: string;
  disputeKey: string | null;
  message: QueuedDispute;
}

export interface DisputeStore {
  getDispute(key: string): Promise<DisputeRecord | undefined>;
  saveDispute(record: DisputeRecord): Promise<void>;
  isProcessed(dedupeKey: string): Promise<boolean>;
  markProcessed(dedupeKey: string): Promise<void>;
  listDisputes(): Promise<DisputeRecord[]>;
  deadLetter(entry: DeadLetter): Promise<void>;
}

export interface IssueRef {
  id: string;
  key: string;
}

export interface NewIssue {
  projectKey: string;
  issueType: string;
  summary: string;
  description: AdfDoc;
  labels: string[];
  dueDate: string | null;
}

export interface IssueFieldUpdate {
  dueDate?: string | null;
  addLabels?: string[];
  /** Urgency level; the Jira adapter maps it onto the site's own priority names. */
  priority?: JiraPriority;
}

export interface JiraGateway {
  findIssueByLabel(label: string): Promise<IssueRef | null>;
  createIssue(issue: NewIssue): Promise<IssueRef>;
  addComment(issueKey: string, body: AdfDoc): Promise<void>;
  updateFields(issueKey: string, update: IssueFieldUpdate): Promise<void>;
  /** Moves the issue through the first available transition whose name or target matches. */
  transition(issueKey: string, targetNames: string[]): Promise<string | null>;
}

/** Errors that retrying won't fix, so the event goes straight to the dead-letter list. */
export class PermanentError extends Error {
  override readonly name = 'PermanentError';
}
