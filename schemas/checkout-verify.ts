import { z } from "zod";
import {
  BOOKING_STATE_KINDS,
  MONEY_STATE_KINDS,
} from "@/lib/dashboard/money-state";

/** The fields of GET /api/checkout/verify's 200 body that the success page reads. */
export const verifyResponseSchema = z.object({
  /** The internal Payment id; the page omits the receipt link without it. */
  paymentId: z.string().optional(),
  appointmentType: z.string(),
  /** Absent while the confirmation pipeline has not landed; the page keeps polling. */
  bookingState: z.enum(BOOKING_STATE_KINDS).optional(),
  /** A full refund on its way or done outranks the booking state. */
  moneyState: z.enum(MONEY_STATE_KINDS).optional(),
});
