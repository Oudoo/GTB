/**
 * Per-request ambient state (AsyncLocalStorage): the correlation ID for logs, and the pending
 * idempotency record that the first business transaction of the request must complete
 * atomically with its own changes (PAY-04, document 04).
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type PendingIdempotency = {
  recordId: string;
  responseStatus: number;
  /** Set once a committed transaction has marked the record COMPLETED. */
  completed: boolean;
};

export type RequestStore = {
  correlationId: string;
  idempotency?: PendingIdempotency;
};

const storage = new AsyncLocalStorage<RequestStore>();

export function runWithRequest<T>(store: RequestStore, fn: () => Promise<T>): Promise<T> {
  return storage.run(store, fn);
}

export function currentRequest(): RequestStore | undefined {
  return storage.getStore();
}

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}
