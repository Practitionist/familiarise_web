/** A tagged-template `$executeRaw` call as its SQL (placeholders as `?`) and bound values. */
export function rawCall(call: unknown[]): { sql: string; values: unknown[] } {
  const [strings, ...values] = call as [readonly string[], ...unknown[]];
  return { sql: strings.join("?"), values };
}

/** The capture transaction's first two statements: its lock timeout, then the order's advisory lock. */
export function expectCaptureLockFirst(
  executeRaw: jest.Mock,
  orderId: string,
): void {
  expect(executeRaw.mock.calls.length).toBeGreaterThanOrEqual(2);
  const [timeout, lock] = executeRaw.mock.calls.slice(0, 2).map(rawCall);
  expect(timeout.sql).toContain("set_config('lock_timeout', ?, true)");
  expect(timeout.values).toEqual(["4000"]);
  expect(lock.sql).toContain("pg_advisory_xact_lock(hashtextextended(?, 42))");
  expect(lock.values).toEqual([`payment-capture:${orderId}`]);
}
