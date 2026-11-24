import { Prisma } from "@prisma/client";

// Custom type for Consultation with specific nesting depth
export type TConsultation = Prisma.ConsultationGetPayload<{
  include: {
    consultationPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
      };
    };
    requestedBy: {
      include: {
        user: true;
      };
    };
    appointment: {
      include: {
        occurrences: {
          include: {
            meeting: {
              select: { id: true; endedAt: true; endedReason: true };
            };
          };
        };
        payment: true;
      };
    };
  };
}>;

// Custom type for Subscription with specific nesting depth
export type TSubscription = Prisma.SubscriptionGetPayload<{
  include: {
    subscriptionPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
      };
    };
    requestedBy: {
      include: {
        user: true;
      };
    };
    appointment: {
      include: {
        occurrences: {
          include: {
            meeting: {
              select: { id: true; endedAt: true; endedReason: true };
            };
          };
        };
        payment: true;
      };
    };
  };
}>;

// Custom type for Webinar with specific nesting depth
export type TWebinar = Prisma.WebinarGetPayload<{
  include: {
    webinarPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
        topics: true;
      };
    };
    appointment: {
      include: {
        occurrences: {
          include: {
            meeting: {
              select: { id: true; endedAt: true; endedReason: true };
            };
          };
        };
        payment: true;
      };
    };
  };
}>;

// Custom type for Class with specific nesting depth
export type TClass = Prisma.ClassGetPayload<{
  include: {
    classPlan: {
      include: {
        consultantProfile: {
          include: {
            user: true;
          };
        };
        topics: true;

        classContents: {
          orderBy: {
            order: "asc";
          };
        };
      };
    };
    appointment: {
      include: {
        occurrences: {
          include: {
            meeting: {
              select: { id: true; endedAt: true; endedReason: true };
            };
          };
        };
        payment: true;
      };
    };
  };
}>;

export type TAppointment = Prisma.AppointmentGetPayload<{
  include: {
    consultation: {
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true;
              };
            };
          };
        };
        requestedBy: {
          include: {
            user: true;
          };
        };
      };
    };
    subscription: {
      include: {
        subscriptionPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true;
              };
            };
            title: true;
          };
        };
        requestedBy: {
          include: {
            user: true;
          };
        };
        schedulingTimezone: true;
      };
    };
    webinar: {
      include: {
        webinarPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true;
              };
            };

            title: true;
          };
        };
      };
    };
    class: {
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true;
              };
            };
          };
        };
      };
    };
    payment: true;
    occurrences: {
      include: {
        meeting: {
          select: { id: true; endedAt: true; endedReason: true };
        };
      };
    };
  };
}>;

// Extract slot type from TAppointment for reuse
export type TAppointmentOccurrence = TAppointment["occurrences"][number];

/** A list row that also counted its live seats (`_count.participants` filtered to live statuses). */
export type TAppointmentWithSeats = TAppointment & {
  _count?: { participants?: number };
  /** Stamped by the reader: a session is parked for ops. */
  awaitingDecision?: boolean;
};
