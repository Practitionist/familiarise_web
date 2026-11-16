/**
 * @jest-environment jsdom
 */
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ConductRemovalBodySchema } from "@/schemas/conduct-removal";

const toast = jest.fn();
jest.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));
jest.mock("@stream-io/video-react-sdk", () => ({
  useCall: () => ({ id: "call-1" }),
  useCallStateHooks: () => ({
    useParticipants: () => [
      { userId: "host-1", name: "Hannah", roles: [] },
      { userId: "learner-1", name: "Asha", roles: [] },
    ],
    useLocalParticipant: () => ({ userId: "host-1", roles: [] }),
    useCallCreatedBy: () => ({ id: "host-1" }),
  }),
}));

import { AttendeeModeration } from "@/app/meetings/[id]/components/AttendeeModeration";

class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  globalThis.ResizeObserver = NoopResizeObserver;
  window.matchMedia = (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  });
});

/** Radix renders a native select inside a form; choosing on it drives the same value. */
function chooseReason(value: string) {
  const native = document.querySelector("select");
  if (!native) throw new Error("no native select rendered");
  fireEvent.change(native, { target: { value } });
}

it("the in-room control sends a body the route's schema accepts, and holds Other until it says why", async () => {
  const fetchMock = jest.fn(
    async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify({ removed: true, caseReference: "SR-1" }), {
        status: 200,
      }),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  render(<AttendeeModeration eventTitle="Intro to SIPs" />);

  fireEvent.click(screen.getByTestId("remove-attendee-learner-1"));
  const submit = screen.getByRole("button", { name: "Remove" });
  expect(submit).toBeDisabled();

  chooseReason("OTHER");
  expect(submit).toBeDisabled();
  fireEvent.change(screen.getByLabelText(/^Note/), {
    target: { value: "Shared another learner's phone number" },
  });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);

  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  const [url, init] = fetchMock.mock.calls[0];
  expect(url).toBe("/api/meetings/call-1/remove");
  const sent = ConductRemovalBodySchema.safeParse(
    JSON.parse(String(init?.body)),
  );
  expect(sent.success && sent.data).toEqual({
    targetUserId: "learner-1",
    reason: "OTHER",
    note: "Shared another learner's phone number",
  });
  expect(
    ConductRemovalBodySchema.safeParse({
      targetUserId: "learner-1",
      reason: "OTHER",
    }).success,
  ).toBe(false);
});
