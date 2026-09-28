/**
 * @jest-environment jsdom
 */

/**
 * Visible-tab revalidation cadence + the focus/BroadcastChannel triggers
 * (#1856, review follow-up).
 *
 * Split from `auth-sync-revocation-poll.test.tsx` on purpose: that file
 * sets the opt-in poll to 40ms, so advancing the clock past the visible
 * tick's cadence there would run thousands of poll iterations. The poll
 * and the tick are independent mechanisms and deserve independent tests.
 *
 * What this pins, all of which was previously unasserted:
 *   - the tick is MINUTES, not 60s (a silent revert to 60s means ~4
 *     uncached Prisma round trips per visible tab per minute, and
 *     `React.cache` does not apply because the call goes over HTTP)
 *   - the tick keeps firing on that longer cadence
 *   - `visibilitychange` re-checks, and skips while hidden
 *   - the 30s focus throttle the visibility handler owns
 *   - the `session-revoked` BroadcastChannel ping, the FASTEST
 *     same-browser route, which had no coverage at either end
 */

process.env.NEXT_PUBLIC_SESSION_REVOCATION_POLL_MS = "0";
// React 18 wants this before any `act`; without it every render logs a
// "not configured to support act(...)" warning that drowns real output.
(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockRefetch = jest.fn();
const mockGetSession = jest.fn();
let mockSessionData: unknown = {
  user: { id: "u1" },
  session: { id: "s-current" },
};
jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  useSession: () => ({
    data: mockSessionData,
    isPending: false,
    refetch: (...a: unknown[]) => mockRefetch(...a),
  }),
  getSession: (...a: unknown[]) => mockGetSession(...a),
}));

const mockSignOutEverywhere = jest.fn();
jest.mock("../../lib/auth/sign-out", () => ({
  __esModule: true,
  signOutEverywhere: (...a: unknown[]) => mockSignOutEverywhere(...a),
}));

