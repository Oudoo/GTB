/**
 * Outbound webhook transport. One POST, no redirects, bounded time and response size, and the
 * connection goes to the address the destination policy just validated (pinned), with the
 * original host name used only for TLS and the Host header.
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ResolvedAddress, Resolver } from "@/server/net/ssrf";

export type WebhookRequest = {
  url: URL;
  /** Validated address to connect to; null only for an operator-allowlisted test fixture. */
  address: ResolvedAddress | null;
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
  maxResponseBytes: number;
};

export type WebhookResponse = { status: number; snippet: string };

export interface WebhookTransport {
  send(request: WebhookRequest): Promise<WebhookResponse>;
}

export class WebhookTransportError extends Error {
  constructor(readonly code: "TIMEOUT" | "CONNECTION_FAILED") {
    super(code);
    this.name = "WebhookTransportError";
  }
}

export const systemResolver: Resolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true })).map((entry) => ({ address: entry.address, family: entry.family === 6 ? 6 : 4 }));

export class PinnedTransport implements WebhookTransport {
  send(input: WebhookRequest): Promise<WebhookResponse> {
    return new Promise((resolve, reject) => {
      const secure = input.url.protocol === "https:";
      const options = {
        method: "POST",
        host: input.address?.address ?? input.url.hostname,
        ...(input.address ? { family: input.address.family } : {}),
        port: input.url.port === "" ? (secure ? 443 : 80) : Number(input.url.port),
        path: `${input.url.pathname}${input.url.search}`,
        headers: { ...input.headers, host: input.url.host, "content-length": String(Buffer.byteLength(input.body)) },
        timeout: input.timeoutMs,
        // TLS is verified against the original host name, not the pinned address.
        ...(secure ? { servername: input.url.hostname } : {}),
      };
      const outgoing = (secure ? httpsRequest : httpRequest)(options, (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.byteLength;
          if (size <= input.maxResponseBytes) chunks.push(chunk);
          else response.destroy();
        });
        const finish = () => resolve({ status: response.statusCode ?? 0, snippet: Buffer.concat(chunks).toString("utf8").slice(0, input.maxResponseBytes) });
        response.on("end", finish);
        response.on("close", finish);
      });
      outgoing.on("timeout", () => outgoing.destroy(new WebhookTransportError("TIMEOUT")));
      outgoing.on("error", (error) => reject(error instanceof WebhookTransportError ? error : new WebhookTransportError("CONNECTION_FAILED")));
      outgoing.end(input.body);
    });
  }
}
