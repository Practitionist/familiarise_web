/**
 * @jest-environment jsdom
 */

/**
 * The client revocation check signs out ONLY on a confirmed revocation.
 *
 * Regression for the mass sign-out defect: BetterAuth's customSession answers
 * `/get-session` with `200 null` when the lookup itself fails, and the old
 * classifier read that null as "revoked" — so a database blip signed out
 * every open tab. The classifier now asks `/api/user/sessions/current`,
 * whose status codes separate the three cases.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockRefetch = jest.fn();
const mockSessionData: unknown = {
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

const mockSignOutEverywhere = jest.fn();
jest.mock("../../lib/auth/sign-out", () => ({
  __esModule: true,
  signOutEverywhere: (...a: unknown[]) => mockSignOutEverywhere(...a),
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

describe("AuthSyncProvider revocation classifier", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const realFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    mockRefetch.mockReset();
    mockSignOutEverywhere.mockReset();
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

  async function mountAndFocus(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<AuthSyncProvider />);
    });
    // Past the focus throttle, then a tab switch back.
    jest.advanceTimersByTime(60_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await Promise.resolve();
    });
  }

  it.each([
    ["a 503 (lookup failed)", () => ({ ok: false, status: 503 })],
    ["a 500", () => ({ ok: false, status: 500 })],
  ])("does not sign out on %s, and refetches", async (_label, response) => {
    fetchMock.mockResolvedValue(response());
    await mountAndFocus();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user/sessions/current",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
    expect(mockRefetch).toHaveBeenCalled();
  });

  it("does nothing on a 200 from a focus check", async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    await mountAndFocus();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/user/sessions/current",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it("does not sign out on a network error", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await mountAndFocus();
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
  });

  it.each([401, 403])("signs out on a %s", async (status) => {
    fetchMock.mockResolvedValue({ ok: false, status });
    await mountAndFocus();
    expect(mockSignOutEverywhere).toHaveBeenCalledWith(
      "/auth/signin?reason=session-revoked",
    );
  });

  it("does not probe while the tab is hidden", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    await act(async () => {
      root = createRoot(container);
      root.render(<AuthSyncProvider />);
    });
    fetchMock.mockClear();
    setVisible(false);
    jest.advanceTimersByTime(60_000);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(fetchMock).not.toHaveBeenCalledWith(
      "/api/user/sessions/current",
      expect.anything(),
    );
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
  });
});
