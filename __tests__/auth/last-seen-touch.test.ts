/**
 * @jest-environment node
 */

/**
 * `touchSessionLastSeen` (#1856) — the throttled `lastSeenAt` write.
 * Two throttle layers: in-process map (at most one query per session per
 * 5 min per lambda — production runs PG_POOL_MAX=1) and a SQL predicate
 * so concurrent touches across lambdas collapse into no-ops. Never
 * throws; a failed touch is re-attempted after the interval.
 */

const updateMany = jest.fn();
jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  // Closure, not shorthand: the factory runs before the const below is
  // initialized, so the reference must resolve at call time, not at
  // factory time (else "Cannot access before initialization").
  default: { session: { updateMany: (...a: unknown[]) => updateMany(...a) } },
}));

import {
  touchSessionLastSeen,
  LAST_SEEN_TOUCH_INTERVAL_MS,
  __resetLastSeenCacheForTests,
} from "../../lib/auth/last-seen";

beforeEach(() => {
  jest.clearAllMocks();
  __resetLastSeenCacheForTests();
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe("touchSessionLastSeen (#1856)", () => {
  it("writes lastSeenAt with a null-or-stale predicate", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    touchSessionLastSeen("s1");
    await flushMicrotasks();

    expect(updateMany).toHaveBeenCalledTimes(1);
    const [args] = updateMany.mock.calls[0] as [
      { where: { id: string; OR: unknown[] }; data: { lastSeenAt: Date } },
    ];
    expect(args.where.id).toBe("s1");
    expect(args.where.OR).toEqual([
      { lastSeenAt: null },
      { lastSeenAt: { lt: expect.any(Date) } },
    ]);
    expect(args.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("throttles repeat touches for the same session in-process", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    touchSessionLastSeen("s1");
    touchSessionLastSeen("s1");
    touchSessionLastSeen("s1");
    await flushMicrotasks();

    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("touches different sessions independently", async () => {
    updateMany.mockResolvedValue({ count: 1 });

    touchSessionLastSeen("s1");
    touchSessionLastSeen("s2");
    await flushMicrotasks();

    expect(updateMany).toHaveBeenCalledTimes(2);
  });

  it("re-touches after the interval elapses", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    const now = jest.spyOn(Date, "now");

    try {
      now.mockReturnValue(1_000_000);
      touchSessionLastSeen("s1");
      await flushMicrotasks();
      expect(updateMany).toHaveBeenCalledTimes(1);

      // Just inside the window: still throttled.
      now.mockReturnValue(1_000_000 + LAST_SEEN_TOUCH_INTERVAL_MS - 1);
      touchSessionLastSeen("s1");
      await flushMicrotasks();
      expect(updateMany).toHaveBeenCalledTimes(1);

      // Past the window: writes again.
      now.mockReturnValue(1_000_000 + LAST_SEEN_TOUCH_INTERVAL_MS + 1);
      touchSessionLastSeen("s1");
      await flushMicrotasks();
      expect(updateMany).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("never throws — a failed touch is swallowed for retry later", async () => {
    updateMany.mockRejectedValue(new Error("connect ETIMEDOUT"));

    expect(() => touchSessionLastSeen("s1")).not.toThrow();
    // Unhandled rejections fail the suite; prove the catch is wired.
    await flushMicrotasks();
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("ignores empty session ids", async () => {
    touchSessionLastSeen("");
    await flushMicrotasks();

    expect(updateMany).not.toHaveBeenCalled();
  });
});
