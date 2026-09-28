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
// Mutable session payload: most cases mount authed; the cold-tab and
// account-switch cases re-point it mid-test. Read lazily (closure) so
// the hoisted mock factory never touches the binding before init.
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
    mockSessionData = {
      user: { id: "u1" },
      session: { id: "s-current" },
    };
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

  it("visible-tab tick re-checks authoritatively without signing out a live session", async () => {
    // Quiet signal poll so only the 60s tick under test fires meaningfully.
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ signal: 7 }),
    });
    mockGetSession.mockResolvedValue({
      data: { user: { id: "u1" } },
      error: null,
    });

    await act(async () => {
      root = createRoot(container);
      root.render(<AuthSyncProvider />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(65_000);
    });

    // The tick ran the authoritative check...
    expect(mockGetSession).toHaveBeenCalledWith({
      query: { disableCookieCache: true },
    });
    // ...found the user alive, refetched to recover, stayed put.
    expect(mockRefetch).toHaveBeenCalled();
    expect(mockSignOutEverywhere).not.toHaveBeenCalled();
  });

  it("visible-tab tick signs out a revoked session with no focus event", async () => {
    (global.fetch as jest.Mock).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ signal: 7 }),
    });
    mockGetSession.mockResolvedValue({ data: null, error: null });

    await act(async () => {
      root = createRoot(container);
      root.render(<AuthSyncProvider />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(65_000);
    });

    expect(mockSignOutEverywhere).toHaveBeenCalledWith(
      "/auth/signin?reason=session-revoked",
    );
  });

  it("cold tab whose session died while away classifies on first resolution", async () => {
    // Laptop lid closed for days: remembered flag still true, session gone.
    window.localStorage.setItem("familiarise.auth_authed", "true");
    mockSessionData = null;
    mockGetSession.mockResolvedValue({ data: null, error: null });

    await mountAndTick();

    // Without the ref-seeding fix this stays at zero: the classifier
    // reads the still-undefined ref as "never authed" and aborts.
    expect(mockGetSession).toHaveBeenCalledWith({
      query: { disableCookieCache: true },
    });
    expect(mockSignOutEverywhere).toHaveBeenCalledWith(
      "/auth/signin?reason=session-revoked",
    );
  });

  it("same-profile sign-in as another account pings peers and resets the cursor", async () => {
    window.sessionStorage.setItem("familiarise.auth_revsig", "9");
    await mountAndTick();
    window.localStorage.removeItem("familiarise.auth");

    // Same browser, second sign-in — the shared jar now belongs to u2.
    mockSessionData = {
      user: { id: "u2" },
      session: { id: "s-other" },
    };
    await act(async () => {
      root?.render(<AuthSyncProvider />);
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(100);
    });

    // Peers told to refetch to the new account...
    const ping = window.localStorage.getItem("familiarise.auth");
    expect(ping).not.toBeNull();
    expect(JSON.parse(ping as string).type).toBe("login");
    // ...and the old account's cursor dropped (its counter values would
    // wedge this tab's poll silent forever).
    expect(window.sessionStorage.getItem("familiarise.auth_revsig")).toBeNull();
  });
});
