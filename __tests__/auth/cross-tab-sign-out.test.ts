/**
 * @jest-environment jsdom
 */

/**
 * Sign-out across tabs is one BroadcastChannel message: the signing-out tab
 * posts it once, after the server confirmed, and a receiving tab only clears
 * local state and navigates; it never calls sign-out again.
 */

const mockSignOut = jest.fn();
jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  signOut: (...a: unknown[]) => mockSignOut(...a),
}));
jest.mock("../../lib/stream/disconnect", () => ({
  __esModule: true,
  disconnectStreamClients: jest.fn(async () => {}),
}));
jest.mock("../../lib/observability/identity", () => ({
  __esModule: true,
  clearSentryIdentity: jest.fn(),
}));

type Listener = (event: MessageEvent<unknown>) => void;
const channels: FakeChannel[] = [];
const posted: unknown[] = [];

class FakeChannel {
  onmessage: Listener | null = null;
  closed = false;
  constructor(readonly name: string) {
    channels.push(this);
  }
  postMessage(data: unknown) {
    posted.push(data);
    for (const other of channels) {
      if (other !== this && !other.closed && other.name === this.name) {
        other.onmessage?.({ data } as MessageEvent<unknown>);
      }
    }
  }
  close() {
    this.closed = true;
  }
}

import {
  signInHref,
  signOutEverywhere,
  subscribeToSignOut,
} from "../../lib/auth/sign-out";

beforeAll(() => {
  (globalThis as { BroadcastChannel?: unknown }).BroadcastChannel = FakeChannel;
  // jsdom does not implement navigation; it only logs. Keep the output clean.
  jest.spyOn(console, "error").mockImplementation(() => {});
});

beforeEach(() => {
  channels.length = 0;
  posted.length = 0;
  mockSignOut.mockReset();
});

describe("cross-tab sign-out", () => {
  it("posts exactly one signed-out message, after the server confirmed", async () => {
    const received = jest.fn();
    const unsubscribe = subscribeToSignOut(received);
    mockSignOut.mockImplementation(
      ({ fetchOptions }: { fetchOptions: { onSuccess: () => void } }) =>
        fetchOptions.onSuccess(),
    );

    await signOutEverywhere("/auth/signin");

    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(posted).toEqual([{ type: "signed-out" }]);
    expect(received).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("does not broadcast when the server sign-out failed", async () => {
    mockSignOut.mockImplementation(
      ({ fetchOptions }: { fetchOptions: { onError: () => void } }) =>
        fetchOptions.onError(),
    );
    await signOutEverywhere("/auth/signin");
    expect(posted).toEqual([]);
  });

  it("ignores unrelated messages on the channel", () => {
    const received = jest.fn();
    const unsubscribe = subscribeToSignOut(received);
    new FakeChannel("auth").postMessage({ type: "something-else" });
    expect(received).not.toHaveBeenCalled();
    unsubscribe();
  });
});

describe("signInHref", () => {
  it("returns to the current page after a revocation", () => {
    window.history.pushState({}, "", "/dashboard/consultant/c1/home?tab=2");
    expect(signInHref("session-revoked")).toBe(
      "/auth/signin?reason=session-revoked&callbackUrl=%2Fdashboard%2Fconsultant%2Fc1%2Fhome%3Ftab%3D2",
    );
  });

  it("never loops back into /auth", () => {
    window.history.pushState({}, "", "/auth/signin");
    expect(signInHref()).toBe("/auth/signin");
  });
});
