export const PAYSTACK_API = 'https://api.paystack.co';

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export type HttpFetch = (
  url: string,
  init: { method: string; headers?: Record<string, string>; body?: string | Uint8Array },
) => Promise<HttpResponse>;

export interface EvidenceInput {
  customerEmail: string;
  customerName: string;
  customerPhone: string;
  serviceDetails: string;
  deliveryAddress?: string;
  deliveryDate?: string;
}

export interface ResolveInput {
  resolution: 'merchant-accepted' | 'declined';
  message: string;
  refundAmountMinor: number;
  uploadedFilename?: string;
  evidenceId?: number;
}

export interface PaystackDisputeClient {
  addEvidence(disputeId: string, input: EvidenceInput): Promise<{ id: number }>;
  getUploadUrl(
    disputeId: string,
    filename: string,
  ): Promise<{ signedUrl: string; fileName: string }>;
  uploadFile(signedUrl: string, bytes: Uint8Array, contentType: string): Promise<void>;
  resolve(disputeId: string, input: ResolveInput): Promise<void>;
}

/** `retryable` is true when Paystack couldn't be reached or failed on its side, false when it rejected the call. */
export class PaystackError extends Error {
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(message: string, status: number | null) {
    super(message);
    this.status = status;
    this.retryable = status === null || status === 429 || status >= 500;
  }
}

interface Envelope<T> {
  status?: boolean;
  message?: string;
  data?: T;
}

export function createPaystackClient(secretKey: string, http: HttpFetch): PaystackDisputeClient {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: HttpResponse;
    try {
      res = await http(`${PAYSTACK_API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new PaystackError(
        `Paystack unreachable: ${err instanceof Error ? err.message : String(err)}`,
        null,
      );
    }
    const text = await res.text();
    let envelope: Envelope<T> = {};
    try {
      envelope = text ? (JSON.parse(text) as Envelope<T>) : {};
    } catch {
      envelope = {};
    }
    if (!res.ok || envelope.status === false) {
      throw new PaystackError(envelope.message ?? `Paystack responded ${res.status}`, res.status);
    }
    return envelope.data as T;
  }

  const id = (disputeId: string) => encodeURIComponent(disputeId);

  return {
    async addEvidence(disputeId, input) {
      const data = await call<{ id: number }>('POST', `/dispute/${id(disputeId)}/evidence`, {
        customer_email: input.customerEmail,
        customer_name: input.customerName,
        customer_phone: input.customerPhone,
        service_details: input.serviceDetails,
        ...(input.deliveryAddress ? { delivery_address: input.deliveryAddress } : {}),
        ...(input.deliveryDate ? { delivery_date: input.deliveryDate } : {}),
      });
      return { id: data.id };
    },

    async getUploadUrl(disputeId, filename) {
      const query = new URLSearchParams({ upload_filename: filename }).toString();
      return call<{ signedUrl: string; fileName: string }>(
        'GET',
        `/dispute/${id(disputeId)}/upload_url?${query}`,
      );
    },

    async uploadFile(signedUrl, bytes, contentType) {
      let res: HttpResponse;
      try {
        res = await http(signedUrl, {
          method: 'PUT',
          headers: { 'Content-Type': contentType },
          body: bytes,
        });
      } catch (err) {
        throw new PaystackError(
          `Upload failed: ${err instanceof Error ? err.message : String(err)}`,
          null,
        );
      }
      if (!res.ok) throw new PaystackError(`Upload rejected with ${res.status}`, res.status);
    },

    async resolve(disputeId, input) {
      await call('PUT', `/dispute/${id(disputeId)}/resolve`, {
        resolution: input.resolution,
        message: input.message,
        refund_amount: input.refundAmountMinor,
        ...(input.uploadedFilename ? { uploaded_filename: input.uploadedFilename } : {}),
        ...(input.evidenceId !== undefined ? { evidence: input.evidenceId } : {}),
      });
    },
  };
}
