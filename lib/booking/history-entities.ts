import type { BookingHistoryEntity } from "@prisma/client";

/**
 * The history entities every deployed client knows. One database serves every
 * deployment, and Prisma throws on an enum value its client lacks, so reads
 * that select `entity` or match history by status name these explicitly.
 */
export const KNOWN_HISTORY_ENTITIES = [
  "CONSULTATION",
  "SUBSCRIPTION",
  "WEBINAR",
  "CLASS",
  "TRIAL",
  "RESCHEDULE_REQUEST",
  "OCCURRENCE",
] as const satisfies readonly BookingHistoryEntity[];
