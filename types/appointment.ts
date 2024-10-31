import { Prisma, AppointmentsType, RequestStatus, PaymentStatus, PaymentGateway, DiscountType, ConsultationMode, PlanEmailSupport, DayOfWeek, ScheduleType } from "@prisma/client";

export type TAppointment = Prisma.AppointmentGetPayload<{
  include: {
    consultation: {
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                    phone: true,
                    address: true,
                    onlineStatus: true,
                    currentTimezone: true,
                    onboardingCompleted: true,
                    role: true,
                  }
                },
                reviews: true,
                slotsOfAvailabilityWeekly: true,
                slotsOfAvailabilityCustom: true,
                consultationPlans: true,
                subscriptionPlans: true,
                webinarPlans: true,
                classPlans: true,
              }
            }
          }
        },
        requestedBy: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                phone: true,
                address: true,
                onlineStatus: true,
                currentTimezone: true,
                onboardingCompleted: true,
                role: true,
              }
            },
            consultationRequests: true,
            subscriptionRequests: true,
            slotsOfAppointment: true,
            consultantReviews: true,
          }
        }
      }
    },
    subscription: {
      include: {
        plan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                    phone: true,
                    address: true,
                    onlineStatus: true,
                    currentTimezone: true,
                    onboardingCompleted: true,
                    role: true,
                  }
                },
                reviews: true,
                slotsOfAvailabilityWeekly: true,
                slotsOfAvailabilityCustom: true,
                consultationPlans: true,
                subscriptionPlans: true,
                webinarPlans: true,
                classPlans: true,
              }
            }
          }
        },
        requestedBy: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                phone: true,
                address: true,
                onlineStatus: true,
                currentTimezone: true,
                onboardingCompleted: true,
                role: true,
              }
            },
            consultationRequests: true,
            subscriptionRequests: true,
            slotsOfAppointment: true,
            consultantReviews: true,
          }
        },
        appointment: true,
      }
    },
    webinar: {
      include: {
        webinarPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                    phone: true,
                    address: true,
                    onlineStatus: true,
                    currentTimezone: true,
                    onboardingCompleted: true,
                    role: true,
                  }
                },
                reviews: true,
                slotsOfAvailabilityWeekly: true,
                slotsOfAvailabilityCustom: true,
                consultationPlans: true,
                subscriptionPlans: true,
                webinarPlans: true,
                classPlans: true,
              }
            }
          }
        },
        topics: true,
        waitlist: {
          include: {
            webinar: true,
            class: true,
          }
        },
        appointment: true,
      }
    },
    class: {
      include: {
        classPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                    phone: true,
                    address: true,
                    onlineStatus: true,
                    currentTimezone: true,
                    onboardingCompleted: true,
                    role: true,
                  }
                },
                reviews: true,
                slotsOfAvailabilityWeekly: true,
                slotsOfAvailabilityCustom: true,
                consultationPlans: true,
                subscriptionPlans: true,
                webinarPlans: true,
                classPlans: true,
              }
            }
          }
        },
        topics: true,
        waitlist: {
          include: {
            webinar: true,
            class: true,
          }
        },
        appointment: true,
      }
    },
    appointmentLock: true,
    payment: {
      include: {
        user: true,
        appointment: true,
        discountCode: true,
      }
    },
    slotOfAppointment: {
      include: {
        consulteeProfile: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                phone: true,
                address: true,
                onlineStatus: true,
                currentTimezone: true,
                onboardingCompleted: true,
                role: true,
              }
            },
            consultationRequests: true,
            subscriptionRequests: true,
            slotsOfAppointment: true,
            consultantReviews: true,
          }
        }
      }
    }
  }
}>;

// Additional type definitions for better type checking and autocompletion
export type TConsultation = NonNullable<TAppointment['consultation']>;
export type TSubscription = NonNullable<TAppointment['subscription']>;
export type TWebinar = NonNullable<TAppointment['webinar']>;
export type TClass = NonNullable<TAppointment['class']>;
export type TPayment = NonNullable<TAppointment['payment']>;
export type TSlotOfAppointment = NonNullable<TAppointment['slotOfAppointment']>;

// Utility type for creating appointments
export type TAppointmentCreateInput = Prisma.AppointmentCreateInput;
