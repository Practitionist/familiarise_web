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
  };
}>;

// Custom type for Subscription with specific nesting depth
export type TSubscription = Prisma.SubscriptionGetPayload<{
  include: {
    plan: {
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
}>;

// Main appointment type with all relations
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
      };
    };
    subscription: {
      include: {
        plan: {
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
    webinar: {
      include: {
        webinarPlan: {
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
    payment: {
      include: {
        user: true;
        discountCode: true;
      };
    };
    slotOfAppointment: {
      include: {
        consulteeProfile: {
          include: {
            user: true;
          };
        };
      };
    };
  };
}>;

// Utility type for creating appointments
export type TAppointmentCreateInput = Prisma.AppointmentCreateInput;
