/**
 * Webhook destination policy and signature (EVT-01, U-EVT-01..04, I-47 at unit level). Pure
 * functions: no socket is opened here.
 */
import { describe, expect, it } from "vitest";
import { openSecret, sealSecret } from "@/server/crypto";
import { RETRY_SCHEDULE_SECONDS } from "@/server/domain/developer/service";
import { signWebhook, verifyWebhookSignature } from "@/server/domain/developer/signature";
import { DestinationError, isPublicAddress, parseDestination, resolveDestination, type Resolver } from "@/server/net/ssrf";

const problemOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof DestinationError) return error.problem;
    throw error;
  }
  return "ACCEPTED";
};

describe("webhook destination policy (I-47)", () => {
  it("accepts a public HTTPS host on the default port", () => {
    expect(problemOf(() => parseDestination("https://hooks.example.com/alqarib?x=1", []))).toBe("ACCEPTED");
    expect(problemOf(() => parseDestination("https://hooks.example.com:443/a", []))).toBe("ACCEPTED");
  });

  it.each([
    ["http://hooks.example.com/a", "SCHEME_NOT_HTTPS"],
    ["ftp://hooks.example.com/a", "SCHEME_NOT_HTTPS"],
    ["https://user:secret@hooks.example.com/a", "CREDENTIALS_IN_URL"],
    ["https://hooks.example.com:8443/a", "PORT_NOT_ALLOWED"],
    ["https://localhost/a", "HOST_NOT_ALLOWED"],
    ["https://db.internal/a", "HOST_NOT_ALLOWED"],
    ["https://printer.local/a", "HOST_NOT_ALLOWED"],
    ["https://intranet/a", "HOST_NOT_ALLOWED"],
    ["https://127.0.0.1/a", "ADDRESS_NOT_PUBLIC"],
    ["https://10.1.2.3/a", "ADDRESS_NOT_PUBLIC"],
    ["https://172.16.0.9/a", "ADDRESS_NOT_PUBLIC"],
    ["https://192.168.1.1/a", "ADDRESS_NOT_PUBLIC"],
    ["https://169.254.169.254/latest/meta-data", "ADDRESS_NOT_PUBLIC"],
    ["https://100.64.0.1/a", "ADDRESS_NOT_PUBLIC"],
    ["https://0.0.0.0/a", "ADDRESS_NOT_PUBLIC"],
    // Other spellings of loopback/private addresses that the URL parser normalizes.
    ["https://2130706433/a", "ADDRESS_NOT_PUBLIC"],
    ["https://0x7f.0.0.1/a", "ADDRESS_NOT_PUBLIC"],
    ["https://0177.0.0.1/a", "ADDRESS_NOT_PUBLIC"],
    ["https://[::1]/a", "ADDRESS_NOT_PUBLIC"],
    ["https://[::ffff:10.0.0.1]/a", "ADDRESS_NOT_PUBLIC"],
    ["https://[fd00::1]/a", "ADDRESS_NOT_PUBLIC"],
    ["https://[fe80::1]/a", "ADDRESS_NOT_PUBLIC"],
    ["https://hooks.example.com/a#fragment", "URL_INVALID"],
    ["not a url", "URL_INVALID"],
  ])("refuses %s (%s)", (url, problem) => {
    expect(problemOf(() => parseDestination(url, []))).toBe(problem);
  });

  it("classifies addresses in every family", () => {
    for (const address of ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"]) expect(isPublicAddress(address)).toBe(true);
    for (const address of ["127.0.0.1", "10.0.0.1", "169.254.169.254", "::1", "::ffff:192.168.0.1", "fc00::1", "224.0.0.1", "not-an-ip"]) expect(isPublicAddress(address)).toBe(false);
  });

  it("requires EVERY resolved address to be public and returns the one to pin (DNS rebinding)", async () => {
    const destination = parseDestination("https://hooks.example.com/a", []);
    const publicOnly: Resolver = async () => [{ address: "93.184.216.34", family: 4 }];
    const mixed: Resolver = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
    const none: Resolver = async () => [];
    const failing: Resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(resolveDestination(destination, publicOnly)).resolves.toEqual({ address: "93.184.216.34", family: 4 });
    await expect(resolveDestination(destination, mixed)).rejects.toMatchObject({ problem: "ADDRESS_NOT_PUBLIC" });
    await expect(resolveDestination(destination, none)).rejects.toMatchObject({ problem: "HOST_UNRESOLVABLE" });
    await expect(resolveDestination(destination, failing)).rejects.toMatchObject({ problem: "HOST_UNRESOLVABLE" });
  });

  it("allows a local fixture only when the operator listed exactly that origin", async () => {
    const allowlist = ["http://127.0.0.1:4010"];
    const fixture = parseDestination("http://127.0.0.1:4010/hook", allowlist);
    expect(fixture.testFixture).toBe(true);
    await expect(resolveDestination(fixture, async () => [])).resolves.toBeNull();
    expect(problemOf(() => parseDestination("http://127.0.0.1:4011/hook", allowlist))).toBe("SCHEME_NOT_HTTPS");
    expect(problemOf(() => parseDestination("http://127.0.0.1.evil.example.com:4010/hook", allowlist))).toBe("SCHEME_NOT_HTTPS");
    expect(problemOf(() => parseDestination("http://user@127.0.0.1:4010/hook", allowlist))).toBe("CREDENTIALS_IN_URL");
  });
});

describe("webhook signature (U-EVT-01, U-EVT-02, I-49)", () => {
  const secret = "whsec_synthetic-test-secret";
  const body = '{"id":"evt_1","type":"payment.status_changed","data":{"state":"SETTLED"}}';
  const now = 1_800_000_000;
  const headers = (timestamp = now) => ({ timestampHeader: String(timestamp), signatureHeader: signWebhook(secret, timestamp, body) });

  it("verifies the exact raw body within the time window", () => {
    expect(verifyWebhookSignature({ secret, rawBody: body, nowSeconds: now, ...headers() })).toBe("OK");
    expect(verifyWebhookSignature({ secret, rawBody: body, nowSeconds: now + 300, ...headers() })).toBe("OK");
  });
  it("rejects a changed body — even re-serialized JSON with the same meaning", () => {
    expect(verifyWebhookSignature({ secret, rawBody: `${body} `, nowSeconds: now, ...headers() })).toBe("BAD_SIGNATURE");
    expect(verifyWebhookSignature({ secret, rawBody: JSON.stringify(JSON.parse(body), null, 1), nowSeconds: now, ...headers() })).toBe("BAD_SIGNATURE");
  });
  it("rejects a wrong secret, a stale or future timestamp and missing headers", () => {
    expect(verifyWebhookSignature({ secret: "whsec_other", rawBody: body, nowSeconds: now, ...headers() })).toBe("BAD_SIGNATURE");
    expect(verifyWebhookSignature({ secret, rawBody: body, nowSeconds: now + 301, ...headers() })).toBe("STALE_TIMESTAMP");
    expect(verifyWebhookSignature({ secret, rawBody: body, nowSeconds: now - 301, ...headers() })).toBe("STALE_TIMESTAMP");
    expect(verifyWebhookSignature({ secret, rawBody: body, nowSeconds: now, timestampHeader: undefined, signatureHeader: headers().signatureHeader })).toBe("MISSING_HEADERS");
    expect(verifyWebhookSignature({ secret, rawBody: body, nowSeconds: now, timestampHeader: "soon", signatureHeader: headers().signatureHeader })).toBe("MISSING_HEADERS");
    // A timestamp that was itself changed no longer matches the signature.
    expect(verifyWebhookSignature({ secret, rawBody: body, nowSeconds: now, timestampHeader: String(now - 10), signatureHeader: headers().signatureHeader })).toBe("BAD_SIGNATURE");
  });
  it("retries on the documented schedule (U-EVT-03)", () => {
    expect([...RETRY_SCHEDULE_SECONDS]).toEqual([10, 30, 120, 600, 3600]);
  });
});

describe("stored secrets", () => {
  it("round-trips under the key and fails closed on tampering or a wrong key", () => {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const sealed = sealSecret(key, "whsec_value");
    expect(sealed).not.toContain("whsec_value");
    expect(sealSecret(key, "whsec_value")).not.toBe(sealed);
    expect(openSecret(key, sealed)).toBe("whsec_value");
    expect(() => openSecret(crypto.getRandomValues(new Uint8Array(32)), sealed)).toThrow();
    const parts = sealed.split(":");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => openSecret(key, parts.join(":"))).toThrow();
  });
});
