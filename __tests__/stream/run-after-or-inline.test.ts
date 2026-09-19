/**
 * @jest-environment node
 */

/**
 * #1589 M-P0-04 — `after()` throws synchronously outside a request scope (the
 * sweeper's tsx re-drive); the wrapper then runs the callback inline instead
 * of losing the transfer kick and the bell behind the idempotent early-return.
 */

const after = jest.fn();
jest.mock("next/server", () => ({ after: (fn: unknown) => after(fn) }));

import { runAfterOrInline } from "../../lib/stream/run-after-or-inline";

beforeEach(() => jest.clearAllMocks());

describe("runAfterOrInline", () => {
  it("hands the callback to after() inside a request scope", async () => {
    const fn = jest.fn(async () => undefined);
    await runAfterOrInline(fn);
    expect(after).toHaveBeenCalledWith(fn);
    expect(fn).not.toHaveBeenCalled();
  });

  it("runs the callback inline when after() has no request scope", async () => {
    after.mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope (E468)");
    });
    const fn = jest.fn(async () => undefined);
    await runAfterOrInline(fn);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
