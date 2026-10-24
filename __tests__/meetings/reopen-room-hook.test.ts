/**
 * A reopen reply naming the current call id means the room is not sealed yet:
 * the hook surfaces a retryable message instead of a no-op navigation.
 */
import { act, renderHook } from "@testing-library/react";

const replace = jest.fn();
jest.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { useReopenRoom } from "../../app/meetings/[id]/hooks/useReopenRoom";

const reply = (body: Record<string, unknown>) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });

beforeEach(() => replace.mockClear());

it("does not navigate to the same call id and releases the button", async () => {
  global.fetch = jest.fn(() =>
    reply({ reopened: false, streamCallId: "c1" }),
  ) as unknown as typeof fetch;
  const { result } = renderHook(() => useReopenRoom("c1"));
  await act(async () => {
    await result.current.reopenRoom();
  });
  expect(replace).not.toHaveBeenCalled();
  expect(result.current.isReopening).toBe(false);
  expect(result.current.reopenError).toMatch(/not marked as closed/);
});

it("navigates to a fresh call id", async () => {
  global.fetch = jest.fn(() =>
    reply({ reopened: true, streamCallId: "c1-r2" }),
  ) as unknown as typeof fetch;
  const { result } = renderHook(() => useReopenRoom("c1"));
  await act(async () => {
    await result.current.reopenRoom();
  });
  expect(replace).toHaveBeenCalledWith("/meetings/c1-r2");
});
