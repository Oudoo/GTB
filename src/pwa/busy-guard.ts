/**
 * In-memory registry of "do not reload now" reasons: a dirty form, an open review or an
 * in-flight command. Nothing here is persisted (PWA-04); it only protects the person from a
 * forced reload or app update mid-action (PWA-07).
 */
const reasons = new Map<symbol, string>();

export function markBusy(reason: string): () => void {
  const token = Symbol(reason);
  reasons.set(token, reason);
  return () => {
    reasons.delete(token);
  };
}

export function hasUnsavedWork(): boolean {
  return reasons.size > 0;
}
