import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> }
) {
  try {
    const { subscriptionId } = await params;

    const appointments = await prisma.appointment.findMany({
      where: {
        subscriptionId: subscriptionId,
        appointmentType: "SUBSCRIPTION",
      },
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
          orderBy: {
            slotStartTimeInUTC: "asc",
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
      },
      orderBy: {
        createdAt: "asc",
      },
    });

    return NextResponse.json({ data: appointments });
  } catch (error) {
    console.error("Error fetching subscription appointments:", error);
    return NextResponse.json(
      { error: "Failed to fetch subscription appointments" },
      { status: 500 }
    );
  }
}












