import { invoke } from '@forge/bridge';
import ForgeReconciler, {
  Box,
  Button,
  DonutChart,
  DynamicTable,
  Heading,
  Inline,
  Link,
  Lozenge,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Text,
  xcss,
} from '@forge/react';
import { useCallback, useEffect, useState } from 'react';
import { describeTimeLeft } from '../domain/deadline';
import type { DashboardRow, MoneyTotal } from '../domain/dashboard';
import type { DashboardData } from '../handlers/dashboard';

type Result = { ok: true; data: DashboardData } | { ok: false; error: string };
type LozengeAppearance = 'default' | 'inprogress' | 'moved' | 'new' | 'removed' | 'success';

const card = xcss({
  padding: 'space.200',
  borderRadius: 'radius.medium',
  backgroundColor: 'elevation.surface.sunken',
  minWidth: '150px',
});

// Outcome colours follow money: kept is green, lost is red.
const OUTCOME_COLORS = [
  { key: 'Won', value: '#22A06B' },
  { key: 'Lost', value: '#C9372C' },
  { key: 'Open', value: '#1D7AFC' },
];

const RESPONSE_LABEL: Record<string, { text: string; appearance: LozengeAppearance }> = {
  confirmed: { text: 'Sent', appearance: 'success' },
  simulated: { text: 'Recorded', appearance: 'success' },
  rejected: { text: 'Rejected', appearance: 'removed' },
  unconfirmed: { text: 'Not confirmed', appearance: 'moved' },
};

function money(totals: MoneyTotal[]): string {
  return totals.length ? totals.map((t) => t.formatted).join(' + ') : 'None';
}

function timeLeft(row: DashboardRow): { text: string; appearance: LozengeAppearance } {
  if (row.hoursLeft === null) return { text: 'No deadline', appearance: 'default' };
  const h = row.hoursLeft;
  const appearance: LozengeAppearance =
    h <= 1 ? 'removed' : h <= 4 ? 'moved' : h <= 8 ? 'inprogress' : 'new';
  return { text: describeTimeLeft(h), appearance };
}

function utc(iso: string): string {
  return `${new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  })} UTC`;
}

function ticket(row: DashboardRow) {
  return row.issueKey ? <Link href={`/browse/${row.issueKey}`}>{row.issueKey}</Link> : 'pending';
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <Box xcss={card}>
      <Stack space="space.050">
        <Text size="small">{label}</Text>
        <Heading size="medium">{value}</Heading>
        {note && <Text size="small">{note}</Text>}
      </Stack>
    </Box>
  );
}

