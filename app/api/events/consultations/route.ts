import prisma from "@/lib/prisma";
import { NextResponse } from "next/server";
import { checkOverlappingAppointments } from "@/lib/appointmentUtils";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeId = searchParams.get('consulteeId');
    const consultantId = searchParams.get('consultantId');

    let consultations;

    if (consulteeId) {
      consultations = await prisma.consultation.findMany({
        where: {
          requestedById: consulteeId
        }
      });
    } else if (consultantId) {
      consultations = await prisma.consultation.findMany({
        where: {
          consultationPlan: {
            consultantProfileId: consultantId
          }
        }
      });
    } else {
      consultations = await prisma.consultation.findMany({});
    }

    return NextResponse.json({ data: consultations }, { status: 200 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}


export async function POST(request: Request) {
  try {
    const body = await request.json();

    // Check for overlapping appointments
    const isOverlapping = await checkOverlappingAppointments(
      new Date(body.startTime),
      new Date(body.endTime),
      body.consultantProfileId
    );

    if (isOverlapping) {
      return NextResponse.json(
        { error: "This time slot is already booked" },
        { status: 409 }
      );
    }

    // Create the consultation and associated appointment in a transaction
    const result = await prisma.$transaction(async (prisma) => {
      const consultation = await prisma.consultation.create({
        data: {
          consultationPlan: {
            connect: {
              id: body.consultationPlanId,
            },
          },
          requestedBy: {
            connect: {
              id: body.consulteeProfileId,
            },
          },
          appointmentRequestStatus: "PENDING",
          directlyBooked: true,
        },
      });

      const appointment = await prisma.appointment.create({
        data: {
          appointmentType: "CONSULTATION",
          consultation: {
            connect: {
              id: consultation.id,
            },
          },
          slotOfAppointment: {
            create: {
              appointmentStartTimeInUTC: new Date(body.startTime),
              appointmentEndTimeInUTC: new Date(body.endTime),
              appointmentsType: "CONSULTATION",
              consulteeProfile: {
                connect: {
                  id: body.consulteeProfileId,
                },
              },
              slotOfAvailabilityCustom: {
                create: {
                  slotStartTimeInUTC: new Date(body.startTime),
                  slotEndTimeInUTC: new Date(body.endTime),
                  consultantProfile: {
                    connect: {
                      id: body.consultantProfileId,
                    },
                  },
                },
              },
            },
          },
        },
        include: {
          slotOfAppointment: true,
        },
      });

      return { consultation, appointment };
    });

    return NextResponse.json({ data: result }, { status: 201 });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}