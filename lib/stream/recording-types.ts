/**
 * Recording Types
 * Prisma payload types for type-safe recording queries
 */

import { Prisma } from "@prisma/client";

// ============================================================================
// Consultant Recordings Include Structure
// Used by: RecordingService.getConsultantRecordings()
// ============================================================================

export const consultantRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
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
                class: {
                  include: {
                    classPlan: {
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

export type ConsultantRecordingWithDetails = Prisma.RecordingGetPayload<{
  include: typeof consultantRecordingInclude;
}>;

// ============================================================================
// Recording with Access Control Include Structure
// Used by: RecordingService.getRecordingById()
// ============================================================================

export const recordingWithAccessControlInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: true,
                  },
                },
                class: {
                  include: {
                    classPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type RecordingWithAccessControl = Prisma.RecordingGetPayload<{
  include: typeof recordingWithAccessControlInclude;
}>;

// ============================================================================
// Webinar Plan Recordings Include Structure
// Used by: RecordingService.getWebinarPlanRecordings()
// ============================================================================

export const webinarPlanRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
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

export type WebinarPlanRecordingWithDetails = Prisma.RecordingGetPayload<{
  include: typeof webinarPlanRecordingInclude;
}>;

// ============================================================================
// Class Plan Recordings Include Structure
// Used by: RecordingService.getClassPlanRecordings()
// ============================================================================

export const classPlanRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                class: {
                  include: {
                    classPlan: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

export type ClassPlanRecordingWithDetails = Prisma.RecordingGetPayload<{
  include: typeof classPlanRecordingInclude;
}>;

// ============================================================================
// Consultee Recordings Include Structure
// Used by: RecordingService.getConsulteeRecordings()
// ============================================================================

export const consulteeRecordingInclude =
  Prisma.validator<Prisma.RecordingInclude>()({
    meetingSession: {
      include: {
        slotOfAppointment: {
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
                class: {
                  include: {
                    classPlan: {
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

export type ConsulteeRecordingWithDetails = Prisma.RecordingGetPayload<{
  include: typeof consulteeRecordingInclude;
}>;
