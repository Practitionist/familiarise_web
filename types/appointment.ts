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
        slotsOfAppointment: {
          include: {
            user: true;
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
    appointments: {
      include: {
        slotsOfAppointment: {
          include: {
            user: true;
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
      };
    };
    appointment: {
      include: {
        slotsOfAppointment: {
          include: {
            user: true;
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
      };
    };
    appointments: {
      include: {
        slotsOfAppointment: {
          include: {
            user: true;
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
    payment: true;
    slotsOfAppointment: {
      include: {
        user: true;
      };
    };
  };
}>;

// Utility type for creating appointments
export type TAppointmentCreateInput = Prisma.AppointmentCreateInput;
