/**
 * A learner's trial cancel clicked on an unpaid screen: the held trial goes
 * through the real reader, mapper, adapter and dialog, the click sends
 * `expectedPaid: false` in the body the trial DELETE parses, and the door's
 * payment-landed refusal closes the dialog with "Your payment just went through".
 */

import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { projectRow } from "../fixtures/prisma-projection";
import { NOW, storedTrial } from "../fixtures/stored-bookings";

const mockToast = jest.fn();
jest.mock("next/navigation", () =>
  jest
    .requireActual("../fixtures/learner-adapter-mocks")
    .learnerNavigationModule(),
);
jest.mock("@/lib/auth-client", () =>
  jest
    .requireActual("../fixtures/learner-adapter-mocks")
    .learnerSessionModule(),
);
jest.mock("@/hooks/scheduling/useLazyJoinMeeting", () =>
  jest.requireActual("../fixtures/learner-adapter-mocks").lazyJoinModule(),
);
jest.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));
jest.mock("@/components/appointments/consultee/useEventActions", () => ({
  useEventActions: () => ({ handleCancelConfirm: jest.fn(), isLoading: false }),
}));

type Row = Record<string, unknown>;
const mockRows: Record<string, Row[]> = {};
const mockFind = (model: string) => (args: Row) =>
  Promise.resolve((mockRows[model] ?? []).map((r) => projectRow(r, args)));
jest.mock("@/lib/prisma", () => ({
  __esModule: true,
  default: {
    appointment: { findMany: () => Promise.resolve([]) },
    consulteeProfile: { findUnique: () => Promise.resolve({ userId: "u-l" }) },
    consultation: { findMany: () => Promise.resolve([]) },
    subscription: { findMany: () => Promise.resolve([]) },
    webinar: { findMany: () => Promise.resolve([]) },
    class: { findMany: () => Promise.resolve([]) },
    trial: { findMany: (a: Row) => mockFind("trial")(a) },
  },
}));
jest.mock("@/lib/appointments/report-anomalies", () => ({
  bookingAnomalies: () => [],
  scheduleAnomalyReport: () => undefined,
}));

import { readConsulteeEvents } from "@/lib/data/consultee-events-read";
import { mapConsulteeEvents } from "@/lib/appointments/map-consultee";
import type { AppointmentVM } from "@/lib/appointments/view-model";
import { useConsulteeAppointmentsAdapter } from "@/components/appointments/consultee/ConsulteeAppointmentsAdapter";
import type { TrialRefundQuote } from "@/lib/trials/cancellation";
import { TrialCancelBodySchema } from "@/schemas/trials";

const PAID_QUOTE: TrialRefundQuote = {
  paymentId: "pay-1",
  refundPct: 0,
  estimatedRefundPaise: 0,
  grossPaise: 10_000,
  refundablePaise: 10_000,
  currency: "INR",
  fundingRail: "GATEWAY",
  hoursUntilNextSession: 0.5,
  prorated: false,
  creditRestoresInFull: false,
  tierRefundPct: 0,
};

function Harness({ vm }: { vm: AppointmentVM }) {
  const adapter = useConsulteeAppointmentsAdapter();
  const cancel = adapter.overflowItems(vm).find((i) => i.key === "cancel");
  return (
    <>
      <button type="button" onClick={cancel?.onClick}>
        open cancel
      </button>
      {adapter.renderDialogs()}
    </>
  );
}

it("an unpaid screen sends expectedPaid: false and a landed payment closes the dialog on 'Your payment just went through'", async () => {
  mockRows.trial = [storedTrial(true)];
  const [vm] = mapConsulteeEvents(
    await readConsulteeEvents("cee-1", { kind: "personal" }),
    NOW,
  );
  // The body trial DELETE answers (pinned in __tests__/trials/trial-consultant-cancel.test.ts).
  const fetchMock = jest.fn().mockResolvedValue({
    ok: false,
    status: 409,
    json: async () => ({
      error:
        "Your payment just went through. Review the refund before you cancel.",
      code: "REFUND_QUOTE_CHANGED",
      quote: PAID_QUOTE,
    }),
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;

  render(
    <QueryClientProvider client={new QueryClient()}>
      <Harness vm={vm} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "open cancel" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel trial" }));

  await waitFor(() =>
    expect(mockToast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Your payment just went through" }),
    ),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("button", { name: "Cancel trial" }),
    ).not.toBeInTheDocument(),
  );
  const deletes = fetchMock.mock.calls.filter(
    ([, init]) => (init as RequestInit | undefined)?.method === "DELETE",
  );
  expect(deletes).toHaveLength(1);
  const [url, init] = deletes[0] as [string, RequestInit];
  expect(url).toBe("/api/trials/t-1");
  expect(TrialCancelBodySchema.parse(JSON.parse(String(init.body)))).toEqual({
    confirmedRefundPaise: 0,
    expectedPaid: false,
  });
  expect(mockToast).not.toHaveBeenCalledWith(
    expect.objectContaining({ title: "Trial cancelled" }),
  );
});
