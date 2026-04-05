import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, AppointmentsType } from "@prisma/client";
import { requireApiAuth, isPrivileged } from "@/lib/auth-helpers";

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
      slotsOfAppointment: {
        select: { user: { select: { id: true } } },
        take: 1,
        where: { user: { some: { id: userId } } },
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

  // User is directly on a slot
  if (appointment.slotsOfAppointment.length > 0) return true;

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
    if (
      consultantProfileId === appointment.class.classPlan.consultantProfileId
    )
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

/**
 * Check if the user is the consultant (plan owner or accepted collaborator)
 * for the given appointment. Consultees are excluded — use this for
 * write operations where only the service provider should have access.
 */
async function isAppointmentConsultant(
  consultantProfileId: string | null | undefined,
  appointmentId: string,
): Promise<boolean> {
  if (!consultantProfileId) return false;

  const appointment = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: {
      consultation: {
        select: {
          consultationPlan: { select: { consultantProfileId: true } },
        },
      },
      subscription: {
        select: {
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

  if (
    appointment.consultation?.consultationPlan.consultantProfileId ===
    consultantProfileId
  )
    return true;
  if (
    appointment.subscription?.subscriptionPlan.consultantProfileId ===
    consultantProfileId
  )
    return true;
  if (appointment.webinar) {
    if (
      appointment.webinar.webinarPlan.consultantProfileId ===
      consultantProfileId
    )
      return true;
    if (
      appointment.webinar.webinarPlan.collaborators.some(
        (c) => c.consultantProfileId === consultantProfileId,
      )
    )
      return true;
  }
  if (appointment.class) {
    if (
      appointment.class.classPlan.consultantProfileId === consultantProfileId
    )
      return true;
    if (
      appointment.class.classPlan.collaborators.some(
        (c) => c.consultantProfileId === consultantProfileId,
      )
    )
      return true;
  }

  return false;
}

interface UpdateSlotsRequest {
  slotsOfAppointment?: {
    deleteMany?: Record<string, never>;
    createMany?: {
      data: Array<{
        slotStartTimeInUTC: string;
        slotEndTimeInUTC: string;
        type?: "WEEKLY" | "CUSTOM";
        isTentative?: boolean;
      }>;
    };
  };
  // Global isTentative flag - applies to all slots if individual slot doesn't specify
  isTentative?: boolean;
}

interface UpdateAppointmentRequest {
  appointmentType?: AppointmentsType;
  slotsOfAppointmentId?: string;
  consultationId?: string;
  subscriptionId?: string;
  webinarId?: string;
  classId?: string;
}

type _AppointmentInclude = Prisma.AppointmentGetPayload<{
  include: {
    slotsOfAppointment: {
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
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
        slotsOfAppointment: {
          include: {
            user: {
              // Changed from consulteeProfile
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                consulteeProfile: true, // Include consulteeProfile if needed
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
        { status: 404 },
      );
    }

    return NextResponse.json({ data: appointment }, { status: 200 });
  } catch (error) {
    console.error("Error fetching appointment:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the appointment" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { appointmentId } = await params;

    // PATCH is destructive (delete-all + recreate slots) — restrict to
    // the consultant (plan owner / accepted collaborator) or admin/staff.
    // Consultees must not be able to rewrite appointment slots.
    if (!isPrivileged(session.user.role)) {
      const allowed = await isAppointmentConsultant(
        session.user.consultantProfileId,
        appointmentId,
      );
      if (!allowed) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
    }

    const body: UpdateSlotsRequest = await request.json();

    if (!body.slotsOfAppointment?.createMany?.data) {
      return NextResponse.json(
        { error: "Missing slots data" },
        { status: 400 },
      );
    }

    // Determine default isTentative value - global flag takes precedence
    const defaultIsTentative = body.isTentative ?? false;

    const data: Prisma.AppointmentUpdateInput = {
      slotsOfAppointment: {
        deleteMany: {},
        create: body.slotsOfAppointment.createMany.data.map((slot) => ({
          startsAt: new Date(slot.slotStartTimeInUTC),
          endsAt: new Date(slot.slotEndTimeInUTC),
          type: slot.type || "WEEKLY", // Default to WEEKLY if not specified
          isTentative: slot.isTentative ?? defaultIsTentative, // Explicit tentative flag
        })),
      },
    };

    const updatedAppointment = await prisma.appointment.update({
      where: { id: appointmentId },
      data,
      include: {
        slotsOfAppointment: {
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
      },
    });

    return NextResponse.json({ data: updatedAppointment }, { status: 200 });
  } catch (error) {
    console.error("Error updating appointment slots:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Appointment not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the appointment slots" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  // PUT rewires appointment relations — restrict to admin/staff only
  if (!isPrivileged(session.user.role)) {
    return NextResponse.json(
      { error: "Forbidden: only admin/staff can update appointment relations" },
      { status: 403 },
    );
  }

  try {
    const { appointmentId } = await params;
    const body: UpdateAppointmentRequest = await request.json();

    if (
      body.appointmentType &&
      !Object.values(AppointmentsType).includes(body.appointmentType)
    ) {
      return NextResponse.json(
        { error: "Invalid appointment type" },
        { status: 400 },
      );
    }

    const data: Prisma.AppointmentUpdateInput = {
      appointmentType: body.appointmentType,
      consultation: body.consultationId
        ? { connect: { id: body.consultationId } }
        : undefined,
      subscription: body.subscriptionId
        ? { connect: { id: body.subscriptionId } }
        : undefined,
      webinar: body.webinarId ? { connect: { id: body.webinarId } } : undefined,
      class: body.classId ? { connect: { id: body.classId } } : undefined,
    };

    const updatedAppointment = await prisma.appointment.update({
      where: { id: appointmentId },
      data,
      include: {
        slotsOfAppointment: {
          include: {
            user: {
              // Changed from consulteeProfile
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                consulteeProfile: true, // Include consulteeProfile if needed
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

    return NextResponse.json({ data: updatedAppointment }, { status: 200 });
  } catch (error) {
    console.error("Error updating appointment:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Appointment not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the appointment" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  // DELETE is destructive — restrict to admin/staff only
  if (!isPrivileged(session.user.role)) {
    return NextResponse.json(
      { error: "Forbidden: only admin/staff can delete appointments" },
      { status: 403 },
    );
  }

  try {
    const { appointmentId } = await params;
    // Check if there's an associated payment
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: {
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

    if (appointment?.payment) {
      return NextResponse.json(
        { error: "Cannot delete appointment with associated payment" },
        { status: 400 },
      );
    }

    const deletedAppointment = await prisma.appointment.delete({
      where: { id: appointmentId },
      include: {
        slotsOfAppointment: {
          include: {
            user: {
              // Changed from consulteeProfile
              select: {
                id: true,
                name: true,
                email: true,
                image: true,
                consulteeProfile: true, // Include consulteeProfile if needed
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
      },
    });

    return NextResponse.json({ data: deletedAppointment }, { status: 200 });
  } catch (error) {
    console.error("Error deleting appointment:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Appointment not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while deleting the appointment" },
      { status: 500 },
    );
  }
}
