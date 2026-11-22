import { asApp, fetch, route, webTrigger } from '@forge/api';
import { kvs } from '@forge/kvs';
import Resolver from '@forge/resolver';
import { kvsStore } from '../adapters/kvs-store';
import { log } from '../adapters/log';
import { enqueueDispute } from '../adapters/queue';
import {
  getConfig,
  getPaystackSecrets,
  maskSecret,
  saveConfig,
  savePaystackSecrets,
} from '../adapters/settings';
import { outcomeOf } from '../domain/dispute';
import { signPaystackBody } from '../domain/signature';
import {
  buildPaystackDisputeEvent,
  newSimDispute,
  type SimDispute,
  type SimScenario,
} from '../domain/simulator';

export const WEBHOOK_MODULE_KEY = 'paystack-webhook';
const LAST_SIM_KEY = 'sim:last';
const SCENARIOS: SimScenario[] = [
  'create',
  'remind',
  'resolve-won',
  'resolve-lost',
  'resolve-timeout',
];

export interface SettingsInput {
  projectKey?: string;
  issueType?: string;
  secretKey?: string;
  signingSecret?: string;
}

export interface TestDisputeInput {
  scenario?: SimScenario;
  hoursUntilDue?: number;
}

class UserError extends Error {}

function stringField(payload: Record<string, unknown>, name: string): string {
  const value = payload[name];
  return typeof value === 'string' ? value : '';
}

function asRecord(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

async function settings() {
  const [config, secrets, webhookUrl] = await Promise.all([
    getConfig(),
    getPaystackSecrets(),
    webTrigger.getUrl(WEBHOOK_MODULE_KEY),
  ]);
  return {
    config,
    webhookUrl,
    secretKey: maskSecret(secrets.secretKey),
    signingSecret: maskSecret(secrets.signingSecrets[0]),
    ready: Boolean(config.projectKey && (secrets.secretKey || secrets.signingSecrets.length)),
  };
}

async function saveSettings(input: SettingsInput) {
  const config = await getConfig();
  const projectKey = input.projectKey?.trim();
  const issueType = input.issueType?.trim();
  await saveConfig({
    projectKey: projectKey || config.projectKey,
    issueType: issueType || config.issueType,
  });

  const secretKey = input.secretKey?.trim();
  const signingSecret = input.signingSecret?.trim();
  if (secretKey && !/^sk_(test|live)_\S{4,}$/.test(secretKey)) {
    throw new UserError('The secret key should start with sk_test_ or sk_live_.');
  }
  if (signingSecret && !/^whsec_\S{4,}$/.test(signingSecret)) {
    throw new UserError('The webhook signing secret should start with whsec_.');
  }
  if (secretKey || signingSecret) {
    const current = await getPaystackSecrets();
    await savePaystackSecrets({
      secretKey: secretKey || current.secretKey,
      signingSecrets: signingSecret ? [signingSecret] : current.signingSecrets,
    });
  }
  return settings();
}

async function listProjects() {
  const res = await asApp().requestJira(
    route`/rest/api/3/project/search?maxResults=50&orderBy=name`,
  );
  if (!res.ok) throw new Error(`Could not list projects (${res.status})`);
  const body = (await res.json()) as {
    values?: Array<{ key: string; name: string; projectTypeKey?: string }>;
  };
  return (body.values ?? []).map((p) => ({
    key: p.key,
    name: p.name,
    type: p.projectTypeKey ?? 'unknown',
  }));
}

async function listIssueTypes(projectKey: string) {
  const res = await asApp().requestJira(
    route`/rest/api/3/issue/createmeta/${projectKey}/issuetypes`,
  );
  if (!res.ok) throw new Error(`Could not list issue types for ${projectKey} (${res.status})`);
  const body = (await res.json()) as {
    issueTypes?: Array<{ name: string }>;
    values?: Array<{ name: string }>;
  };
  return (body.issueTypes ?? body.values ?? []).map((t) => t.name);
}

async function sendTestDispute(input: TestDisputeInput) {
  const scenario = input.scenario ?? 'create';
  if (!SCENARIOS.includes(scenario)) throw new UserError(`Unknown scenario ${String(scenario)}`);
  const secrets = await getPaystackSecrets();
  if (!secrets.secretKey && secrets.signingSecrets.length === 0) {
    throw new UserError(
      'Save a Paystack secret key or webhook signing secret first. The simulator signs with it.',
    );
  }

  const now = new Date();
  let dispute: SimDispute | undefined;
  if (scenario === 'create') {
    const hours = Number.isFinite(input.hoursUntilDue) ? Number(input.hoursUntilDue) : 16;
    dispute = newSimDispute(now, Math.min(Math.max(hours, -2), 72), now.getTime() % 1_000_000_000);
    await kvs.set(LAST_SIM_KEY, dispute);
  } else {
    dispute = await kvs.get<SimDispute>(LAST_SIM_KEY);
    if (!dispute) throw new UserError('Send a new dispute first, then remind or resolve it.');
  }

  const body = buildPaystackDisputeEvent(dispute, scenario, now);
  const headers = signPaystackBody(body, {
    signingSecret: secrets.signingSecrets[0],
    secretKey: secrets.secretKey,
    keyId: 'whk_disputedesk_simulator',
  });
  const url = await webTrigger.getUrl(WEBHOOK_MODULE_KEY);
  const res = await fetch(url, { method: 'POST', headers, body });
  const responseBody = await res.text();
  log.info('simulator.sent', { scenario, disputeId: dispute.id, status: res.status });
  return {
    scenario,
    disputeId: dispute.id,
    reference: dispute.reference,
    status: res.status,
    response: responseBody,
  };
}

async function recentDisputes() {
  const records = await kvsStore.listDisputes();
  return records
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 25)
    .map((r) => ({
      key: r.key,
      issueKey: r.issueKey,
      status: r.snapshot.status,
      outcome: outcomeOf(r.snapshot),
      amountMinor: r.snapshot.amountMinor,
      currency: r.snapshot.currency,
      dueAt: r.snapshot.dueAt,
      lastEvent: r.timeline.at(-1)?.kind ?? null,
      updatedAt: r.updatedAt,
    }));
}

