/**
 * @jest-environment node
 */

/**
 * A learner whose card checkout lapsed keeps a HELD seat row on its EXPIRED
 * payment until a sweep releases it. A free or sponsored checkout over that row
 * confirms it in the commit and records the registration, rather than refusing.
 */
jest.mock("../../lib/prisma", () => ({ __esModule: true, default: {} }));

import type { Tx } from "@/lib/prisma";
import { handleWebinarCheckout } from "@/lib/payments/checkout/handlers/webinar";
import type { CheckoutInput } from "@/schemas/checkout";
import { memTable, type Row } from "../fixtures/mem-db";

const APPT = "appt-web";
const BUYER = "buyer-1";

function arrange(seatStatus: string) {
  const seats: Row[] = [
    {
      id: "part-1",
      appointmentId: APPT,
      userId: BUYER,
      role: "CONSULTEE",
      status: seatStatus,
      paymentId: "pay-lapsed",
      removedByUserId: null,
      organizationId: null,
      appointment: { appointmentType: "WEBINAR" },
    },
  ];
  const history: Row[] = [];
  const tx = {
    webinar: {
      findUnique: async () => ({
        id: "web-1",
        status: "SCHEDULED",
        webinarPlan: {
          price: 0,
          maxParticipants: 50,
          refundWindowHours: 24,
          consultantProfile: { userId: "host-1" },
        },
        appointment: {
          id: APPT,
          occurrences: [
            {
              id: "occ-1",
              startsAt: new Date("2030-01-01T10:00:00Z"),
              endsAt: new Date("2030-01-01T11:00:00Z"),
            },
          ],
          // A HELD seat on a dead payment holds no place.
          participants: [],
        },
      }),
    },
    // The lapsed card attempt: EXPIRED, its seat still HELD.
    payment: {
      findFirst: async () => ({
        id: "pay-lapsed",
        userId: BUYER,
        paymentIntent: "order_lapsed",
        gatewayPaymentId: null,
        amount: 0,
        originalAmount: 0,
        taxAmount: 0,
        gstRegime: null,
        currency: "INR",
        paymentGateway: "RAZORPAY",
        paymentStatus: "EXPIRED",
        refunds: [],
        appointmentParticipants: [
          { id: "part-1", status: seatStatus, removedByUserId: null },
        ],
      }),
    },
    appointmentParticipant: memTable(seats, "part", {
      unique: [["appointmentId", "userId"]],
    }),
    bookingStatusHistory: memTable(history, "hist"),
  };
  return { seats, history, tx: tx as unknown as Tx };
}

const checkout = (tx: Tx) =>
  handleWebinarCheckout(
    tx,
    {
      eventId: "web-1",
      appointmentType: "WEBINAR",
    } as unknown as CheckoutInput,
    BUYER,
    true,
  );

it("confirms a stale HELD seat on a free checkout and records the registration", async () => {
  const { seats, history, tx } = arrange("HELD");
  await expect(checkout(tx)).resolves.toMatchObject({
    appointment: { id: APPT },
  });
  expect(seats[0]).toMatchObject({
    status: "CONFIRMED",
    refundWindowHours: 24,
  });
  expect(history).toEqual([
    expect.objectContaining({
      entity: "SEAT",
      entityId: "part-1",
      fromStatus: "HELD",
      toStatus: "CONFIRMED",
      reason: "registered",
      actorUserId: BUYER,
    }),
  ]);
});
