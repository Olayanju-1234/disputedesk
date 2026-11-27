import { invoke } from '@forge/bridge';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  Code,
  DynamicTable,
  Heading,
  Inline,
  Label,
  Lozenge,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Text,
  Textfield,
} from '@forge/react';
import { useCallback, useEffect, useState } from 'react';

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

interface Settings {
  config: { projectKey: string | null; issueType: string };
  webhookUrl: string;
  secretKey: string | null;
  signingSecret: string | null;
  ready: boolean;
}

interface Project {
  key: string;
  name: string;
  type: string;
}

interface DisputeRow {
  key: string;
  issueKey: string | null;
  status: string;
  outcome: 'open' | 'won' | 'lost' | 'resolved-unknown';
  amountMinor: number;
  currency: string;
  dueAt: string | null;
  lastEvent: string | null;
  updatedAt: string;
}

interface DeadLetterRow {
  id: string;
  failedAt: string;
  attempts: number;
  error: string;
  disputeKey: string | null;
}

interface SimResult {
  scenario: string;
  disputeId: number;
  reference: string;
  status: number;
  response: string;
}

type Option = { label: string; value: string };

const DEADLINES: Option[] = [
  { label: '16 hours (Paystack default)', value: '16' },
  { label: '7 hours (inside the 8 h warning)', value: '7' },
  { label: '3.5 hours (inside the 4 h warning)', value: '3.5' },
  { label: '45 minutes (inside the 1 h warning)', value: '0.75' },
  { label: 'Already overdue by 15 minutes', value: '-0.25' },
];

const SCENARIOS: Option[] = [
  { label: 'New dispute', value: 'create' },
  { label: 'Paystack reminder', value: 'remind' },
  { label: 'Resolve: won (declined)', value: 'resolve-won' },
  { label: 'Resolve: lost (merchant accepted)', value: 'resolve-lost' },
  { label: 'Resolve: lost (deadline passed)', value: 'resolve-timeout' },
];

