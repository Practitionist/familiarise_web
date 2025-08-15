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
        topics: true;
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
    waitlist: true;
    meetingRoom: true;
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
    waitlist: true;
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
    meetingRoom: true;
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
            name: true;
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
