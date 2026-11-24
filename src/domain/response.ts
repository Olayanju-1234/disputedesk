import {
  PaystackError,
  type EvidenceInput,
  type PaystackDisputeClient,
} from '../adapters/paystack';
import { outcomeOf, type DisputeSnapshot } from './dispute';

export type ResponseAction = 'contest' | 'accept';

/** confirmed: Paystack accepted it. simulated: a simulator dispute, nothing sent. rejected: Paystack said no.
 * unconfirmed: Paystack couldn't be reached, so the response is recorded here and can be retried. */
export type ResponseStatus = 'confirmed' | 'simulated' | 'rejected' | 'unconfirmed';

export interface ResponseInput {
  action: ResponseAction;
  message: string;
  attachmentId?: string;
  evidence?: EvidenceInput;
}

export interface ResponseRecord {
  action: ResponseAction;
  status: ResponseStatus;
  message: string;
  at: string;
  by: string | null;
  attempts: number;
  refundAmountMinor: number;
  attachmentId?: string;
  attachmentName?: string;
  evidenceId?: number;
  uploadedFilename?: string;
  error?: string;
}

export interface AttachmentFile {
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}

export interface ResponseDeps {
  paystack: PaystackDisputeClient | null;
  downloadAttachment: (id: string) => Promise<AttachmentFile>;
  now: () => Date;
}

export class ResponseValidationError extends Error {}

export const EVIDENCE_FILE_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
};

const FINAL: ResponseStatus[] = ['confirmed', 'simulated'];

export function isSimulated(
  snapshot: Pick<DisputeSnapshot, 'mode' | 'transactionReference'>,
): boolean {
  return snapshot.mode === 'test' && snapshot.transactionReference.startsWith('dd-test-');
}

export function canRespond(
  snapshot: DisputeSnapshot,
  previous: ResponseRecord | undefined,
): boolean {
  return outcomeOf(snapshot) === 'open' && !(previous && FINAL.includes(previous.status));
}

export function validateResponse(snapshot: DisputeSnapshot, input: ResponseInput): string[] {
  const errors: string[] = [];
  if (outcomeOf(snapshot) !== 'open') errors.push('This dispute is already resolved.');
  if (!input.message.trim()) errors.push('Add a short message for Paystack.');
  if (input.action === 'contest') {
    if (!input.attachmentId) errors.push('Pick the receipt attached to this ticket.');
    if (snapshot.category === 'fraud') {
      const e = input.evidence;
      const missing = [
        ['customer email', e?.customerEmail],
        ['customer name', e?.customerName],
        ['customer phone', e?.customerPhone],
        ['what was provided', e?.serviceDetails],
      ]
        .filter(([, v]) => !v?.trim())
        .map(([label]) => label);
      if (missing.length) errors.push(`Fraud claims need: ${missing.join(', ')}.`);
      if (e?.deliveryDate && !/^\d{4}-\d{2}-\d{2}$/.test(e.deliveryDate)) {
        errors.push('Delivery date must be YYYY-MM-DD.');
      }
    }
  }
  return errors;
}

export async function submitResponse(
  snapshot: DisputeSnapshot,
  input: ResponseInput,
  previous: ResponseRecord | undefined,
  by: string | null,
  deps: ResponseDeps,
): Promise<ResponseRecord> {
  if (previous && FINAL.includes(previous.status)) {
    throw new ResponseValidationError('A response was already sent for this dispute.');
  }
  const errors = validateResponse(snapshot, input);
  if (errors.length) throw new ResponseValidationError(errors.join(' '));

  // Reuse what an earlier attempt already created at Paystack, so a retry doesn't add duplicate evidence.
  const sameAttempt =
    previous?.action === input.action && previous.attachmentId === input.attachmentId;
  const record: ResponseRecord = {
    action: input.action,
    status: 'unconfirmed',
    message: input.message.trim(),
    at: deps.now().toISOString(),
    by,
    attempts: (previous?.attempts ?? 0) + 1,
    refundAmountMinor: input.action === 'accept' ? snapshot.amountMinor : 0,
    attachmentId: input.attachmentId,
    evidenceId: sameAttempt ? previous.evidenceId : undefined,
    uploadedFilename: sameAttempt ? previous.uploadedFilename : undefined,
  };

  const file = input.attachmentId ? await deps.downloadAttachment(input.attachmentId) : null;
  if (file) {
    if (!EVIDENCE_FILE_TYPES[file.mimeType]) {
      throw new ResponseValidationError(
        `Paystack accepts PDF or JPEG files; ${file.filename} is ${file.mimeType}.`,
      );
    }
    record.attachmentName = file.filename;
  }

  if (isSimulated(snapshot)) return { ...record, status: 'simulated' };
  if (!deps.paystack) {
    throw new ResponseValidationError('Save your Paystack secret key on the admin page first.');
  }

  const disputeId = snapshot.providerDisputeId;
  try {
    if (
      input.action === 'contest' &&
      snapshot.category === 'fraud' &&
      record.evidenceId === undefined &&
      input.evidence
    ) {
      record.evidenceId = (await deps.paystack.addEvidence(disputeId, input.evidence)).id;
    }
    if (file && !record.uploadedFilename) {
      const upload = await deps.paystack.getUploadUrl(disputeId, file.filename);
      await deps.paystack.uploadFile(upload.signedUrl, file.bytes, file.mimeType);
      record.uploadedFilename = upload.fileName;
    }
    await deps.paystack.resolve(disputeId, {
      resolution: input.action === 'contest' ? 'declined' : 'merchant-accepted',
      message: record.message,
      refundAmountMinor: record.refundAmountMinor,
      uploadedFilename: record.uploadedFilename,
      evidenceId: record.evidenceId,
    });
    return { ...record, status: 'confirmed' };
  } catch (err) {
    if (!(err instanceof PaystackError)) throw err;
    return { ...record, status: err.retryable ? 'unconfirmed' : 'rejected', error: err.message };
  }
}

export function describeResponse(r: ResponseRecord): string {
  const what = r.action === 'contest' ? 'Contest with evidence' : 'Accept and refund';
  switch (r.status) {
    case 'confirmed':
      return `${what}: sent to Paystack and confirmed.`;
    case 'simulated':
      return `${what}: recorded. This dispute came from the simulator, so nothing was sent to Paystack.`;
    case 'rejected':
      return `${what}: Paystack rejected it (${r.error ?? 'no reason given'}).`;
    case 'unconfirmed':
      return `${what}: recorded here, but Paystack did not confirm it (${r.error ?? 'no response'}). Retry before the deadline.`;
  }
}