async function call<T>(name: string, payload: Record<string, unknown> = {}): Promise<T> {
  const result = (await invoke(name, payload)) as Result<T>;
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function textValue(event: unknown): string {
  const target = (event as { target?: { value?: unknown } }).target;
  return typeof target?.value === 'string' ? target.value : '';
}

function money(amountMinor: number, currency: string): string {
  return `${currency} ${(amountMinor / 100).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
}

function timeLeft(dueAt: string | null): string {
  if (!dueAt) return 'no deadline';
  const hours = (Date.parse(dueAt) - Date.now()) / 3_600_000;
  if (hours <= 0) return 'overdue';
  return hours < 1 ? `${Math.round(hours * 60)} min left` : `${hours.toFixed(1)} h left`;
}

const OUTCOME_APPEARANCE = {
  open: 'inprogress',
  won: 'success',
  lost: 'removed',
  'resolved-unknown': 'default',
} as const;

function App() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [issueTypes, setIssueTypes] = useState<string[]>([]);
  const [projectKey, setProjectKey] = useState<string>('');
  const [issueType, setIssueType] = useState<string>('Task');
  const [secretKey, setSecretKey] = useState('');
  const [signingSecret, setSigningSecret] = useState('');
  const [scenario, setScenario] = useState<Option>(SCENARIOS[0]!);
  const [hoursUntilDue, setHoursUntilDue] = useState('16');
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [deadLetters, setDeadLetters] = useState<DeadLetterRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [lastSim, setLastSim] = useState<SimResult | null>(null);
  const [userAccess, setUserAccess] = useState<boolean | null>(null);

  const refreshLists = useCallback(async () => {
    const [rows, dlq] = await Promise.all([
      call<DisputeRow[]>('recentDisputes'),
      call<DeadLetterRow[]>('listDeadLetters'),
    ]);
    setDisputes(rows);
    setDeadLetters(dlq);
  }, []);

  useEffect(() => {
    call<{ granted: boolean }>('userAccessStatus')
      .then((s) => setUserAccess(s.granted))
      .catch(() => setUserAccess(false));
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const [loaded, projectList] = await Promise.all([
          call<Settings>('getSettings'),
          call<Project[]>('listProjects'),
        ]);
        setSettings(loaded);
        setProjects(projectList);
        setProjectKey(loaded.config.projectKey ?? '');
        setIssueType(loaded.config.issueType);
        await refreshLists();
      } catch (err) {
        setMessage({ tone: 'error', text: (err as Error).message });
      }
    })();
  }, [refreshLists]);

  useEffect(() => {
    if (!projectKey) return;
    call<string[]>('listIssueTypes', { projectKey })
      .then(setIssueTypes)
      .catch(() => setIssueTypes([]));
  }, [projectKey]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(label);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage({ tone: 'error', text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run('save', async () => {
      const saved = await call<Settings>('saveSettings', {
        projectKey,
        issueType,
        secretKey,
        signingSecret,
      });
      setSettings(saved);
      setSecretKey('');
      setSigningSecret('');
      setMessage({ tone: 'success', text: 'Settings saved.' });
    });

  const sendTest = () =>
    run('simulate', async () => {
      const result = await call<SimResult>('sendTestDispute', {
        scenario: scenario.value,
        hoursUntilDue: Number(hoursUntilDue),
      });
      setLastSim(result);
      setMessage(
        result.status === 200
          ? {
              tone: 'success',
              text: `Webhook accepted (${result.scenario}). The ticket updates in a few seconds; press Refresh.`,
            }
          : { tone: 'error', text: `Webhook answered ${result.status}: ${result.response}` },
      );
    });

  const allowAccess = () =>
    run('access', async () => {
      const s = await call<{ granted: boolean }>('requestUserAccess');
      setUserAccess(s.granted);
    });

  const replay = (id: string) =>
    run(`replay-${id}`, async () => {
      await call('replayDeadLetter', { id });
      await refreshLists();
      setMessage({ tone: 'success', text: 'Event sent back to the queue.' });
    });

  if (!settings && !message) return <Spinner label="Loading DisputeDesk settings" />;

  const projectOptions: Option[] = projects.map((p) => ({
    label: `${p.name} (${p.key})`,
    value: p.key,
  }));
  const issueTypeOptions: Option[] = (issueTypes.length ? issueTypes : [issueType]).map((t) => ({
    label: t,
    value: t,
  }));

  return (
    <Stack space="space.300">
      <Heading size="large">DisputeDesk</Heading>
      <Text>
        Paystack disputes become Jira tickets with a deadline countdown. Unanswered disputes are
        accepted for you after the deadline and refunded from your balance, so every hour counts.
      </Text>

      {message && (
        <SectionMessage appearance={message.tone === 'success' ? 'success' : 'error'}>
          <Text>{message.text}</Text>
        </SectionMessage>
      )}

      {settings && (
        <SectionMessage
          appearance={settings.ready ? 'success' : 'warning'}
          title={settings.ready ? 'Ready to receive disputes' : 'Finish setup'}
        >
          <Text>
            <Strong>Webhook URL for your Paystack dashboard: </Strong>
          </Text>
          <Code>{settings.webhookUrl}</Code>
          <Text>
            Secret key: {settings.secretKey ?? 'not set'} · Signing secret:{' '}
            {settings.signingSecret ?? 'not set'} · Project:{' '}
            {settings.config.projectKey ?? 'not set'}
          </Text>
        </SectionMessage>
      )}

      <Box>
        <Heading size="medium">1. Settings</Heading>
        <Stack space="space.100">
          <Label labelFor="project">Jira project for dispute tickets</Label>
          <Select
            inputId="project"
            options={projectOptions}
            value={projectOptions.find((o) => o.value === projectKey)}
            onChange={(option: Option) => setProjectKey(option.value)}
          />
          <Label labelFor="issueType">Issue type</Label>
          <Select
            inputId="issueType"
            options={issueTypeOptions}
            value={issueTypeOptions.find((o) => o.value === issueType)}
            onChange={(option: Option) => setIssueType(option.value)}
          />
          <Label labelFor="secretKey">Paystack secret key (verifies x-paystack-signature)</Label>
          <Textfield
            id="secretKey"
            type="password"
            placeholder={settings?.secretKey ?? 'sk_test_...'}
            value={secretKey}
            onChange={(e) => setSecretKey(textValue(e))}
          />
          <Label labelFor="signingSecret">
            Webhook signing secret, optional (verifies Paystack-Signature)
          </Label>
          <Textfield
            id="signingSecret"
            type="password"
            placeholder={settings?.signingSecret ?? 'whsec_...'}
            value={signingSecret}
            onChange={(e) => setSigningSecret(textValue(e))}
          />
          <Inline>
            <Button appearance="primary" onClick={() => void save()} isDisabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save settings'}
            </Button>
          </Inline>
        </Stack>
      </Box>

      <Box>
        <Heading size="medium">2. Send a signed test dispute</Heading>
        <Text>
          Signs a Paystack-shaped dispute event with your saved secret and posts it to the webhook
          above, so you can try the whole flow without a real chargeback.
        </Text>
        <Stack space="space.100">
          <Label labelFor="scenario">Scenario</Label>
          <Select
            inputId="scenario"
            options={SCENARIOS}
            value={scenario}
            onChange={(option: Option) => setScenario(option)}
          />
          {scenario.value === 'create' && (
            <>
              <Label labelFor="hours">Time left to respond</Label>
              <Select
                inputId="hours"
                options={DEADLINES}
                value={DEADLINES.find((o) => o.value === hoursUntilDue)}
                onChange={(option: Option) => setHoursUntilDue(option.value)}
              />
            </>
          )}
          <ButtonGroup>
            <Button
              appearance="primary"
              onClick={() => void sendTest()}
              isDisabled={busy !== null || !settings?.ready}
            >
              {busy === 'simulate' ? 'Sending…' : 'Send test dispute'}
            </Button>
            <Button onClick={() => void run('refresh', refreshLists)} isDisabled={busy !== null}>
              Refresh
            </Button>
          </ButtonGroup>
          {lastSim && (
            <Text>
              Last test: dispute {lastSim.disputeId}, transaction <Code>{lastSim.reference}</Code>,
              webhook answered {lastSim.status}.
            </Text>
          )}
        </Stack>
      </Box>

      <Box>
        <Heading size="medium">3. Rovo and MCP tools</Heading>
        <Stack space="space.100">
          <Text>
            The Dispute analyst's tools read Jira and Confluence as the person using them. Rovo asks
            for nothing extra; MCP clients such as Claude need each person to allow access once.
          </Text>
          <Inline space="space.100" alignBlock="center">
            <Lozenge appearance={userAccess ? 'success' : 'default'}>
              {userAccess === null ? 'checking' : userAccess ? 'access allowed' : 'not allowed yet'}
            </Lozenge>
            {userAccess === false && (
              <Button onClick={() => void allowAccess()} isDisabled={busy !== null}>
                Allow access for MCP tools
              </Button>
            )}
          </Inline>
        </Stack>
      </Box>

      <Box>
        <Heading size="medium">Recent disputes</Heading>
        <DynamicTable
          caption="Most recently updated first"
          emptyView={<Text>No disputes yet. Send a test dispute above.</Text>}
          head={{
            cells: [
              { key: 'ticket', content: 'Ticket' },
              { key: 'amount', content: 'Amount' },
              { key: 'status', content: 'Paystack status' },
              { key: 'outcome', content: 'Outcome' },
              { key: 'deadline', content: 'Deadline' },
              { key: 'last', content: 'Last event' },
            ],
          }}
          rows={disputes.map((d) => ({
            key: d.key,
            cells: [
              { key: 'ticket', content: d.issueKey ?? 'pending' },
              { key: 'amount', content: money(d.amountMinor, d.currency) },
              { key: 'status', content: d.status },
              {
                key: 'outcome',
                content: <Lozenge appearance={OUTCOME_APPEARANCE[d.outcome]}>{d.outcome}</Lozenge>,
              },
              { key: 'deadline', content: d.outcome === 'open' ? timeLeft(d.dueAt) : 'closed' },
              { key: 'last', content: d.lastEvent ?? '' },
            ],
          }))}
        />
      </Box>

      <Box>
        <Heading size="medium">Dead letters</Heading>
        <Text>
          Events that failed after every retry. Fix the cause (for example the project setting),
          then replay.
        </Text>
        <DynamicTable
          emptyView={<Text>Nothing failed.</Text>}
          head={{
            cells: [
              { key: 'dispute', content: 'Dispute' },
              { key: 'failed', content: 'Failed at' },
              { key: 'attempts', content: 'Attempts' },
              { key: 'error', content: 'Error' },
              { key: 'action', content: '' },
            ],
          }}
          rows={deadLetters.map((d) => ({
            key: d.id,
            cells: [
              { key: 'dispute', content: d.disputeKey ?? 'unknown' },
              { key: 'failed', content: new Date(d.failedAt).toUTCString() },
              { key: 'attempts', content: String(d.attempts) },
              { key: 'error', content: d.error },
              {
                key: 'action',
                content: (
                  <Button onClick={() => void replay(d.id)} isDisabled={busy !== null}>
                    Replay
                  </Button>
                ),
              },
            ],
          }))}
        />
      </Box>
    </Stack>
  );
}

ForgeReconciler.render(<App />);
