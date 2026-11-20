/**
 * @jest-environment node
 */

// Invariant: an unpaid direct checkout is the buyer's purchase in flight. It is
// listed under "Waiting on them" as "Checkout in progress" with no action, and
// no requests-to-answer count includes it; a paid one is a real request.

jest.mock("../../lib/prisma", () => ({
  __esModule: true,
  default: {
    consultation: { findMany: jest.fn(), count: jest.fn() },
    subscription: { findMany: jest.fn(), count: jest.fn() },
    trial: { findMany: jest.fn(), count: jest.fn() },
    membership: { findMany: jest.fn() },
  },
}));

import prisma from "@/lib/prisma";
import { ANSWERABLE_CONSULTATION } from "@/lib/booking/request-cohort";
import { deriveBookingPresentation } from "@/lib/dashboard/money-state";
import {
  countRequestsToAnswer,
  pendingConsultationWhere,
  pendingSubscriptionWhere,
} from "@/lib/data/needs-you";
import { readRequestsInbox } from "@/lib/data/requests-inbox";
import { assertExpectedTentativeSlotCount } from "@/lib/booking/allocation/guards";
import { tentativeSlotCountOf } from "@/lib/booking/allocation/counts";
import type { AppointmentWithSlots } from "@/lib/booking/allocation/types";
import {
  isDialogFreeApproval,
  rowActions,
} from "@/components/dashboard/shared/requests/InboxRow";

import {
  CP,
  NOW,
  hoursAgo,
  hoursAhead,
  serve,
} from "../fixtures/requests-inbox";

const m = prisma as unknown as Record<string, Record<string, jest.Mock>>;

const person = (id: string, name: string) => ({
  id,
  user: { id: `u-${id}`, name, image: null },
});

/** A consultation the learner is paying for right now (30-minute window). */
const inFlight = {
  id: "c-checkout",
  status: "PENDING",
  requestedAt: hoursAgo(0.1),
  bookingSource: "DIRECT_CHECKOUT",
  requestNotes: null,
  consultationPlan: {
    id: "plan-c",
    title: "Career call",
    durationInHours: 1,
    price: 150000,
    priceCurrency: "INR",
    consultantProfile: person(CP, "Asha Rao"),
  },
  requestedBy: person("ce-9", "Dev Patel"),
  appointment: {
    id: "a-checkout",
    organizationId: null,
    organization: null,
    occurrences: [
      {
        id: "a-checkout-o0",
        startsAt: hoursAhead(48),
        endsAt: hoursAhead(49),
        isTentative: true,
        completionStatus: "SCHEDULED",
        deletedAt: null,
      },
    ],
    payment: [
      {
        id: "p-checkout",
        amount: 150000,
        originalAmount: 150000,
        taxAmount: 0,
        currency: "INR",
        paymentStatus: "PENDING",
        paymentIntent: "order_checkout",
        paymentMethod: "CARD",
        paymentGateway: "RAZORPAY",
        receiptUrl: null,
        expiresAt: new Date(NOW.getTime() + 23 * 60_000),
        createdAt: hoursAgo(0.1),
        consumerInvoice: null,
        legs: [],
        refunds: [],
        disputes: [],
      },
    ],
    rescheduleRequests: [],
    statusHistory: [],
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  const consultations = serve([inFlight]);
  m.consultation.findMany.mockImplementation(consultations.findMany);
  m.consultation.count.mockImplementation(consultations.count);
  const empty = serve([]);
  for (const model of ["subscription", "trial"]) {
    m[model].findMany.mockImplementation(empty.findMany);
    m[model].count.mockImplementation(empty.count);
  }
  m.membership.findMany.mockResolvedValue([]);
});

