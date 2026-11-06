import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockAllocateSlots = jest.fn();
jest.mock("../../lib/scheduling/allocationService", () => ({
  AllocationService: {
    allocateSlots: (...args: unknown[]) => mockAllocateSlots(...args),
  },
}));
jest.mock("../../components/ui/use-toast", () => ({ toast: jest.fn() }));

import { MobileAutoSchedule } from "../../components/scheduling/MobileAutoSchedule";

const keyOf = (call: number): string =>
  (mockAllocateSlots.mock.calls[call][3] as { idempotencyKey: string })
    .idempotencyKey;

function renderDoor() {
  render(
    <MobileAutoSchedule
      eventType="subscription"
      eventId="sub-1"
      topUp
      onDone={jest.fn()}
    />,
  );
  return screen.getByRole("button");
}

beforeEach(() => mockAllocateSlots.mockReset());

it("frees the button and explains when the request throws", async () => {
  mockAllocateSlots.mockRejectedValueOnce(new Error("offline"));
  const button = renderDoor();
  fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "We couldn't reach the server",
  );
  expect(button).not.toBeDisabled();
});

it("retries an ambiguous 5xx under the same key", async () => {
  mockAllocateSlots.mockResolvedValue({
    success: false,
    httpStatus: 503,
    error: "Try again",
  });
  const button = renderDoor();
  fireEvent.click(button);
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await waitFor(() => expect(mockAllocateSlots).toHaveBeenCalledTimes(2));
  expect(keyOf(1)).toBe(keyOf(0));
});

it("retries an unreadable 200 under the same key", async () => {
  mockAllocateSlots.mockResolvedValue({ success: false, httpStatus: 200 });
  const button = renderDoor();
  fireEvent.click(button);
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await waitFor(() => expect(mockAllocateSlots).toHaveBeenCalledTimes(2));
  expect(keyOf(1)).toBe(keyOf(0));
});

it("starts a fresh key after a definite refusal", async () => {
  mockAllocateSlots.mockResolvedValue({
    success: false,
    httpStatus: 409,
    error: "No free times this week",
  });
  const button = renderDoor();
  fireEvent.click(button);
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await waitFor(() => expect(mockAllocateSlots).toHaveBeenCalledTimes(2));
  expect(keyOf(1)).not.toBe(keyOf(0));
});
