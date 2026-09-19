import { z } from "zod";
import { slotStartRefusal } from "@/lib/payments/utils/slot-validation";

export const RequestForApprovalSchema = z
  .object({
    consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
    startsAt: z.string().min(1, "Slot start time is required"),
    endsAt: z.string().min(1, "Slot end time is required"),
    consultationPlanId: z.string().min(1, "Consultation plan ID is required"),
    availabilityWindowWeeklyId: z.string().optional(),
    availabilityWindowCustomId: z.string().optional(),
    // #1166 ORG-9 — an org member may request a sponsored booking; validated
    // against an ACTIVE membership of a canSponsor org in the route. min(1)
    // because "" would skip that check and then be written as the FK.
    organizationId: z.string().min(1).optional(),
  })
  .refine(
    (data) =>
      !(data.availabilityWindowWeeklyId && data.availabilityWindowCustomId),
    {
      message: "Cannot provide both weekly and custom slot availability IDs",
      path: ["availabilityWindowWeeklyId"],
    },
  )
  .refine(
    (data) =>
      data.availabilityWindowWeeklyId || data.availabilityWindowCustomId,
    {
      message: "Must provide either weekly or custom slot availability ID",
      path: ["availabilityWindowWeeklyId"],
    },
  )
  .refine(
    (data) => {
      const start = new Date(data.startsAt);
      const end = new Date(data.endsAt);
      return !isNaN(start.getTime()) && !isNaN(end.getTime());
    },
    {
      message: "Invalid date format",
      path: ["startsAt"],
    },
  )
  .refine(
    (data) => {
      const start = new Date(data.startsAt);
      const end = new Date(data.endsAt);
      return start < end;
    },
    {
      message: "Start time must be before end time",
      path: ["startsAt"],
    },
  )
  // #1583 E-P1-03 — the grid and the lead time are refused at the edge, with
  // a typed code the route lifts out of `params`.
  .superRefine((data, ctx) => {
    const start = new Date(data.startsAt);
    if (isNaN(start.getTime())) return;
    const refusal = slotStartRefusal(start);
    if (refusal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: refusal.message,
        path: ["startsAt"],
        params: { code: refusal.code },
      });
    }
  });
