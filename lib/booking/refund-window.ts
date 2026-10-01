import { z } from "zod";

import {
  EVENT_REFUND_WINDOW_HOURS_DEFAULT,
  EVENT_REFUND_WINDOW_HOURS_MAX,
} from "@/lib/payments/operations/cancellation-policy";

/**
 * #1780 row 2 — the host's free-cancellation window on a class or webinar
 * plan, in whole hours from 24 to 168; null clears it back to the default.
 */
export const refundWindowHoursSchema = z
  .number()
  .int()
  .min(EVENT_REFUND_WINDOW_HOURS_DEFAULT)
  .max(EVENT_REFUND_WINDOW_HOURS_MAX)
  .nullable()
  .optional();
