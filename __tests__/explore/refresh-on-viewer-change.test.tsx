/**
 * A plan page rendered for one viewer refreshes once when the client session
 * is someone else, and never loops when the server keeps rendering anonymously.
 */
import { renderHook } from "@testing-library/react";

const mockRefresh = jest.fn();
let mockSession: { data: { user: { id: string } } | null; isPending: boolean };

jest.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mockRefresh }),
}));
jest.mock("@/lib/auth-client", () => ({
  useSession: () => mockSession,
}));

import { useRefreshOnViewerChange } from "@/hooks/useRefreshOnViewerChange";

beforeEach(() => {
  mockRefresh.mockReset();
  mockSession = { data: null, isPending: true };
});

it("waits for the session, then refreshes once per mismatched pair", () => {
  const { rerender } = renderHook(
    ({ viewer }: { viewer: string | null }) => useRefreshOnViewerChange(viewer),
    { initialProps: { viewer: null as string | null } },
  );
  expect(mockRefresh).not.toHaveBeenCalled();

  mockSession = { data: { user: { id: "u-1" } }, isPending: false };
  rerender({ viewer: null });
  rerender({ viewer: null });
  expect(mockRefresh).toHaveBeenCalledTimes(1);

  rerender({ viewer: "u-1" });
  expect(mockRefresh).toHaveBeenCalledTimes(1);

  mockSession = { data: { user: { id: "u-2" } }, isPending: false };
  rerender({ viewer: "u-1" });
  expect(mockRefresh).toHaveBeenCalledTimes(2);
});
