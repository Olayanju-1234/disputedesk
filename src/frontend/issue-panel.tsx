import { invoke } from '@forge/bridge';
import ForgeReconciler, {
  Box,
  Checkbox,
  Heading,
  Inline,
  Lozenge,
  ProgressBar,
  SectionMessage,
  Spinner,
  Stack,
  Strong,
  Text,
} from '@forge/react';
import { useCallback, useEffect, useState } from 'react';
import { describeTimeLeft, hoursLeft } from '../domain/deadline';
import type { DisputePanel } from '../domain/panel';

type Result = { ok: true; data: DisputePanel | null } | { ok: false; error: string };

type LozengeAppearance = 'default' | 'inprogress' | 'moved' | 'new' | 'removed' | 'success';

function urgency(panel: DisputePanel, now: Date): { text: string; appearance: LozengeAppearance } {
  if (panel.outcome === 'won') return { text: 'Won', appearance: 'success' };
  if (panel.outcome === 'lost') return { text: 'Lost', appearance: 'removed' };
  if (panel.outcome === 'resolved-unknown') return { text: 'Resolved', appearance: 'default' };
  if (!panel.dueAt) return { text: 'No deadline', appearance: 'default' };
  const left = hoursLeft(panel.dueAt, now);
  const appearance: LozengeAppearance =
    left <= 1 ? 'removed' : left <= 4 ? 'moved' : left <= 8 ? 'inprogress' : 'new';
  return { text: describeTimeLeft(left), appearance };
}

function shortTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

function App() {
  const [panel, setPanel] = useState<DisputePanel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());

  const apply = useCallback((result: Result) => {
    if (result.ok) {
      setPanel(result.data);
      setError(null);
    } else {
      setError(result.error);
    }
  }, []);

  useEffect(() => {
    invoke('getDisputePanel')
      .then((result) => apply(result as Result))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
    const timer = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(timer);
  }, [apply]);

  const toggle = (itemId: string, done: boolean) => {
    setSaving(itemId);
    invoke('setEvidence', { itemId, done })
      .then((result) => apply(result as Result))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSaving(null));
  };

  if (loading) return <Spinner label="Loading dispute" />;
  if (error) {
    return (
      <SectionMessage appearance="error">
        <Text>{error}</Text>
      </SectionMessage>
    );
  }
  if (!panel) return <Text>No DisputeDesk record for this issue.</Text>;

  const state = urgency(panel, now);
  const open = panel.outcome === 'open';

  return (
    <Stack space="space.200">
      <Inline space="space.100" alignBlock="center">
        <Lozenge appearance={state.appearance} isBold>
          {state.text}
        </Lozenge>
        {panel.mode === 'test' && <Lozenge>Test mode</Lozenge>}
      </Inline>
      {panel.dueAt && (
        <Text>
          {open ? 'Respond by ' : 'Deadline was '}
          <Strong>{shortTime(panel.dueAt)} UTC</Strong>
        </Text>
      )}
      <Text>
        {panel.amount} · {panel.reasonLabel}
        {panel.customer ? ` · ${panel.customer}` : ''}
      </Text>

      <Box>
        <Heading size="small">
          Evidence {panel.evidence.done} of {panel.evidence.total}
        </Heading>
        <ProgressBar
          value={panel.evidence.total ? panel.evidence.done / panel.evidence.total : 0}
          appearance={panel.evidence.done === panel.evidence.total ? 'success' : 'default'}
        />
        <Stack space="space.050">
          {panel.evidence.items.map((item) => (
            <Box key={item.id}>
              <Checkbox
                label={item.label}
                isChecked={panel.evidence.state[item.id]?.done === true}
                isDisabled={saving !== null}
                onChange={() => toggle(item.id, panel.evidence.state[item.id]?.done !== true)}
              />
              <Text size="small">{item.hint}</Text>
            </Box>
          ))}
        </Stack>
      </Box>

      <Box>
        <Heading size="small">Timeline</Heading>
        <Stack space="space.050">
          {panel.timeline.map((row, i) => (
            <Text key={`${row.at}-${i}`} size="small">
              <Strong>{shortTime(row.at)}</Strong> {row.label}
            </Text>
          ))}
        </Stack>
      </Box>
    </Stack>
  );
}

ForgeReconciler.render(<App />);
