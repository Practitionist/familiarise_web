/**
 * A booking page showing a pay prompt catches up with a capture made elsewhere:
 * on a return inside the app's 60 s fresh window, and by polling while it waits.
 * Any other booking keeps the stale-only focus refetch and never polls.
 */

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";

import { makeQueryClient } from "@/providers/ReactQueryProvider";
import {
  AWAITING_PAYMENT_POLL_MS,
  awaitsPayment,
  useAppointmentDetailQuery,
} from "@/components/appointments/detail/use-appointment-detail-query";
import type { TScopedAppointmentDetail } from "@/lib/data/appointment-detail";

const NOW = Date.now();
const startsAt = new Date(NOW + 2 * 24 * 3600_000);

/** The detail route's shape for a paid trial, before and after its capture. */
function trialDetail(paid: boolean): TScopedAppointmentDetail {
  return {
    appointment: {
      id: "appt-1",
      appointmentType: "TRIAL",
      organizationId: null,
      organization: null,
      deletedAt: null,
      consultation: null,
      subscription: null,
      webinar: null,
      class: null,
      trial: {
        id: "trial-1",
        status: paid ? "SCHEDULED" : "AWAITING_PAYMENT",
        requestedAt: new Date(NOW - 600_000),
        createdAt: new Date(NOW - 600_000),
        paymentDueAt: paid ? null : new Date(NOW + 23 * 3600_000),
        subscriptionPlan: { trialPriceInPaise: 11_300, priceCurrency: "INR" },
      },
      payment: [
        {
          id: "pay-1",
          userId: "u-buyer",
          amount: 11_300,
          taxAmount: 1_724,
          currency: "INR",
          paymentStatus: paid ? "SUCCEEDED" : "PENDING",
          paymentMethod: "netbanking",
          paymentGateway: "RAZORPAY",
          receiptUrl: null,
          createdAt: new Date(NOW - 600_000),
          expiresAt: new Date(NOW + 23 * 3600_000),
          organizationId: null,
          consumerInvoice: null,
          legs: [],
          refunds: [],
          disputes: [],
          childPayments: [],
        },
      ],
      occurrences: [
        {
          id: "occ-1",
          appointmentId: "appt-1",
          startsAt,
          endsAt: new Date(startsAt.getTime() + 1800_000),
          isTentative: !paid,
          completionStatus: "SCHEDULED",
          deletedAt: null,
          meeting: null,
        },
      ],
      participants: [],
      rescheduleRequests: [],
      statusHistory: [],
    },
  } as unknown as TScopedAppointmentDetail;
}

let container: HTMLDivElement;
let root: Root;
let seen: TScopedAppointmentDetail | undefined;
const fetchMock = jest.fn();

function Probe() {
  seen = useAppointmentDetailQuery("appt-1", "consultee", "u-buyer").data;
  return null;
}

/** Mount with the server-seeded read, as the page's HydrationBoundary does. */
async function mountWith(seed: TScopedAppointmentDetail) {
  const client = makeQueryClient();
  client.setQueryData(["appointment-detail", "appt-1"], seed);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
}

/** Settle the fetch and the library's setTimeout(0) notify batch. */
async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i++) await jest.advanceTimersByTimeAsync(0);
  });
}

/** The buyer leaves the tab and comes back. */
async function returnToTab() {
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
  });
  await flush();
}

async function advance(ms: number) {
  await act(async () => {
    await jest.advanceTimersByTimeAsync(ms);
  });
  await flush();
}

beforeEach(() => {
  jest.useFakeTimers();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    ok: true,
    json: async () => ({ data: trialDetail(true) }),
  });
  global.fetch = fetchMock as unknown as typeof fetch;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  focusManager.setFocused(undefined);
  delete (global as { fetch?: unknown }).fetch;
  jest.useRealTimers();
});

it("reads the fixtures as the screen does: pay prompt before the capture, none after", () => {
  expect(awaitsPayment(trialDetail(false), "consultee", "u-buyer")).toBe(true);
  expect(awaitsPayment(trialDetail(true), "consultee", "u-buyer")).toBe(false);
});

it("a booking awaiting payment, returned to inside the fresh window, refetches and ends confirmed", async () => {
  await mountWith(trialDetail(false));
  await advance(5_000);
  await returnToTab();

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledWith("/api/appointments/appt-1");
  expect(awaitsPayment(seen, "consultee", "u-buyer")).toBe(false);

  // Confirmed now, so the poll stops.
  await advance(AWAITING_PAYMENT_POLL_MS * 4);
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("a booking awaiting payment catches up without the buyer leaving the tab", async () => {
  await mountWith(trialDetail(false));
  // One poll, plus a second for the read to land.
  await advance(AWAITING_PAYMENT_POLL_MS + 1_000);

  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(awaitsPayment(seen, "consultee", "u-buyer")).toBe(false);
});

it("a confirmed booking, returned to inside the fresh window, neither refetches nor polls", async () => {
  await mountWith(trialDetail(true));
  await advance(5_000);
  await returnToTab();
  await advance(AWAITING_PAYMENT_POLL_MS * 2);

  expect(fetchMock).not.toHaveBeenCalled();
});
