import { z } from "zod";
import { CancellationReasonEnum } from "./enums";

export const CancelAppointmentSchema = z.object({
  reason: CancellationReasonEnum.optional(),
  notes: z.string().optional(),
});

export type CancelAppointmentInput = z.infer<typeof CancelAppointmentSchema>;
