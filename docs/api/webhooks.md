# Webhooks — receiver guide (sandbox)

The sandbox sends a signed HTTPS `POST` when a business fact is final. Everything here is a
simulation with synthetic data; nothing is sent by, or to, a real bank or payment rail.

## Events

`payment.status_changed`, `batch.finished`, `deposit.posted`, `limit.threshold_reached`.

Body (JSON, exactly as signed):

```json
{ "id": "<event id>", "type": "payment.status_changed", "schemaVersion": 1,
  "occurredAt": "2026-11-23T07:00:05.000Z", "corporateReference": "QTD",
  "correlationId": "corr_…", "data": { "resourceId": "<uuid>", "state": "SETTLED" } }
```

`data` holds identifiers, states and aggregates only. It never contains an employee name, an
account number of an employee or a per-employee amount.

## Headers

| Header | Meaning |
| --- | --- |
| `X-AlQarib-Event-Id` | Stable id of the business event. The same on every retry: use it to de-duplicate. |
| `X-AlQarib-Delivery-Id` | Id of this subscription's delivery of that event. |
| `X-AlQarib-Timestamp` | Unix seconds when this attempt was signed. |
| `X-AlQarib-Signature` | `v1=` + hex `HMAC-SHA256(secret, timestamp + "." + rawBody)`. |

## Verify before you trust the body

Use the raw request bytes — not a re-serialized object — a constant-time comparison and a
±300 second window:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verify(secret: string, rawBody: string, timestamp: string, signature: string): boolean {
  if (!/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = "v1=" + createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Answer `2xx` quickly and process asynchronously. Delivery is at-least-once: the same event can
arrive more than once.

## Retries

A timeout (5 s), a connection failure or any non-`2xx` answer — including a redirect, which is
never followed — is retried after 10 s, 30 s, 2 min, 10 min and 1 h, then the delivery is
dead-lettered. A failed subscriber never changes the outcome of a payment.

## Destination rules

HTTPS on the default port only; no credentials in the URL; the host must resolve only to public
addresses. Loopback, private, link-local (including cloud metadata), carrier-grade NAT and
unique-local ranges are refused in every IPv4/IPv6 spelling. The check runs when the webhook is
registered and again before every delivery, and the connection goes to the address that was
just checked. The platform sends no request to "verify" a new subscription.

## Not in this release

Rotating a signing secret and replaying a delivery by hand are documented gaps.