function App() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = useCallback((result: Result) => {
    if (result.ok) {
      setData(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
  }, []);

  const load = useCallback(() => {
    setBusy('refresh');
    invoke('getDashboard')
      .then((r) => apply(r as Result))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  }, [apply]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);

  const replay = (id: string) => {
    setBusy(id);
    invoke('replayDeadLetter', { id })
      .then((r) => apply(r as Result))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(null));
  };

  if (!data && !error) return <Spinner label="Loading disputes" />;

  return (
    <Stack space="space.300">
      <Inline spread="space-between" alignBlock="center">
        <Heading size="large">Disputes</Heading>
        <Inline space="space.100" alignBlock="center">
          {data && <Text size="small">Updated {utc(data.generatedAt)}</Text>}
          <Button onClick={load} isDisabled={busy !== null}>
            Refresh
          </Button>
        </Inline>
      </Inline>

      {error && (
        <SectionMessage appearance="error">
          <Text>{error}</Text>
        </SectionMessage>
      )}

      {data && (
        <>
          <Inline space="space.200" shouldWrap>
            <Stat label="Open disputes" value={String(data.totals.open)} />
            <Stat
              label={`Due within 4 h`}
              value={String(data.totals.dueSoon)}
              note={data.totals.overdue ? `${data.totals.overdue} overdue` : undefined}
            />
            <Stat label="Money at risk" value={money(data.atRisk)} />
            <Stat
              label="Win rate"
              value={
                data.totals.winRate === null ? 'n/a' : `${Math.round(data.totals.winRate * 100)}%`
              }
              note={`${data.totals.won} won, ${data.totals.lost} lost`}
            />
            <Stat
              label="Money kept"
              value={money(data.recovered)}
              note={`Lost: ${money(data.lostAmount)}`}
            />
          </Inline>

          {data.byOutcome.length > 0 && (
            <Box>
              <DonutChart
                title="Disputes by outcome"
                data={data.byOutcome}
                colorAccessor="label"
                labelAccessor="label"
                valueAccessor="count"
                height={240}
                colorPalette={OUTCOME_COLORS}
              />
            </Box>
          )}

          <Box>
            <Heading size="medium">Open, soonest deadline first</Heading>
            <DynamicTable
              emptyView={<Text>No open disputes.</Text>}
              head={{
                cells: [
                  { key: 'ticket', content: 'Ticket' },
                  { key: 'amount', content: 'Amount' },
                  { key: 'reason', content: 'Reason' },
                  { key: 'left', content: 'Time left' },
                  { key: 'evidence', content: 'Evidence' },
                  { key: 'response', content: 'Response' },
                ],
              }}
              rows={data.open.map((row) => {
                const left = timeLeft(row);
                const response = row.responseStatus
                  ? RESPONSE_LABEL[row.responseStatus]
                  : undefined;
                return {
                  key: row.key,
                  cells: [
                    { key: 'ticket', content: ticket(row) },
                    { key: 'amount', content: row.amount },
                    { key: 'reason', content: row.reasonLabel },
                    {
                      key: 'left',
                      content: <Lozenge appearance={left.appearance}>{left.text}</Lozenge>,
                    },
                    { key: 'evidence', content: `${row.evidenceDone} of ${row.evidenceTotal}` },
                    {
                      key: 'response',
                      content: response ? (
                        <Lozenge appearance={response.appearance}>{response.text}</Lozenge>
                      ) : (
                        'Not sent'
                      ),
                    },
                  ],
                };
              })}
            />
          </Box>

          <Box>
            <Heading size="medium">Recently resolved</Heading>
            <DynamicTable
              emptyView={<Text>Nothing resolved yet.</Text>}
              head={{
                cells: [
                  { key: 'ticket', content: 'Ticket' },
                  { key: 'amount', content: 'Amount' },
                  { key: 'reason', content: 'Reason' },
                  { key: 'outcome', content: 'Outcome' },
                  { key: 'when', content: 'Updated' },
                ],
              }}
              rows={data.recent.map((row) => ({
                key: row.key,
                cells: [
                  { key: 'ticket', content: ticket(row) },
                  { key: 'amount', content: row.amount },
                  { key: 'reason', content: row.reasonLabel },
                  {
                    key: 'outcome',
                    content: (
                      <Lozenge
                        appearance={
                          row.outcome === 'won'
                            ? 'success'
                            : row.outcome === 'lost'
                              ? 'removed'
                              : 'default'
                        }
                      >
                        {row.outcome}
                      </Lozenge>
                    ),
                  },
                  { key: 'when', content: utc(row.updatedAt) },
                ],
              }))}
            />
          </Box>

          <Box>
            <Heading size="medium">Failed events</Heading>
            <Text size="small">
              Webhook events that still failed after every retry. Fix the cause, then replay;
              repeats are ignored, so replaying twice is safe.
            </Text>
            <DynamicTable
              emptyView={<Text>Nothing failed.</Text>}
              head={{
                cells: [
                  { key: 'dispute', content: 'Dispute' },
                  { key: 'failed', content: 'Failed' },
                  { key: 'attempts', content: 'Attempts' },
                  { key: 'error', content: 'Error' },
                  { key: 'action', content: '' },
                ],
              }}
              rows={data.deadLetters.map((d) => ({
                key: d.id,
                cells: [
                  { key: 'dispute', content: d.disputeKey ?? 'unknown' },
                  { key: 'failed', content: utc(d.failedAt) },
                  { key: 'attempts', content: String(d.attempts) },
                  { key: 'error', content: <Text size="small">{d.error}</Text> },
                  {
                    key: 'action',
                    content: (
                      <Button onClick={() => replay(d.id)} isDisabled={busy !== null}>
                        {busy === d.id ? 'Replaying…' : 'Replay'}
                      </Button>
                    ),
                  },
                ],
              }))}
            />
          </Box>
          <Text size="small">
            <Strong>Note:</Strong> amounts come from Paystack's dispute events; simulator disputes
            are included and marked Test mode on their tickets.
          </Text>
        </>
      )}
    </Stack>
  );
}

ForgeReconciler.render(<App />);
