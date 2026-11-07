/**
 * Home's "This month · personal" Sessions stat counts the learner's own
 * bookings by who paid, not by who hosts the plan: a seat an organization's
 * money bought on an independent expert's webinar belongs to the org dashboard.
 */

import {
  processAllEvents,
  sessionsThisMonth,
} from "@/app/dashboard/consultee/[consulteeId]/(features)/home/event-processor";
import type { TConsulteeEventsResponse } from "@/types/consultee-events";

const NOW = new Date("2026-11-10T04:00:00.000Z");
const ZONE = "Asia/Kolkata";

type Pay = { paymentMethod: string; paymentStatus: string };

// The processor reads only these fields; the Prisma payload types are wider.
function webinar(id: string, payment: Pay[]) {
  const appointmentId = `a-${id}`;
  return {
    id,
    status: "SCHEDULED",
    webinarPlan: {
      title: "Intro",
      consultantProfile: { user: { name: "Ethan", image: null } },
      collaborators: [],
    },
    appointment: {
      id: appointmentId,
      // The plan is not hosted by any organization.
      organizationId: null,
      payment: payment.map((p, i) => ({
        id: `p-${id}-${i}`,
        createdAt: NOW,
        ...p,
      })),
      occurrences: [
        {
          id: `o-${id}`,
          appointmentId,
          startsAt: new Date("2026-11-20T10:00:00.000Z"),
          endsAt: new Date("2026-11-20T11:00:00.000Z"),
          isTentative: false,
          completionStatus: null,
          meeting: null,
        },
      ],
    },
  } as unknown as TConsulteeEventsResponse["webinars"][number];
}

function count(webinars: TConsulteeEventsResponse["webinars"]): number {
  const events = processAllEvents(
    { consultations: [], subscriptions: [], webinars, classes: [], trials: [] },
    NOW,
  );
  return sessionsThisMonth(events, ZONE, NOW);
}

describe("Home's personal session count", () => {
  it("counts a seat the learner paid for by card", () => {
    expect(
      count([
        webinar("w1", [{ paymentMethod: "CARD", paymentStatus: "SUCCEEDED" }]),
      ]),
    ).toBe(1);
  });

  it.each(["WALLET", "INVOICE", "LICENSE"])(
    "leaves out a %s-funded seat on a plan no organization hosts",
    (rail) => {
      expect(
        count([
          webinar("w1", [{ paymentMethod: rail, paymentStatus: "SUCCEEDED" }]),
        ]),
      ).toBe(0);
    },
  );

  it("a failed org charge the learner then paid by card stays personal", () => {
    expect(
      count([
        webinar("w1", [
          { paymentMethod: "WALLET", paymentStatus: "FAILED" },
          { paymentMethod: "CARD", paymentStatus: "SUCCEEDED" },
        ]),
      ]),
    ).toBe(1);
  });
});
