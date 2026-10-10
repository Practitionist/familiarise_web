/**
 * @jest-environment jsdom
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mockGetSession = jest.fn();
jest.mock("../../lib/auth-client", () => ({
  __esModule: true,
  authClient: { getSession: () => mockGetSession() },
}));
const mockForget = jest.fn();
jest.mock("../../lib/auth-remembered", () => ({
  forgetAuthState: () => mockForget(),
}));
const mockReplace = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
}));

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSignedInRedirect } from "@/app/auth/useSignedInRedirect";

type StoreUser = Parameters<typeof useSignedInRedirect>[0];

let container: HTMLDivElement;
let root: Root;
const refetch = jest.fn();
const targetFor = () => "/dashboard";

function Probe({ user }: { user: StoreUser }) {
  useSignedInRedirect(user, refetch, targetFor);
  return null;
}

async function render(user: Record<string, unknown>) {
  await act(async () => {
    root.render(<Probe user={user as unknown as StoreUser} />);
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("useSignedInRedirect", () => {
  it("follows the fresh session to the page's target", async () => {
    mockGetSession.mockResolvedValue({
      data: { user: { id: "u1", role: "CONSULTEE" } },
      error: null,
    });
    await render({ id: "u1", role: "CONSULTEE" });
    expect(mockReplace).toHaveBeenCalledWith("/dashboard");
  });

  it("forgets a store user whose server session is gone instead of navigating", async () => {
    mockGetSession.mockResolvedValue({ data: null, error: null });
    await render({ id: "u1", role: "CONSULTEE" });
    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockForget).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("sends an operator without 2FA to enrolment", async () => {
    const operator = { id: "op", role: "STAFF", twoFactorEnabled: false };
    mockGetSession.mockResolvedValue({ data: { user: operator }, error: null });
    await render(operator);
    expect(mockReplace).toHaveBeenCalledWith("/auth/two-factor/setup");
  });
});
