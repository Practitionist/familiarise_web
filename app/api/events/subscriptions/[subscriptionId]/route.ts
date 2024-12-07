import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;
    const subscriptionData = await prisma.subscription.findUniqueOrThrow({
      where: { id: subscriptionId },
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
        appointments: {
          include: {
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

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2025"
    ) {
      return NextResponse.json(
        { error: "Subscription not found" },
        { status: 404 },
      );
    }
    console.error("Error fetching subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the subscription" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;
    const body = await request.json();

    const subscriptionData = await prisma.subscription.update({
      where: { id: subscriptionId },
      data: {
        startDate: body.startDate,
        endDate: body.endDate,
        requestStatus: body.requestStatus,
        tentativeStartDate: body.tentativeStartDate,
        tentativeSchedule: body.tentativeSchedule,
        requestNotes: body.requestNotes,
        feedbackFromConsultee: body.feedbackFromConsultee,
        feedbackFromConsultant: body.feedbackFromConsultant,
        rating: body.rating,
        subscriptionPlan: body.planId
          ? {
              connect: { id: body.planId },
            }
          : undefined,
      },
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
        appointments: {
          include: {
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

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    console.error("Error updating subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while updating the subscription" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  try {
    const { subscriptionId } = await params;

    const subscriptionData = await prisma.subscription.delete({
      where: { id: subscriptionId },
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
        appointments: {
          include: {
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

    return NextResponse.json({ data: subscriptionData }, { status: 200 });
  } catch (error) {
    console.error("Error deleting subscription:", error);
    return NextResponse.json(
      { error: "An error occurred while deleting the subscription" },
      { status: 500 },
    );
  }
}
