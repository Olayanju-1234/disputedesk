# Paystack facts used by DisputeDesk

Read from paystack.com/docs on 22 Nov 2026.

## Webhooks

- Dispute events: `charge.dispute.create` (logged), `charge.dispute.remind` (every 4 hours for unresolved
  chargebacks), `charge.dispute.resolve` (resolved).
- Answer 200 fast. Live mode retries every 3 minutes for the first 4 tries, then hourly for 72 hours. Test mode
  retries hourly for 10 hours with a 30 second timeout.
- Resends are not idempotent: the handler must ignore events it already processed.
- Source IPs: 52.31.139.75, 52.49.173.169, 52.214.14.220.
- The payload has no event id. Sample payloads are saved byte for byte in `test/fixtures/paystack/`.

## Signatures

- `Paystack-Signature: t=<unix seconds>,v1=<key id>:<128 hex chars>`. HMAC-SHA512 of `t`, `.`, raw body, keyed
  with the whole signing secret including `whsec_`. Reject if `t` is more than 300 s off. Any `v1` may match
  (two during a rotation overlap). Retries and resends are signed again with a new `t`.
- `x-paystack-signature`: HMAC-SHA512 of the raw body keyed with the secret key. No timestamp. Sent while the
  integration still has a secret key.

## Disputes

- Respond within 16 hours, or Paystack accepts the dispute and refunds the customer from the Paystack balance.
- Status values: `awaiting-merchant-feedback`, `awaiting-bank-feedback`, `pending`, `resolved` (also seen:
  `archived` in API samples).
- Resolutions seen: `merchant-accepted`, `declined`, `auto-accepted` (deadline lapsed).
- Categories: `chargeback`, `fraud`.
- Evidence and resolve endpoints (week 2): `GET /dispute/:id/upload_url` (signed URL valid 30 minutes, jpg, jpeg
  or pdf), `POST /dispute/:id/evidence` for fraud claims, `PUT /dispute/:id/resolve` with `merchant-accepted` or
  `declined`; declining needs the uploaded file name.
