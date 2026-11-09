/**
 * The class session doors are called with the caller's identity header, so the
 * server's `expectUser` check sees who is acting.
 */
import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockFetchWithIdentity = jest.fn(
  async (_url: string, _init?: RequestInit) =>
    new Response(JSON.stringify({}), { status: 200 }),
);
jest.mock("../../lib/auth/identity-header", () => ({
  fetchWithIdentity: (url: string, init?: RequestInit) =>
    mockFetchWithIdentity(url, init),
}));
jest.mock("../../lib/auth-client", () => ({
  useSession: () => ({ data: null }),
}));
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
jest.mock("../../components/scheduling/SingleSessionPicker", () => ({
  SingleSessionPicker: (props: { onChange: (iso: string | null) => void }) => (
    <button
      type="button"
      onClick={() => props.onChange("2099-12-10T06:00:00.000Z")}
    >
      pick make-up time
    </button>
  ),
}));

import { ClassSessionControls } from "../../components/appointments/detail/ClassSessionControls";

it("cancels a class session through the identity-carrying fetch", async () => {
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ClassSessionControls
        appointmentId="apt-1"
        consultantProfileId="profile-1"
        role="consultant"
        unitLabel={null}
        onChanged={jest.fn()}
        sessions={[
          {
            id: "occ-1",
            ordinal: 1,
            startsAt,
            completionStatus: "SCHEDULED",
          },
        ]}
      />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Cancel this session" }));
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel this session" }),
  );

  await waitFor(() =>
    expect(mockFetchWithIdentity).toHaveBeenCalledWith(
      "/api/appointments/apt-1/occurrences/occ-1/cancel",
      expect.objectContaining({ method: "POST" }),
    ),
  );
});

it("schedules a make-up at the picked instant, unchanged", async () => {
  mockFetchWithIdentity.mockClear();
  const cancelledAt = new Date(Date.now() - 86_400_000);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <ClassSessionControls
        appointmentId="apt-1"
        consultantProfileId="profile-1"
        role="consultant"
        unitLabel={null}
        onChanged={jest.fn()}
        sessions={[
          {
            id: "occ-1",
            ordinal: 1,
            startsAt: cancelledAt,
            endsAt: new Date(cancelledAt.getTime() + 90 * 60_000),
            completionStatus: "CANCELLED",
            hostCancelledAt: cancelledAt,
          },
        ]}
      />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "pick make-up time" }));
  fireEvent.click(screen.getByRole("button", { name: "Schedule make-up" }));
  await waitFor(() =>
    expect(mockFetchWithIdentity).toHaveBeenCalledWith(
      "/api/appointments/apt-1/occurrences/occ-1/make-up",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ startsAt: "2099-12-10T06:00:00.000Z" }),
      }),
    ),
  );
});