async function replayDeadLetter(id: string) {
  const entry = await kvsStore.getDeadLetter(id);
  if (!entry) throw new UserError('That dead letter no longer exists.');
  await enqueueDispute({
    ...entry.message,
    source: 'replay',
    receivedAt: new Date().toISOString(),
  });
  await kvsStore.deleteDeadLetter(id);
  return { replayed: id };
}

function guarded<T>(fn: (payload: Record<string, unknown>) => Promise<T>) {
  return async ({ payload }: { payload: unknown }) => {
    try {
      return { ok: true as const, data: await fn(asRecord(payload)) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!(err instanceof UserError)) log.error('admin.resolver_failed', { error: message });
      return { ok: false as const, error: message };
    }
  };
}

const resolver = new Resolver();
resolver.define(
  'getSettings',
  guarded(() => settings()),
);
resolver.define(
  'saveSettings',
  guarded((p) => saveSettings(p as SettingsInput)),
);
resolver.define(
  'listProjects',
  guarded(() => listProjects()),
);
resolver.define(
  'listIssueTypes',
  guarded((p) => listIssueTypes(stringField(p, 'projectKey'))),
);
resolver.define(
  'sendTestDispute',
  guarded((p) => sendTestDispute(p as TestDisputeInput)),
);
resolver.define(
  'recentDisputes',
  guarded(() => recentDisputes()),
);
resolver.define(
  'listDeadLetters',
  guarded(() => kvsStore.listDeadLetters()),
);
resolver.define(
  'replayDeadLetter',
  guarded((p) => replayDeadLetter(stringField(p, 'id'))),
);

export const adminResolver = resolver.getDefinitions();