describe("direct checkout holds", () => {
  it("the request predicates every counter reads exclude an unpaid checkout", () => {
    for (const where of [
      pendingConsultationWhere(CP, { kind: "personal" }),
      pendingSubscriptionWhere(CP, { kind: "personal" }),
    ]) {
      expect(where.AND).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            OR: expect.arrayContaining([
              { bookingSource: { not: "DIRECT_CHECKOUT" } },
            ]),
          }),
        ]),
      );
    }
    // A paid checkout still needs its first cycle placed, so it stays a request.
    expect(ANSWERABLE_CONSULTATION.OR).toContainEqual({
      appointment: { payment: { some: { paymentStatus: "SUCCEEDED" } } },
    });
  });

  it("lists the hold as Checkout in progress, waiting on them, with no action", async () => {
    const { rows, meta } = await readRequestsInbox({
      consultantProfileId: CP,
      type: "consultation",
      sort: "priority",
      page: 1,
      now: NOW,
    });
    expect(rows.map((r) => r.id)).toEqual(["c-checkout"]);
    const [row] = rows;
    expect(row.checkoutHold).toEqual({
      expiresAt: new Date(NOW.getTime() + 23 * 60_000),
    });
    expect(row.deadline).toEqual(row.checkoutHold?.expiresAt);
    expect(row.bucket).toBe("waiting-on-them");
    const presentation = deriveBookingPresentation(
      row.presentation,
      "CONSULTANT",
      { viewerZone: "UTC", now: NOW },
    );
    expect(rowActions(row, presentation)).toEqual({
      primary: null,
      secondary: [],
    });
    expect(isDialogFreeApproval(row)).toBe(false);
    // Listed, never counted: the tab label skips it, the view total holds it.
    expect(meta.counts.consultation).toBe(0);
    expect(meta.total).toBe(1);
  });

  it("the to-answer count never reads the hold source", async () => {
    await countRequestsToAnswer({ consultantProfileId: CP });
    for (const [{ where }] of m.consultation.count.mock.calls) {
      expect(JSON.stringify(where)).not.toContain(
        '"bookingSource":"DIRECT_CHECKOUT"',
      );
      expect(where.AND).toContainEqual(ANSWERABLE_CONSULTATION);
    }
  });
});

describe("approving a request's own times", () => {
  const request = (id: string, minutes: number) => ({
    ...inFlight,
    id,
    requestedAt: hoursAgo(1),
    bookingSource: "REQUEST_SUBMITTED",
    consultationPlan: {
      ...inFlight.consultationPlan,
      durationInHours: minutes / 60,
    },
    appointment: {
      ...inFlight.appointment,
      id: `a-${id}`,
      occurrences: [
        {
          ...inFlight.appointment.occurrences[0],
          id: `a-${id}-o0`,
          endsAt: new Date(hoursAhead(48).getTime() + minutes * 60_000),
        },
      ],
      payment: [],
    },
  });

  it.each([30, 60, 90])(
    "a %i-minute request is approved on its requested time, and the allocate route's count agrees",
    async (minutes) => {
      const fixture = request(`c-${minutes}`, minutes);
      const one = serve([fixture]);
      m.consultation.findMany.mockImplementation(one.findMany);
      m.consultation.count.mockImplementation(one.count);
      const { rows } = await readRequestsInbox({
        consultantProfileId: CP,
        type: "consultation",
        sort: "priority",
        page: 1,
        now: NOW,
      });
      const [row] = rows;
      expect(isDialogFreeApproval(row)).toBe(true);
      const presentation = deriveBookingPresentation(
        row.presentation,
        "CONSULTANT",
        { viewerZone: "UTC", now: NOW },
      );
      expect(rowActions(row, presentation).primary).toEqual({
        kind: "approve",
        mode: "requested",
      });
      // The approval posts this count as expectedTentativeSlotCount; the route compares rows.
      expect(() =>
        assertExpectedTentativeSlotCount(
          // The fixture carries the occurrence fields the count reads.
          tentativeSlotCountOf([
            fixture.appointment,
          ] as unknown as AppointmentWithSlots[]),
          row.tentativeSlotCount,
        ),
      ).not.toThrow();
    },
  );
});
