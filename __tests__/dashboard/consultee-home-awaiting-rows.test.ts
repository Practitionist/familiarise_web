/**
 * #1703 B5 — a request with no occurrence yet (awaiting approval, payment or
 * allocation) stays on the consultee Home's Upcoming strip with the same
 * state the Appointments page derives, instead of vanishing.
 */

import {
  getUpcomingEvents,
  processAllEvents,
} from "@/app/dashboard/consultee/[consulteeId]/(features)/home/event-processor";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";

const plan = {
  title: "Career review",
  consultantProfile: { user: { name: "Ethan", image: null } },
};

function events(
  partial: Partial<TConsulteeEventsResponse>,
): TConsulteeEventsResponse {
  return {
    consultations: [],
    subscriptions: [],
    webinars: [],
    classes: [],
    trials: [],
    ...partial,
  };
}

// The processor only reads the fields below; the full Prisma payload types
// are far wider, hence the mock narrowing.
function consultation(status: string, pendingPaymentUrl: string | null) {
  return {
    id: `c-${status}`,
    status,
    pendingPaymentUrl,
    consultationPlan: plan,
    appointment: null,
  } as unknown as TConsulteeEventsResponse["consultations"][number];
}

describe("consultee Home keeps slot-less requests", () => {
  it("a fresh PENDING consultation renders as awaiting approval", () => {
    const [row] = processAllEvents(
      events({ consultations: [consultation("PENDING", null)] }),
    );
    expect(row).toEqual(
      expect.objectContaining({
        needsActionReason: "PENDING_APPROVAL",
        startsAt: null,
        joinableAppointment: undefined,
      }),
    );
    expect(getUpcomingEvents([row])).toHaveLength(1);
  });

  it("an approved-but-unpaid consultation carries its pay link", () => {
    const [row] = processAllEvents(
      events({
        consultations: [
          consultation("APPROVED_PENDING_PAYMENT", "https://pay.example/x"),
        ],
      }),
    );
    expect(row.needsActionReason).toBe("PAY_NOW");
    expect(row.pendingPaymentUrl).toBe("https://pay.example/x");
  });

  it("a paid subscription with a wrapper and no occurrence awaits scheduling", () => {
    const subscription = {
      id: "s-1",
      status: "APPROVED",
      pendingPaymentUrl: null,
      subscriptionPlan: plan,
      appointment: { id: "a-1", organizationId: null, occurrences: [] },
    } as unknown as TConsulteeEventsResponse["subscriptions"][number];
    const [row] = processAllEvents(events({ subscriptions: [subscription] }));
    expect(row.needsActionReason).toBe("UNSCHEDULED");
    expect(row.appointmentId).toBe("a-1");
  });

  it("a terminal request without slots still stays off Home", () => {
    expect(
      processAllEvents(
        events({ consultations: [consultation("REJECTED", null)] }),
      ),
    ).toHaveLength(0);
  });
});
