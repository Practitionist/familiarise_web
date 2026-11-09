/**
 * Client-side `Idempotency-Key`s for a submit button: a repeat of the same
 * payload reuses its key, so a double click or a retry after a lost response
 * replays the first answer; any change to the payload mints a new key.
 */
export function createSubmissionKeys(): (payload: unknown) => string {
  let last: { body: string; key: string } | null = null;
  return (payload) => {
    const body = JSON.stringify(payload ?? null);
    if (last?.body !== body) last = { body, key: crypto.randomUUID() };
    return last.key;
  };
}
