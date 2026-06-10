import { z } from "zod";

export const RequestForApprovalSchema = z
  .object({
    consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
    slotStartTimeInUTC: z.string().min(1, "Slot start time is required"),
    slotEndTimeInUTC: z.string().min(1, "Slot end time is required"),
    consultationPlanId: z.string().min(1, "Consultation plan ID is required"),
    slotOfAvailabilityWeeklyId: z.string().optional(),
    slotOfAvailabilityCustomId: z.string().optional(),
  })
  .refine(
    (data) =>
      !(data.slotOfAvailabilityWeeklyId && data.slotOfAvailabilityCustomId),
    {
      message: "Cannot provide both weekly and custom slot availability IDs",
      path: ["slotOfAvailabilityWeeklyId"],
    },
  )
  .refine(
    (data) =>
      data.slotOfAvailabilityWeeklyId || data.slotOfAvailabilityCustomId,
    {
      message: "Must provide either weekly or custom slot availability ID",
      path: ["slotOfAvailabilityWeeklyId"],
    },
  )
  .refine(
    (data) => {
      const start = new Date(data.slotStartTimeInUTC);
      const end = new Date(data.slotEndTimeInUTC);
      return !isNaN(start.getTime()) && !isNaN(end.getTime());
    },
    {
      message: "Invalid date format",
      path: ["slotStartTimeInUTC"],
    },
  )
  .refine(
    (data) => {
      const start = new Date(data.slotStartTimeInUTC);
      const end = new Date(data.slotEndTimeInUTC);
      return start < end;
    },
    {
      message: "Start time must be before end time",
      path: ["slotStartTimeInUTC"],
    },
  );
