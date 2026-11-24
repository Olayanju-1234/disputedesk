import { invoke } from '@forge/bridge';
import ForgeReconciler, {
  Box,
  Button,
  ButtonGroup,
  Checkbox,
  Heading,
  Inline,
  Label,
  Lozenge,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalTitle,
  ModalTransition,
  ProgressBar,
  SectionMessage,
  Select,
  Spinner,
  Stack,
  Strong,
  Text,
  TextArea,
  Textfield,
} from '@forge/react';
import { useCallback, useEffect, useState } from 'react';
import { describeTimeLeft, hoursLeft } from '../domain/deadline';
import type { PanelData } from '../handlers/issue-panel';

type DisputePanel = PanelData;
type Result = { ok: true; data: DisputePanel | null } | { ok: false; error: string };
type Option = { label: string; value: string };
type Action = 'contest' | 'accept';

const ACTIONS: Option[] = [
  { label: 'Contest with evidence', value: 'contest' },
  { label: 'Accept and refund the customer', value: 'accept' },
];

const DEFAULT_MESSAGE: Record<Action, string> = {
  contest: 'The customer received what they paid for. The receipt is attached.',
  accept: 'We accept this dispute and agree to refund the customer.',
};

const RESPONSE_APPEARANCE = {
  confirmed: 'success',
  simulated: 'success',
  rejected: 'error',
  unconfirmed: 'warning',
} as const;

function inputValue(event: unknown): string {
  const target = (event as { target?: { value?: unknown } }).target;
  return typeof target?.value === 'string' ? target.value : '';
}

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
  const [action, setAction] = useState<Action>('contest');
  const [attachmentId, setAttachmentId] = useState('');
  const [message, setMessage] = useState('');
  const [evidence, setEvidence] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);

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

  const field = (name: string) => (event: unknown) =>
    setEvidence((current) => ({ ...current, [name]: inputValue(event) }));

  const submit = () => {
    if (!panel) return;
    setConfirming(false);
    setSaving('response');
    invoke('submitResponse', {
      action,
      attachmentId,
      message: message.trim() || DEFAULT_MESSAGE[action],
      evidence: {
        customerName: evidence.customerName ?? panel.customerName ?? '',
        customerEmail: evidence.customerEmail ?? panel.customerEmail ?? '',
        customerPhone: evidence.customerPhone ?? '',
        serviceDetails: evidence.serviceDetails ?? '',
        deliveryAddress: evidence.deliveryAddress ?? '',
        deliveryDate: evidence.deliveryDate ?? '',
      },
    })
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

      {panel.responseSummary && panel.response && (
        <SectionMessage appearance={RESPONSE_APPEARANCE[panel.response.status]}>
          <Text>{panel.responseSummary}</Text>
        </SectionMessage>
      )}

      {panel.canRespond && (
        <Box>
          <Heading size="small">Respond to Paystack</Heading>
          <Stack space="space.100">
            {panel.simulated && (
              <Text size="small">
                This dispute came from the simulator, so your response is recorded here and not sent
                to Paystack.
              </Text>
            )}
            <Select
              inputId="action"
              options={ACTIONS}
              value={ACTIONS.find((o) => o.value === action)}
              onChange={(option: Option) => setAction(option.value as Action)}
            />
            {action === 'contest' && (
              <>
                <Label labelFor="receipt">Receipt to upload</Label>
                {panel.attachments.length > 0 ? (
                  <Select
                    inputId="receipt"
                    placeholder="Pick a PDF or JPEG on this ticket"
                    options={panel.attachments.map((a) => ({ label: a.filename, value: a.id }))}
                    onChange={(option: Option) => setAttachmentId(option.value)}
                  />
                ) : (
                  <Text size="small">
                    Attach the receipt (PDF or JPEG) to this ticket, then reopen this panel.
                  </Text>
                )}
                {panel.category === 'fraud' && (
                  <>
                    <Label labelFor="customerName">Customer name</Label>
                    <Textfield
                      id="customerName"
                      defaultValue={panel.customerName ?? ''}
                      onChange={field('customerName')}
                    />
                    <Label labelFor="customerEmail">Customer email</Label>
                    <Textfield
                      id="customerEmail"
                      defaultValue={panel.customerEmail ?? ''}
                      onChange={field('customerEmail')}
                    />
                    <Label labelFor="customerPhone">Customer phone</Label>
                    <Textfield id="customerPhone" onChange={field('customerPhone')} />
                    <Label labelFor="serviceDetails">What was provided</Label>
                    <TextArea id="serviceDetails" onChange={field('serviceDetails')} />
                    <Label labelFor="deliveryAddress">Delivery address (optional)</Label>
                    <Textfield id="deliveryAddress" onChange={field('deliveryAddress')} />
                    <Label labelFor="deliveryDate">Delivery date, YYYY-MM-DD (optional)</Label>
                    <Textfield id="deliveryDate" onChange={field('deliveryDate')} />
                  </>
                )}
              </>
            )}
            <Label labelFor="message">Message to Paystack</Label>
            <TextArea
              id="message"
              placeholder={DEFAULT_MESSAGE[action]}
              onChange={(event) => setMessage(inputValue(event))}
            />
            <ButtonGroup>
              <Button
                appearance={action === 'accept' ? 'warning' : 'primary'}
                isDisabled={saving !== null || (action === 'contest' && !attachmentId)}
                onClick={() => setConfirming(true)}
              >
                {saving === 'response'
                  ? 'Sending…'
                  : panel.simulated
                    ? 'Record response'
                    : 'Send to Paystack'}
              </Button>
            </ButtonGroup>
          </Stack>
        </Box>
      )}

      <ModalTransition>
        {confirming && (
          <Modal onClose={() => setConfirming(false)}>
            <ModalHeader>
              <ModalTitle>
                {action === 'contest' ? 'Contest this dispute?' : 'Accept and refund?'}
              </ModalTitle>
            </ModalHeader>
            <ModalBody>
              <Text>
                {action === 'contest'
                  ? 'DisputeDesk uploads the receipt and tells Paystack you decline the chargeback.'
                  : `Paystack refunds ${panel.amount} to the customer from your balance.`}
                {panel.simulated ? ' This is a simulator dispute, so nothing is sent.' : ''}
              </Text>
            </ModalBody>
            <ModalFooter>
              <Button appearance="subtle" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button appearance={action === 'accept' ? 'warning' : 'primary'} onClick={submit}>
                Confirm
              </Button>
            </ModalFooter>
          </Modal>
        )}
      </ModalTransition>

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
