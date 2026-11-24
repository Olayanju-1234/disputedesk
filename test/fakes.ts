import type { AdfDoc } from '../src/domain/adf';
import type { DisputeRecord } from '../src/domain/dispute';
import type { DisputeProperty } from '../src/domain/issue-content';
import type {
  AppConfig,
  DeadLetter,
  DisputeStore,
  IssueFieldUpdate,
  IssueRef,
  JiraGateway,
  NewIssue,
} from '../src/domain/ports';

export class MemoryStore implements DisputeStore {
  readonly disputes = new Map<string, DisputeRecord>();
  readonly processed = new Set<string>();
  readonly deadLetters: DeadLetter[] = [];

  getDispute(key: string) {
    const record = this.disputes.get(key);
    return Promise.resolve(record ? structuredClone(record) : undefined);
  }
  saveDispute(record: DisputeRecord) {
    this.disputes.set(record.key, structuredClone(record));
    return Promise.resolve();
  }
  isProcessed(dedupeKey: string) {
    return Promise.resolve(this.processed.has(dedupeKey));
  }
  markProcessed(dedupeKey: string) {
    this.processed.add(dedupeKey);
    return Promise.resolve();
  }
  listDisputes() {
    return Promise.resolve([...this.disputes.values()].map((r) => structuredClone(r)));
  }
  deadLetter(entry: DeadLetter) {
    this.deadLetters.push(entry);
    return Promise.resolve();
  }
}

export type JiraCall =
  | { op: 'create'; issue: NewIssue }
  | { op: 'comment'; issueKey: string; body: AdfDoc }
  | { op: 'update'; issueKey: string; update: IssueFieldUpdate }
  | { op: 'transition'; issueKey: string; targets: string[] };

export class FakeJira implements JiraGateway {
  readonly calls: JiraCall[] = [];
  readonly labelled = new Map<string, IssueRef>();
  readonly properties = new Map<string, DisputeProperty>();
  failNext: Partial<Record<JiraCall['op'], Error>> = {};
  private seq = 0;

  private maybeFail(op: JiraCall['op']) {
    const err = this.failNext[op];
    if (err) {
      delete this.failNext[op];
      throw err;
    }
  }

  findIssueByLabel(label: string) {
    return Promise.resolve(this.labelled.get(label) ?? null);
  }
  createIssue(issue: NewIssue) {
    this.maybeFail('create');
    this.seq++;
    const ref = { id: String(10000 + this.seq), key: `${issue.projectKey}-${this.seq}` };
    for (const label of issue.labels) this.labelled.set(label, ref);
    this.calls.push({ op: 'create', issue });
    return Promise.resolve(ref);
  }
  addComment(issueKey: string, body: AdfDoc) {
    this.maybeFail('comment');
    this.calls.push({ op: 'comment', issueKey, body });
    return Promise.resolve();
  }
  updateFields(issueKey: string, update: IssueFieldUpdate) {
    this.maybeFail('update');
    this.calls.push({ op: 'update', issueKey, update });
    return Promise.resolve();
  }
  setDisputeProperty(issueKey: string, value: DisputeProperty) {
    this.properties.set(issueKey, structuredClone(value));
    return Promise.resolve();
  }
  transition(issueKey: string, targets: string[]) {
    this.maybeFail('transition');
    this.calls.push({ op: 'transition', issueKey, targets });
    return Promise.resolve(targets[0] ?? null);
  }
  ops(): string[] {
    return this.calls.map((c) => c.op);
  }
}

export const configured: () => Promise<AppConfig> = () =>
  Promise.resolve({ projectKey: 'DIS', issueType: 'Task' });
