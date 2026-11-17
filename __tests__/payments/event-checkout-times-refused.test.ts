/**
 * @jest-environment node
 */

/** A webinar or class seat runs at its event's time: a sent startsAt/endsAt is a 400, never a 500. */
jest.mock("@/lib/prisma", () => ({ __esModule: true, default: {} }));

import { checkoutSchema } from "@/schemas/checkout";
import { acquireCheckoutLock } from "@/lib/payments/checkout/locks";
import { classifyError } from "@/lib/errors/classification/payment-error-classification";

const STARTS = "2026-12-01T10:00:00.000Z";
const ENDS = "2026-12-01T11:00:00.000Z";

describe.each(["WEBINAR", "CLASS"] as const)("a %s checkout", (type) => {
  it.each(["startsAt", "endsAt"] as const)(
    "is refused by the schema when it sends %s",
    (field) => {
      const parsed = checkoutSchema.safeParse({
        appointmentType: type,
        planId: "plan-1",
        eventId: "event-1",
        paymentGateway: "RAZORPAY",
        [field]: field === "startsAt" ? STARTS : ENDS,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues).toContainEqual(
        expect.objectContaining({
          path: [field],
          message: expect.stringContaining(`${field} must not be sent`),
        }),
      );
    },
  );

  it("is a typed 400 refusal if it reaches the lock with times", async () => {
    const error = await acquireCheckoutLock(
      {
        appointmentType: type,
        planId: "plan-1",
        eventId: "event-1",
        startsAt: STARTS,
        endsAt: ENDS,
      } as Parameters<typeof acquireCheckoutLock>[0],
      {},
    ).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "EVENT_SEAT_TIMES_SENT" });
    expect(classifyError(error)).toMatchObject({
      httpStatus: 400,
      isBusinessError: true,
    });
  });
});