jest.mock("@sentry/nextjs", () => ({
  captureException: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
// Real, not mocked — the BroadcastChannel branch under test lives here.
import { postAuthSync } from "../../lib/auth-broadcast";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AuthSyncProvider = require("../../providers/AuthSyncProvider")
  .default as () => JSX.Element | null;

const VISIBLE_CHECK_INTERVAL_MS = 5 * 60_000;
const VISIBLE_CHECK_JITTER_MS = 60_000;
const CHECK_THROTTLE_MS = 30_000;

/** The provider draws its cadence with `Math.random`; pin it so a
 *  "has it fired yet" probe is exact rather than a coin flip. */
function pinJitter(): void {
  jest.spyOn(Math, "random").mockReturnValue(0.5);
}

function setVisible(visible: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    value: visible ? "visible" : "hidden",
    configurable: true,
  });
}

function dispatchVisibilityChange(): void {
  document.dispatchEvent(new Event("visibilitychange"));
}

/**
 * jsdom has no `BroadcastChannel`, so without this the production branch
 * is never exercised: `postAuthSync` falls back to the localStorage ping
 * and a `storage` event does not fire in the tab that wrote it.
 *
 * Installed per-test, not in `jest.setup.ts`: the account-switch case in
 * the poll suite asserts on that fallback and only passes BECAUSE jsdom
 * lacks the channel. A global polyfill would silently change what it
 * means.
 */
function installBroadcastChannel(): () => void {
  const registry = new Map<string, Set<TestBroadcastChannel>>();
  const host = globalThis as { BroadcastChannel?: unknown };
  const original = host.BroadcastChannel;
  const hadOriginal = "BroadcastChannel" in host;

  class TestBroadcastChannel {
    private closed = false;
    private readonly handlers = new Set<(e: MessageEvent) => void>();
    constructor(readonly name: string) {
      const set = registry.get(name) ?? new Set<TestBroadcastChannel>();
      set.add(this);
      registry.set(name, set);
    }
    postMessage(data: unknown): void {
      for (const peer of registry.get(this.name) ?? []) {
        if (peer === this || peer.closed) continue;
        const event = new MessageEvent("message", { data });
        for (const handler of peer.handlers) handler(event);
      }
    }
    addEventListener(_type: string, handler: (e: MessageEvent) => void): void {
      this.handlers.add(handler);
    }
    removeEventListener(
      _type: string,
      handler: (e: MessageEvent) => void,
    ): void {
      this.handlers.delete(handler);
    }
    close(): void {
      this.closed = true;
      this.handlers.clear();
      registry.get(this.name)?.delete(this);
    }
  }

  host.BroadcastChannel = TestBroadcastChannel;
  return () => {
    // `delete`, not assignment: `postAuthSync` probes with
    // `"BroadcastChannel" in window`, so restoring `undefined` leaves the
    // key present and keeps the channel branch alive for later tests.
    if (hadOriginal) host.BroadcastChannel = original;
    else delete host.BroadcastChannel;
  };
}

describe("visible-tab revalidation cadence (#1856 review)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const realFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    setVisible(true);
    window.localStorage.clear();
    window.sessionStorage.clear();
    mockSessionData = {
      user: { id: "u1" },
      session: { id: "s-current" },
    };
    container = document.createElement("div");
    document.body.appendChild(container);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ signal: 7 }),
    });
    pinJitter();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    jest.useRealTimers();
    // Restores the Math.random spy; clearAllMocks alone would leave it
    // returning 0.5 for every later test.
    jest.restoreAllMocks();
    global.fetch = realFetch;
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<AuthSyncProvider />);
    });
  }

  async function advance(ms: number): Promise<void> {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  }

  it("runs the authoritative check on the minutes-long cadence", async () => {
    mockGetSession.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });

    await mount();
    // The first fire is staggered by up to one jitter window.
    await advance(VISIBLE_CHECK_JITTER_MS + 1_000);

    expect(mockGetSession).toHaveBeenCalledWith({
      query: { disableCookieCache: true },
    });
    // A live session must NOT be signed out.
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
  });

  it("does NOT tick on a 60s cadence", async () => {
    // The regression this pins: at 60s every visible tab pays ~4
    // uncached Prisma round trips a minute, forever, with no
    // deduplication on the path (it goes over HTTP, so `React.cache`
    // never applies). Advancing one more minute after the first fire
    // must produce nothing.
    mockGetSession.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });

    await mount();
    await advance(VISIBLE_CHECK_JITTER_MS + 1_000);
    mockGetSession.mockClear();

    await advance(60_000);

    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("keeps ticking once the full interval elapses", async () => {
    mockGetSession.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });

    await mount();
    await advance(VISIBLE_CHECK_JITTER_MS + 1_000);
    mockGetSession.mockClear();

    await advance(VISIBLE_CHECK_INTERVAL_MS + VISIBLE_CHECK_JITTER_MS + 1_000);

    expect(mockGetSession).toHaveBeenCalledWith({
      query: { disableCookieCache: true },
    });
  });

  it("stays quiet while hidden and re-checks when the tab comes back", async () => {
    mockGetSession.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });

    await mount();
    await advance(1_000);
    mockGetSession.mockClear();

    setVisible(false);
    await advance(1_000);
    dispatchVisibilityChange();
    expect(mockGetSession).not.toHaveBeenCalled();

    setVisible(true);
    await advance(1_000);
    dispatchVisibilityChange();
    expect(mockGetSession).toHaveBeenCalledWith({
      query: { disableCookieCache: true },
    });
  });

  it("throttles the focus re-check to 30s", async () => {
    mockGetSession.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });

    await mount();
    await advance(1_000);
    mockGetSession.mockClear();

    dispatchVisibilityChange();
    expect(mockGetSession).toHaveBeenCalledTimes(1);

    // Inside the window: skipped. This check is expensive, and the
    // throttle is what stops a user alt-tabbing from hammering it.
    await advance(CHECK_THROTTLE_MS - 5_000);
    dispatchVisibilityChange();
    expect(mockGetSession).toHaveBeenCalledTimes(1);

    // Past the window: runs again.
    await advance(CHECK_THROTTLE_MS);
    dispatchVisibilityChange();
    expect(mockGetSession).toHaveBeenCalledTimes(2);
  });

  it("classifies a session-revoked ping from a peer tab immediately", async () => {
    const restore = installBroadcastChannel();
    mockGetSession.mockResolvedValue({ data: null, error: null });

    try {
      await mount();
      await advance(1_000);
      expect(mockSignOutEverywhere).not.toHaveBeenCalled();

      await act(async () => {
        postAuthSync({ type: "session-revoked", sessionId: "*" });
        await Promise.resolve();
      });

      expect(mockGetSession).toHaveBeenCalledWith({
        query: { disableCookieCache: true },
      });
      expect(mockSignOutEverywhere).toHaveBeenCalledWith(
        "/auth/signin?reason=session-revoked",
      );
    } finally {
      restore();
    }
  });

  it("a peer ping for a still-live session refetches instead of signing out", async () => {
    // The #1716 rule on the instant path: a ping means "something was
    // revoked", never "you were". A failed or empty check must never
    // produce a sign-out.
    const restore = installBroadcastChannel();
    mockGetSession.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });

    try {
      await mount();
      await advance(1_000);
      mockSignOutEverywhere.mockClear();
      mockRefetch.mockClear();

      await act(async () => {
        postAuthSync({ type: "session-revoked", sessionId: "s-other" });
        await Promise.resolve();
      });

      expect(mockRefetch).toHaveBeenCalled();
      expect(mockSignOutEverywhere).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("a peer ping whose re-check ERRORS must not sign out", async () => {
    // "A failed lookup is never a revocation" — the same rule the poll
    // path asserts for a 503. Here for the instant path.
    const restore = installBroadcastChannel();
    mockGetSession.mockRejectedValue(new Error("network down"));

    try {
      await mount();
      await advance(1_000);
      mockSignOutEverywhere.mockClear();

      await act(async () => {
        postAuthSync({ type: "session-revoked", sessionId: "*" });
        await Promise.resolve();
      });

      expect(mockSignOutEverywhere).not.toHaveBeenCalled();
      expect(mockRefetch).toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
