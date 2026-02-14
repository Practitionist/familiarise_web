import { Prisma } from "@prisma/client";

/**
 * Types for the consultee events API response
 * Matches the Prisma queries in /api/dashboard/consultee/[consulteeId]/events/route.ts
 *
 * Naming convention: T prefix for types (e.g., TConsulteeConsultation)
 */

// Consultation type - single appointment with slots
export type TConsulteeConsultation = Prisma.ConsultationGetPayload<{
  include: {
    consultationPlan: {
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true;
                name: true;
                image: true;
                email: true;
              };
            };
          };
        };
      };
    };
    appointment: {
      include: {
        slotsOfAppointment: {
          orderBy: { startsAt: "asc" };
        };
        payment: true;
      };
    };
  };
}>;

// Subscription type - multiple appointments with slots
export type TConsulteeSubscription = Prisma.SubscriptionGetPayload<{
  include: {
    subscriptionPlan: {
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true;
                name: true;
                image: true;
                email: true;
              };
            };
          };
        };
      };
    };
    appointments: {
      include: {
        slotsOfAppointment: {
          orderBy: { startsAt: "asc" };
        };
        payment: true;
      };
    };
  };
}>;

// Webinar type - includes waitlist, appointment, and collaborators
export type TConsulteeWebinar = Prisma.WebinarGetPayload<{
  include: {
    webinarPlan: {
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true;
                name: true;
                image: true;
                email: true;
              };
            };
          };
        };
        collaborators: {
          where: { status: "ACCEPTED" };
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true;
                    name: true;
                    image: true;
                  };
                };
              };
            };
          };
        };
      };
    };
    appointment: {
      include: {
        slotsOfAppointment: {
          orderBy: { startsAt: "asc" };
        };
        payment: true;
      };
    };
    waitlist: true;
  };
}>;

// Class type - includes waitlist, multiple appointments, and collaborators
export type TConsulteeClass = Prisma.ClassGetPayload<{
  include: {
    classPlan: {
      include: {
        consultantProfile: {
          include: {
            user: {
              select: {
                id: true;
                name: true;
                image: true;
                email: true;
              };
            };
          };
        };
        collaborators: {
          where: { status: "ACCEPTED" };
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true;
                    name: true;
                    image: true;
                  };
                };
              };
            };
          };
        };
      };
    };
    appointments: {
      include: {
        slotsOfAppointment: {
          orderBy: { startsAt: "asc" };
        };
        payment: true;
      };
    };
    waitlist: true;
  };
}>;

// Slot type extracted from appointments
export type TConsulteeSlot = TConsulteeConsultation["appointment"] extends {
  slotsOfAppointment: infer S;
} | null
  ? S extends Array<infer Slot>
    ? Slot
    : never
  : never;

// Full API response type
export interface TConsulteeEventsResponse {
  consultations: TConsulteeConsultation[];
  subscriptions: TConsulteeSubscription[];
  webinars: TConsulteeWebinar[];
  classes: TConsulteeClass[];
}

// API wrapper response
export interface TConsulteeEventsApiResponse {
  data: TConsulteeEventsResponse;
  success: boolean;
}
