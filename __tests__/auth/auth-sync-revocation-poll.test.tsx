/**
 * @jest-environment jsdom
 */

/**
 * Revocation-poll failure classification (#1856, CodeRabbit #1857).
 *
 * When OUR session is revoked, `requireApiAuth()` answers the signal
 * poll with 401 before the route reads the counter — so the poll must
 * classify on 401/403 instead of returning quietly, or a visible tab
 * sits stale until the next focus event. Any other failure (503, 500,
 * network) is "could not ask", never a revocation (#1716): stay put.
 *
 * NOTE: the poll interval is read from the environment at module load,
 * so the provider is required (not imported) after setting it.
 */

process.env.NEXT_PUBLIC_SESSION_REVOCATION_POLL_MS = "40";

const mockRefetch = jest.fn();
const mockGetSession = jest.fn();
jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  useSession: () => ({
    data: { user: { id: "u1" }, session: { id: "s-current" } },
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

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AuthSyncProvider = require("../../providers/AuthSyncProvider")
  .default as () => JSX.Element | null;

const realFetch = global.fetch;

function setVisible(visible: boolean): void {
  Object.defineProperty(document, "visibilityState", {
    value: visible ? "visible" : "hidden",
    configurable: true,
  });
}

describe("revocation poll failure classification (#1856)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    setVisible(true);
    window.localStorage.clear();
    window.sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    jest.useRealTimers();
    global.fetch = realFetch;
  });

  async function mountAndTick(): Promise<void> {
    await act(async () => {
      root = createRoot(container);
      root.render(<AuthSyncProvider />);
    });
    // Mount effects (transition detection sets the authed ref) plus one
    // full poll interval.
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });
  }

  it("classifies 401 from the poll and signs out with the reason", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });
    // Authoritative re-check confirms the session is really gone.
    mockGetSession.mockResolvedValue({ data: null, error: null });

    await mountAndTick();

    expect(mockGetSession).toHaveBeenCalledWith({
      query: { disableCookieCache: true },
    });
    expect(mockSignOutEverywhere).toHaveBeenCalledWith(
      "/auth/signin?reason=session-revoked",
    );
  });

  it("stays put on 503 — a failed lookup is never a revocation", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    await mountAndTick();

    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it("a moved counter classifies and signs out", async () => {
    // First tick adopts the cursor; the move on the second tick fires.
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ signal: 3 }),
      })
      .mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ signal: 5 }),
      });
    mockGetSession.mockResolvedValue({ data: null, error: null });

    await mountAndTick();

    expect(mockGetSession).toHaveBeenCalledWith({
      query: { disableCookieCache: true },
    });
    expect(mockSignOutEverywhere).toHaveBeenCalledWith(
      "/auth/signin?reason=session-revoked",
    );
    // Cursor advanced past the observed value.
    expect(window.sessionStorage.getItem("familiarise.auth_revsig")).toBe("5");
  });

  it("a reset counter (Redis restart) never signs out", async () => {
    window.sessionStorage.setItem("familiarise.auth_revsig", "5");
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ signal: 2 }),
    });

    await mountAndTick();

    // Strictly-greater comparison: a dropped counter is adopted
    // silently... here it is simply ignored (cursor stays), and no
    // classifier runs.
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem("familiarise.auth_revsig")).toBe("5");
  });
});
