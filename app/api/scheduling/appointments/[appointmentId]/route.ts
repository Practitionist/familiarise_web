import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";
import { liveParticipant } from "@/lib/booking/participants";

/**
 * Check if the authenticated user is a participant in the given appointment.
 * A user is a participant if they are:
 * - Connected to any slot of the appointment (as consultant or consultee)
 * - The consultation/subscription requester
 * - The plan owner (consultant)
 * - An accepted collaborator on the webinar/class plan
 */
async function isAppointmentParticipant(
  userId: string,
  consultantProfileId: string | null | undefined,
  consulteeProfileId: string | null | undefined,
  appointmentId: string,
): Promise<boolean> {
  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      participants: {
        select: { id: true },
        take: 1,
        where: liveParticipant(userId),
      },
      consultation: {
        select: {
          requestedById: true,
          consultationPlan: { select: { consultantProfileId: true } },
        },
      },
      subscription: {
        select: {
          requestedById: true,
          subscriptionPlan: { select: { consultantProfileId: true } },
        },
      },
      webinar: {
        select: {
          webinarPlan: {
            select: {
              consultantProfileId: true,
              collaborators: {
                where: { status: "ACCEPTED" },
                select: { consultantProfileId: true },
              },
            },
          },
        },
      },
      class: {
        select: {
          classPlan: {
            select: {
              consultantProfileId: true,
              collaborators: {
                where: { status: "ACCEPTED" },
                select: { consultantProfileId: true },
              },
            },
          },
        },
      },
    },
  });

  if (!appointment) return false;

  // The user holds a seat on the appointment (#1554)
  if (appointment.participants.length > 0) return true;

  // Check consultation ownership
  if (appointment.consultation) {
    if (
      consultantProfileId ===
      appointment.consultation.consultationPlan.consultantProfileId
    )
      return true;
    if (consulteeProfileId === appointment.consultation.requestedById)
      return true;
  }

  // Check subscription ownership
  if (appointment.subscription) {
    if (
      consultantProfileId ===
      appointment.subscription.subscriptionPlan.consultantProfileId
    )
      return true;
    if (consulteeProfileId === appointment.subscription.requestedById)
      return true;
  }

  // Check webinar ownership/collaboration
  if (appointment.webinar) {
    if (
      consultantProfileId ===
      appointment.webinar.webinarPlan.consultantProfileId
    )
      return true;
    if (
      consultantProfileId &&
      appointment.webinar.webinarPlan.collaborators.some(
        (c) => c.consultantProfileId === consultantProfileId,
      )
    )
      return true;
  }

  // Check class ownership/collaboration
  if (appointment.class) {
    if (consultantProfileId === appointment.class.classPlan.consultantProfileId)
      return true;
    if (
      consultantProfileId &&
      appointment.class.classPlan.collaborators.some(
        (c) => c.consultantProfileId === consultantProfileId,
      )
    )
      return true;
  }

  return false;
}

type _AppointmentInclude = Prisma.AppointmentGetPayload<{
  include: {
    occurrences: true;
    participants: {
      include: {
        user: {
          select: {
            id: true;
            name: true;
            email: true;
            image: true;
            consulteeProfile: true;
          };
        };
      };
    };
    consultation: {
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: {
                  select: {
                    id: true;
                    name: true;
                    email: true;
                    image: true;
                  };
                };
              };
            };
          };
        };
        requestedBy: {
          include: {
            user: {
              select: {
                id: true;
                name: true;
                email: true;
                image: true;
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
                user: {
                  select: {
                    id: true;
                    name: true;
                    email: true;
                    image: true;
                  };
                };
              };
            };
          };
        };
        requestedBy: {
          include: {
            user: {
              select: {
                id: true;
                name: true;
                email: true;
                image: true;
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
                user: {
                  select: {
                    id: true;
                    name: true;
                    email: true;
                    image: true;
                  };
                };
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
                user: {
                  select: {
                    id: true;
                    name: true;
                    email: true;
                    image: true;
                  };
                };
              };
            };
          };
        };
      };
    };
  };
}>;

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { appointmentId } = await params;

    // Authorization: must be a participant or privileged
    if (!isPrivileged(session.user.role)) {
      const allowed = await isAppointmentParticipant(
        session.user.id,
        session.user.consultantProfileId,
        session.user.consulteeProfileId,
        appointmentId,
      );
      if (!allowed) {
        return NextResponse.json(
          { error: "Forbidden" },
          { status: 403, headers: { "Cache-Control": "no-store" } },
        );
      }
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        occurrences: true,
        // #1554 — the roster lives on the appointment, not on each occurrence.
        participants: {
          where: liveParticipant(),
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                consulteeProfile: true,
              },
            },
          },
        },
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
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
        },
        subscription: {
          include: {
            subscriptionPlan: {
              include: {
                consultantProfile: {
                  include: {
                    user: {
                      select: {
                        id: true,
                        name: true,
                        email: true,
                        image: true,
                      },
                    },
                  },
                },
              },
            },
            requestedBy: {
              include: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    email: true,
                    image: true,
                  },
                },
              },
            },
          },
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
                      },
                    },
                  },
                },
              },
            },
          },
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
                      },
                    },
                  },
                },
              },
            },
          },
        },
        payment: {
          include: {
            user: {
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
              },
            },
          },
        },
      },
    });

    if (!appointment) {
      return NextResponse.json(
        { error: "Appointment not found" },
        { status: 404, headers: { "Cache-Control": "no-store" } },
      );
    }

    return NextResponse.json(
      { data: appointment },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    console.error("Error fetching appointment:", error);
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "scheduling" } },
    );
    return NextResponse.json(
      { error: "An error occurred while fetching the appointment" },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
