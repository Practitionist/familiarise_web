// Shapes shared across the allocator's modules.

import type { Appointment, AppointmentOccurrence } from "@prisma/client";

export type AppointmentWithSlots = Appointment & {
  occurrences: AppointmentOccurrence[];
};
