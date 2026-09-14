/**
 * Recording Types
 * Prisma payload types for type-safe recording queries
 */

import { Prisma, type Recording } from "@prisma/client";
import type { Db } from "@/lib/prisma";
import { liveParticipant } from "@/lib/booking/participants";

// #780 — payload types derive from the extended client (Prisma.Result), not
// Prisma.RecordingGetPayload, so BigInt columns (fileSize, plan.price) type
// as number — matching what the client actually returns.
// listPricePaise (#366) is converted by the money extension map, same deal.
export type RecordingRow = Omit<Recording, "fileSize" | "listPricePaise"> & {
  fileSize: number | null;
  listPricePaise: number | null;
};

// ============================================================================
// Consultant Recordings Include Structure
// Used by: RecordingService.getConsultantRecordings()
// ============================================================================

export const consultantRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meeting: {
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                // #1554 — the roster is the appointment's live participants.
                participants: {
                  where: liveParticipant(),
                  select: { user: { select: { name: true } } },
                },
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        id: true,
                        title: true,
                      },
                    },
                  },
                },
                cohort: {
                  include: {
                    cohortPlan: {
                      select: {
                        id: true,
                        title: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type ConsultantRecordingWithDetails = Prisma.Result<
  Db["recording"],
  { include: typeof consultantRecordingInclude },
  "findFirstOrThrow"
>;

// ============================================================================
// Recording with Access Control Include Structure
// Used by: RecordingService.getRecordingById()
// ============================================================================

export const recordingWithAccessControlInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meeting: {
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: true,
                  },
                },
                cohort: {
                  include: {
                    cohortPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type RecordingWithAccessControl = Prisma.Result<
  Db["recording"],
  { include: typeof recordingWithAccessControlInclude },
  "findFirstOrThrow"
>;

// ============================================================================
// Webinar Plan Recordings Include Structure
// Used by: RecordingService.getWebinarPlanRecordings()
// ============================================================================

export const webinarPlanRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meeting: {
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type WebinarPlanRecordingWithDetails = Prisma.Result<
  Db["recording"],
  { include: typeof webinarPlanRecordingInclude },
  "findFirstOrThrow"
>;

// ============================================================================
// Class Plan Recordings Include Structure
// Used by: RecordingService.getCohortPlanRecordings()
// ============================================================================

export const cohortPlanRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meeting: {
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                cohort: {
                  include: {
                    cohortPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type CohortPlanRecordingWithDetails = Prisma.Result<
  Db["recording"],
  { include: typeof cohortPlanRecordingInclude },
  "findFirstOrThrow"
>;

// ============================================================================
// Consultee Recordings Include Structure
// Used by: RecordingService.getConsulteeRecordings()
// ============================================================================

export const consulteeRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meeting: {
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        id: true,
                        title: true,
                      },
                    },
                  },
                },
                cohort: {
                  include: {
                    cohortPlan: {
                      select: {
                        id: true,
                        title: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type ConsulteeRecordingWithDetails = Prisma.Result<
  Db["recording"],
  { include: typeof consulteeRecordingInclude },
  "findFirstOrThrow"
>;
