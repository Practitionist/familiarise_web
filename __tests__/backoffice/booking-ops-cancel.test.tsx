import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { BookingOpsView } from "../../lib/backoffice/booking-ops-types";

const mockSurfaces = new Set<string>();
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
const mockToast = jest.fn();
jest.mock("../../hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
const mockFetchWithReauth = jest.fn();
jest.mock("../../lib/auth/reauth-client", () => ({
  fetchWithReauth: (...args: unknown[]) => mockFetchWithReauth(...args),
}));

import { BookingOpsPanel } from "../../components/dashboard/backoffice/money/BookingOpsPanel";
import { PLATFORM_CANCEL_REFUSAL_COPY } from "../../components/dashboard/backoffice/money/PlatformCancelDoor";
import {
  STAFF_REFUND_PER_PAYMENT_PAISE,
  STAFF_REFUND_ROLLING_PAISE,
} from "../../lib/support/staff-refund-limits";
import { formatCurrencyAmount } from "../../utils/formatting";

const APPT = "8b2f6c1e-1d2a-4f3b-9c4d-5e6f7a8b9c0d";
const DAY = 24 * 60 * 60 * 1000;

function session(
  id: string,
  offsetMs: number,
  completionStatus: BookingOpsView["sessions"][number]["completionStatus"] = "SCHEDULED",
) {
  const startsAt = new Date(Date.now() + offsetMs);
  return {
    id,
    ordinal: 1,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 30 * 60 * 1000).toISOString(),
    completionStatus,
    outcome: null,
  };
}

function view(overrides: Partial<BookingOpsView> = {}): BookingOpsView {
  return {
    appointmentId: APPT,
    type: "CONSULTATION",
    classId: null,
    subscriptionId: null,
    sessions: [session("next-1", 3 * DAY)],
    payments: [],
    removedSeats: [],
    ...overrides,
  };
}

const QUOTE = {
  refundPct: 100,
  estimatedRefundPaise: 250_000,
  currency: "INR",
  hoursUntilNextSession: 72,
  prorated: false,
  fundingRail: "GATEWAY",
  creditRestoresInFull: false,
};

const originalFetch = global.fetch;
function serve(v: BookingOpsView, preview: unknown = QUOTE) {
  global.fetch = jest.fn().mockImplementation(async (url: string) => ({
    ok: true,
    json: async () => (url.endsWith("/cancel/preview") ? preview : v),
  }));
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

async function openCancel() {
  fireEvent.click(
    await screen.findByRole("button", { name: "Cancel booking" }),
  );
  fireEvent.change(
    await screen.findByLabelText("Reason (kept in the audit log)"),
    { target: { value: "Expert left the platform" } },
  );
}

function confirmButton() {
  return screen
    .getAllByRole("button", { name: "Cancel booking" })
    .find((b) => b.closest("[role='dialog']"))!;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSurfaces.clear();
  mockSurfaces.add("appointments.cancelForPlatform");
  mockFetchWithReauth.mockResolvedValue({
    ok: true,
    json: async () => ({ data: { success: true } }),
  });
});
afterEach(() => {
  global.fetch = originalFetch;
});

describe("BookingOpsPanel platform cancel", () => {
  it("shows the refund preview and cancels the whole booking through the staff door", async () => {
    serve(view());
    renderPanel();
    await openCancel();
    const line = `Refunds ${formatCurrencyAmount(250_000, "INR")} (100%).`;
    expect(
      await screen.findByText(
        (_, el) => el?.tagName === "P" && el.textContent === line,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/whole booking for everyone on it, not one session/),
    ).toBeInTheDocument();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(mockFetchWithReauth).toHaveBeenCalled());
    const [url, init] = mockFetchWithReauth.mock.calls[0] as [
      string,
      { body: string },
    ];
    expect(url).toBe(`/api/staff/appointments/${APPT}/cancel`);
    expect(JSON.parse(init.body)).toEqual({
      cancellationReason: "OTHER",
      expectedRefundPaise: 250_000,
      expectedCreditRestoresInFull: false,
      reason: "Expert left the platform",
    });
  });

  it("holds the confirm until the preview loads, and refuses without one", async () => {
    serve(view());
    global.fetch = jest
      .fn()
      .mockImplementation(async (url: string) =>
        url.endsWith("/cancel/preview")
          ? { ok: false, json: async () => ({}) }
          : { ok: true, json: async () => view() },
      );
    renderPanel();
    await openCancel();
    expect(
      await screen.findByText(/refund could not be estimated/),
    ).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
  });

  it.each(Object.entries(PLATFORM_CANCEL_REFUSAL_COPY))(
    "explains the staff cap refusal %s",
    async (code, copy) => {
      mockFetchWithReauth.mockResolvedValue({
        ok: false,
        json: async () => ({ error: "server words", code }),
      });
      serve(view());
      renderPanel();
      await openCancel();
      await waitFor(() => expect(confirmButton()).toBeEnabled());
      fireEvent.click(confirmButton());
      await waitFor(() =>
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Couldn't cancel booking",
            description: copy,
          }),
        ),
      );
    },
  );

  it("quotes the staff limits from the policy constants", () => {
    expect(PLATFORM_CANCEL_REFUSAL_COPY.ADMIN_REQUIRED).toContain(
      formatCurrencyAmount(STAFF_REFUND_PER_PAYMENT_PAISE, "INR"),
    );
    expect(PLATFORM_CANCEL_REFUSAL_COPY.STAFF_DAILY_LIMIT).toContain(
      formatCurrencyAmount(STAFF_REFUND_ROLLING_PAISE, "INR"),
    );
  });

  it("keeps the route's own message for any other refusal", async () => {
    mockFetchWithReauth.mockResolvedValue({
      ok: false,
      json: async () => ({ error: "Already cancelled.", code: "ILLEGAL" }),
    });
    serve(view());
    renderPanel();
    await openCancel();
    await waitFor(() => expect(confirmButton()).toBeEnabled());
    fireEvent.click(confirmButton());
    await waitFor(() =>
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({ description: "Already cancelled." }),
      ),
    );
  });

  it("is offered to a booking still awaiting its times", async () => {
    serve(view({ sessions: [] }));
    renderPanel();
    expect(
      await screen.findByRole("button", { name: "Cancel booking" }),
    ).toBeInTheDocument();
  });

  it("is hidden once no session holds a future time", async () => {
    serve(view({ sessions: [session("past-1", -2 * DAY, "COMPLETED")] }));
    renderPanel();
    await screen.findByText("Sessions");
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
  });

  it("is hidden from a viewer without appointments.cancelForPlatform", async () => {
    mockSurfaces.clear();
    serve(view());
    renderPanel();
    await screen.findByText("Sessions");
    expect(screen.queryByRole("button", { name: "Cancel booking" })).toBeNull();
  });
});
