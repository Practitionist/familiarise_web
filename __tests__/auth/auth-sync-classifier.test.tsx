/**
 * @jest-environment jsdom
 */

/**
 * AuthSyncProvider keeps a tab honest without ever turning "unknown" into
 * "signed out":
 * - only a confirmed revocation (401/403 from the identity ping) leaves, and
 *   it leaves without a second sign-out call;
 * - a different user id (store or ping) hard-reloads the tab;
 * - a sign-out broadcast from another tab is followed once;
 * - focus and bfcache restore revalidate as well as visibility.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockRefetch = jest.fn();
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
}));

const mockLeaveEndedSession = jest.fn(async () => {});
const mockFollowSignOutElsewhere = jest.fn(async () => {});
const mockReload = jest.fn();
let broadcastHandler: (() => void) | null = null;
jest.mock("../../lib/auth/sign-out", () => ({
  __esModule: true,
  leaveEndedSession: (...a: unknown[]) => mockLeaveEndedSession(...(a as [])),
  followSignOutElsewhere: () => mockFollowSignOutElsewhere(),
  reloadAsSignedInUser: () => mockReload(),
  signInHref: (reason?: string) =>
    `/auth/signin?reason=${reason}&callbackUrl=%2Fdashboard`,
  subscribeToSignOut: (handler: () => void) => {
    broadcastHandler = handler;
    return () => {
      broadcastHandler = null;
    };
  },
}));

const mockSetExpectedUser = jest.fn();
jest.mock("../../lib/auth/identity-header", () => ({
  __esModule: true,
  setExpectedUser: (id: string | null) => mockSetExpectedUser(id),
}));

jest.mock("../../lib/observability/identity", () => ({
  __esModule: true,
  setSentryIdentity: jest.fn(),
  clearSentryIdentity: jest.fn(),
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AuthSyncProvider from "../../providers/AuthSyncProvider";

function setVisible(visible: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    value: visible ? "visible" : "hidden",
    configurable: true,
  });
}

const okFor = (userId: string) => ({
  ok: true,
  status: 200,
  json: async () => ({ active: true, userId }),
});

describe("AuthSyncProvider", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    jest.clearAllMocks();
    mockSessionData = { user: { id: "u1" }, session: { id: "s-current" } };
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    setVisible(true);
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container.remove();
    global.fetch = realFetch;
    jest.useRealTimers();
  });

  async function mount(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<AuthSyncProvider />);
    });
  }

  async function settle(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function fire(target: EventTarget, event: Event): Promise<void> {
    jest.advanceTimersByTime(60_000);
    await act(async () => {
      target.dispatchEvent(event);
    });
    await settle();
  }

  it("names the page's user for money/IAM writes", async () => {
    await mount();
    expect(mockSetExpectedUser).toHaveBeenCalledWith("u1");
  });

  it.each([
    ["a 503 (lookup failed)", () => ({ ok: false, status: 503 })],
    ["a 500", () => ({ ok: false, status: 500 })],
  ])("does not leave on %s, and refetches", async (_label, response) => {
    fetchMock.mockResolvedValue(response());
    await mount();
    await fire(document, new Event("visibilitychange"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user/sessions/current",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(mockLeaveEndedSession).not.toHaveBeenCalled();
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("does not leave on a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await mount();
    await fire(document, new Event("visibilitychange"));
    expect(mockLeaveEndedSession).not.toHaveBeenCalled();
  });

  it.each([401, 403])(
    "leaves on a %s with the reason and callbackUrl, without a sign-out call",
    async (status) => {
      fetchMock.mockResolvedValue({ ok: false, status });
      await mount();
      await fire(document, new Event("visibilitychange"));
      expect(mockLeaveEndedSession).toHaveBeenCalledTimes(1);
      expect(mockLeaveEndedSession).toHaveBeenCalledWith(
        "/auth/signin?reason=session-revoked&callbackUrl=%2Fdashboard",
      );
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/sign-out"),
        expect.anything(),
      );
    },
  );

  it("revalidates on window focus and on a bfcache restore", async () => {
    fetchMock.mockResolvedValue(okFor("u1"));
    await mount();
    await fire(window, new Event("focus"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const restored = new Event("pageshow") as PageTransitionEvent;
    Object.defineProperty(restored, "persisted", { value: true });
    await act(async () => {
      window.dispatchEvent(restored);
    });
    await settle();
    // A bfcache restore skips the throttle.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockRefetch).toHaveBeenCalledTimes(2);
  });

  it("hard-reloads when the identity ping names another user", async () => {
    fetchMock.mockResolvedValue(okFor("u2"));
    await mount();
    await fire(window, new Event("focus"));
    expect(mockReload).toHaveBeenCalledTimes(1);
    expect(mockLeaveEndedSession).not.toHaveBeenCalled();
  });

  it("hard-reloads when the session store resolves another user", async () => {
    await mount();
    mockSessionData = { user: { id: "u2" }, session: { id: "s-other" } };
    await act(async () => {
      root?.render(<AuthSyncProvider />);
    });
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  it("follows another tab's sign-out once, with no second sign-out call", async () => {
    await mount();
    await act(async () => {
      broadcastHandler?.();
      broadcastHandler?.();
    });
    expect(mockFollowSignOutElsewhere).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("forgets a remembered session quietly on a public page", async () => {
    localStorage.setItem("familiarise.auth_authed", "true");
    mockSessionData = null;
    await mount();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLeaveEndedSession).not.toHaveBeenCalled();
    expect(localStorage.getItem("familiarise.auth_authed")).toBe("false");
  });

  it("does not probe while the tab is hidden", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await mount();
    setVisible(false);
    await fire(document, new Event("visibilitychange"));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockLeaveEndedSession).not.toHaveBeenCalled();
  });
});
