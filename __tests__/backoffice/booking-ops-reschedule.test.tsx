import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { BookingOpsView } from "../../lib/backoffice/booking-ops-types";

const mockSurfaces = new Set<string>(["appointments.manage"]);
jest.mock(
  "../../components/dashboard/backoffice/BackofficeCapabilityProvider",
  () => ({
    useBackofficeCapability: () => ({
      basePath: "/dashboard/staff",
      can: (surface: string) => mockSurfaces.has(surface),
    }),
  }),
);
jest.mock(
  "../../components/dashboard/backoffice/money/BookingDocumentsOps",
  () => ({ BookingDocumentsOps: () => null }),
);
jest.mock(
  "../../components/dashboard/backoffice/money/ClassSeriesDoors",
  () => ({
    ClassSeriesDoors: () => null,
  }),
);
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: jest.fn() }),
}));
const mockFetchWithReauth = jest.fn();
jest.mock("../../lib/auth/reauth-client", () => ({
  fetchWithReauth: (...args: unknown[]) => mockFetchWithReauth(...args),
}));

import { BookingOpsPanel } from "../../components/dashboard/backoffice/money/BookingOpsPanel";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";
const DAY = 24 * 60 * 60 * 1000;

function session(
  id: string,
  ordinal: number,
  offsetMs: number,
  completionStatus: BookingOpsView["sessions"][number]["completionStatus"] = "SCHEDULED",
) {
  const startsAt = new Date(Date.now() + offsetMs);
  return {
    id,
    ordinal,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000).toISOString(),
    completionStatus,
    outcome: null,
  };
}

function view(overrides: Partial<BookingOpsView> = {}): BookingOpsView {
  return {
    appointmentId: APPT,
    type: "SUBSCRIPTION",
    classId: null,
    subscriptionId: "sub-1",
    sessions: [
      session("past-1", 1, -2 * DAY, "COMPLETED"),
      session("next-2", 2, 3 * DAY),
    ],
    payments: [],
    ...overrides,
  };
}

const originalFetch = global.fetch;
function serve(v: BookingOpsView) {
  global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => v });
}

function renderPanel() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <BookingOpsPanel appointmentId={APPT} />
    </QueryClientProvider>,
  );
}

async function confirmWithReason() {
  fireEvent.change(
    await screen.findByLabelText("Reason (kept in the audit log)"),
    {
      target: { value: "Expert asked to move it" },
    },
  );
  fireEvent.click(screen.getByRole("button", { name: "Release" }));
  await waitFor(() => expect(mockFetchWithReauth).toHaveBeenCalled());
  const [url, init] = mockFetchWithReauth.mock.calls[0] as [
    string,
    { body: string },
  ];
  return { url, body: JSON.parse(init.body) as Record<string, unknown> };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSurfaces.clear();
  mockSurfaces.add("appointments.manage");
  mockFetchWithReauth.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { success: true } }),
  });
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("BookingOpsPanel reschedule door", () => {
  it("releases the whole booking through the staff door with a reason", async () => {
    serve(view());
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Reschedule booking" }),
    );
    const { url, body } = await confirmWithReason();
    expect(url).toBe(`/api/staff/appointments/${APPT}/reschedule`);
    expect(body).toEqual({ reason: "Expert asked to move it" });
  });

  it("releases one live session of a subscription, and offers none for a past one", async () => {
    serve(view());
    renderPanel();
    const perSession = await screen.findAllByRole("button", {
      name: "Reschedule",
    });
    expect(perSession).toHaveLength(1);
    fireEvent.click(perSession[0]);
    const { url, body } = await confirmWithReason();
    expect(url).toBe(`/api/staff/appointments/${APPT}/reschedule`);
    expect(body).toEqual({
      slotIds: ["next-2"],
      reason: "Expert asked to move it",
    });
  });

  it("offers no per-session release on a consultation", async () => {
    serve(view({ type: "CONSULTATION", subscriptionId: null }));
    renderPanel();
    expect(
      await screen.findByRole("button", { name: "Reschedule booking" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reschedule" })).toBeNull();
  });

  it("hides the door when no session still holds a future time", async () => {
    serve(view({ sessions: [session("past-1", 1, -2 * DAY, "COMPLETED")] }));
    renderPanel();
    await screen.findByText("Sessions");
    expect(screen.queryByRole("button", { name: /Reschedule/ })).toBeNull();
  });

  it("hides the door from a viewer without appointments.manage", async () => {
    mockSurfaces.clear();
    serve(view());
    renderPanel();
    await screen.findByText("Sessions");
    expect(screen.queryByRole("button", { name: /Reschedule/ })).toBeNull();
  });

  it("says the expert places the new time after a release, and that nothing puts the old one back", async () => {
    serve(view());
    renderPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Reschedule booking" }),
    );
    const copy = await screen.findByText(/Releases every live session/);
    expect(copy).toHaveTextContent(
      "This only releases the time: the expert places the new time",
    );
    expect(copy).toHaveTextContent(
      "The original time is not put back on its own",
    );
    expect(copy.textContent).not.toMatch(/customer picks/i);
  });
});
