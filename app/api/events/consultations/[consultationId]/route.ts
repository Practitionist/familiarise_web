import prisma from "@/lib/prisma";
import { AppointmentsType, Prisma, RequestStatus } from "@prisma/client";
import { addHours } from "date-fns";
import { NextRequest, NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const { consultationId } = await params;
    const consultationData = await prisma.consultation.findUniqueOrThrow({
      where: { id: consultationId },
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
        appointment: {
          include: {
            slotsOfAppointment: {
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
    });

    return NextResponse.json({ data: consultationData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 },
      );
    }
    console.error("Error fetching consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the consultation" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const { consultationId } = await params;
    const body = await request.json();

    const consultationData = await prisma.consultation.update({
      where: { id: consultationId },
      data: {
        requestStatus: body.requestStatus,
        requestNotes: body.requestNotes,
        directlyBooked: body.directlyBooked,
        feedbackFromConsultee: body.feedbackFromConsultee,
        feedbackFromConsultant: body.feedbackFromConsultant,
        rating: body.rating,
        consultationPlan: body.planId
          ? {
              connect: { id: body.planId },
            }
          : undefined,
      },
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
        appointment: {
          include: {
            slotsOfAppointment: {
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
    });

    return NextResponse.json({ data: consultationData }, { status: 200 });
  } catch (error) {
    console.error("Error updating consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the consultation" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const { consultationId } = await params;

    const consultationData = await prisma.consultation.delete({
      where: { id: consultationId },
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
        appointment: {
          include: {
            slotsOfAppointment: {
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
    });

    return NextResponse.json({ data: consultationData }, { status: 200 });
  } catch (error) {
    console.error("Error deleting consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the consultation" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ consultationId: string }> },
) {
  try {
    const body = await request.json();
    
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: "Invalid request body" },
        { status: 400 }
      );
    }

    const { status } = body as { status: RequestStatus };
    const { consultationId } = await params;

    if (!status) {
      return NextResponse.json(
        { error: "Status is required" },
        { status: 400 }
      );
    }

    if (!Object.values(RequestStatus).includes(status)) {
      return NextResponse.json(
        { error: "Invalid status" },
        { status: 400 }
      );
    }

    // First fetch the consultation to validate it exists and get all necessary data
    const existingConsultation = await prisma.consultation.findUnique({
      where: { id: consultationId },
      include: {
        consultationPlan: {
          include: {
            consultantProfile: {
              include: {
                user: true,
              },
            },
          },
        },
        requestedBy: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!existingConsultation) {
      return NextResponse.json(
        { error: "Consultation not found" },
        { status: 404 }
      );
    }

    if (!existingConsultation.consultationPlan?.consultantProfile?.user?.id) {
      return NextResponse.json(
        { error: "Invalid consultation: missing consultant information" },
        { status: 400 }
      );
    }

    if (!existingConsultation.requestedBy?.user?.id) {
      return NextResponse.json(
        { error: "Invalid consultation: missing requestedBy information" },
        { status: 400 }
      );
    }

    try {
      // Update consultation status
      const consultation = await prisma.consultation.update({
        where: { id: consultationId },
        data: { 
          requestStatus: status,
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
        },
      });

      // If approved, create an appointment
      if (status === RequestStatus.APPROVED) {
        await createAppointmentForConsultation(consultation);
      }

      return NextResponse.json({ data: consultation });
    } catch (error) {
      console.error("Transaction error:", error instanceof Error ? error.message : 'Unknown error');
      throw error;
    }
  } catch (error) {
    console.error("Error updating consultation:", error instanceof Error ? error.message : 'Unknown error');
    return NextResponse.json(
      { error: "An error occurred while updating consultation" },
      { status: 500 }
    );
  }
}

async function createAppointmentForConsultation(consultation: any) {
  const { consultationPlan, requestedBy } = consultation;
  
  if (!consultationPlan?.durationInHours) {
    console.error("Missing consultation plan details:", consultationPlan);
    throw new Error("Invalid consultation plan details");
  }

  if (!requestedBy?.user?.id || !consultationPlan?.consultantProfile?.user?.id) {
    console.error("Missing user information:", { requestedBy, consultantProfile: consultationPlan.consultantProfile });
    throw new Error("Missing user information");
  }

  // Set default appointment time to now + 1 hour
  const startDate = new Date();
  startDate.setMinutes(0); // Reset minutes to start of hour
  startDate.setHours(startDate.getHours() + 1); // Start next hour

  try {
    const appointment = await prisma.appointment.create({
      data: {
        appointmentType: AppointmentsType.CONSULTATION,
        consultation: {
          connect: { id: consultation.id }
        },
        slotsOfAppointment: {
          create: {
            slotStartTimeInUTC: startDate,
            slotEndTimeInUTC: addHours(startDate, consultationPlan.durationInHours),
            isTentative: false,
            user: {
              connect: [
                { id: requestedBy.user.id },
                { id: consultationPlan.consultantProfile.user.id }
              ]
            }
          }
        }
      },
      include: {
        slotsOfAppointment: {
          include: {
            user: true
          }
        }
      }
    });

    return appointment;
  } catch (error) {
    console.error(`Error creating appointment:`, error);
    throw error;
  }
}
