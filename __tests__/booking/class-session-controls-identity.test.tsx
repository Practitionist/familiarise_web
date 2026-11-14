/**
 * The class session doors are called with the caller's identity header, so the
 * server's `expectUser` check sees who is acting. The host reaches the cancel
 * door from the session's own row action, through one confirm dialog.
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
jest.mock("../../components/scheduling/SingleTimePicker", () => ({
  SingleTimePicker: (props: {
    onChange: (value: { startsAt: string; endsAt: string } | null) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        props.onChange({
          startsAt: "2099-12-10T06:00:00.000Z",
          endsAt: "2099-12-10T07:30:00.000Z",
        })
      }
    >
      pick make-up time
    </button>
  ),
}));

import {
  useClassSessionActions,
  type ClassSessionRow,
} from "../../components/appointments/detail/ClassSessionControls";

function Harness({ sessions }: Readonly<{ sessions: ClassSessionRow[] }>) {
  const actions = useClassSessionActions({
    appointmentId: "apt-1",
    classId: "class-1",
    consultantProfileId: "profile-1",
    role: "consultant",
    unitLabel: null,
    onChanged: jest.fn(),
    sessions,
  });
  return (
    <>
      {sessions.flatMap((s) =>
        actions.rowActions(s.id).map((a) => (
          <button key={a.key} type="button" onClick={a.onSelect}>
            {a.label}
          </button>
        )),
      )}
      {actions.notices}
      {actions.dialog}
    </>
  );
}

it("cancels a class session through the identity-carrying fetch", async () => {
  const startsAt = new Date(Date.now() + 3 * 86_400_000);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness
        sessions={[
          { id: "occ-1", ordinal: 1, startsAt, completionStatus: "SCHEDULED" },
        ]}
      />
    </QueryClientProvider>,
  );

  fireEvent.click(screen.getByRole("button", { name: "Cancel this session" }));
  const dialog = await screen.findByRole("alertdialog");
  fireEvent.click(
    Array.from(dialog.querySelectorAll("button")).find(
      (b) => b.textContent === "Cancel this session",
    )!,
  );

  await waitFor(() =>
    expect(mockFetchWithIdentity).toHaveBeenCalledWith(
      "/api/appointments/apt-1/occurrences/occ-1/cancel",
      expect.objectContaining({ method: "POST" }),
    ),
  );
});

it("offers no row action on a past or cancelled session", () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness
        sessions={[
          {
            id: "occ-past",
            ordinal: 1,
            startsAt: new Date(Date.now() - 86_400_000),
            completionStatus: "SCHEDULED",
          },
          {
            id: "occ-gone",
            ordinal: 2,
            startsAt: new Date(Date.now() + 86_400_000),
            completionStatus: "CANCELLED",
          },
        ]}
      />
    </QueryClientProvider>,
  );
  expect(
    screen.queryByRole("button", { name: "Cancel this session" }),
  ).toBeNull();
});

it("schedules a make-up at the picked instant, unchanged", async () => {
  mockFetchWithIdentity.mockClear();
  const cancelledAt = new Date(Date.now() - 86_400_000);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness
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
  // The cancelled session's row opens the make-up dialog.
  fireEvent.click(screen.getByRole("button", { name: "Schedule make-up" }));
  fireEvent.click(screen.getByRole("button", { name: "pick make-up time" }));
  const scheduleButtons = screen.getAllByRole("button", {
    name: "Schedule make-up",
  });
  fireEvent.click(scheduleButtons[scheduleButtons.length - 1]);
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
