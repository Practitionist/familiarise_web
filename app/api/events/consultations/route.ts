import prisma from "@/lib/prisma";
import { checkOverlappingAppointments } from "@/lib/appointmentUtils";
import { NextResponse } from "next/server";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const consulteeId = searchParams.get('consulteeId');
    const consultantId = searchParams.get('consultantId');

    let consultations;

    if (consulteeId) {
      consultations = await prisma.consultation.findMany({
        where: {
          requestedBy: { id: consulteeId }
        },
        include: {
          consultationPlan: true,
          requestedBy: true,
          appointment: {
            include: {
              slotOfAppointment: true
            }
          }
        }
      });
    } else if (consultantId) {
      consultations = await prisma.consultation.findMany({
        where: {
          consultationPlan: {
            consultantProfile: { id: consultantId }
          }
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: true
            }
          },
          requestedBy: true,
          appointment: {
            include: {
              slotOfAppointment: true
            }
          }
        }
      });
    } else {
      consultations = await prisma.consultation.findMany({
        include: {
          consultationPlan: true,
          requestedBy: true,
          appointment: {
            include: {
              slotOfAppointment: true
            }
          }
        }
      });
    }

    return NextResponse.json({ data: consultations }, { status: 200 });
  } catch (error) {
    console.error("Error fetching consultations:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching consultations" },
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
            connect: { id: body.consultationPlanId },
          },
          requestedBy: {
            connect: { id: body.consulteeProfileId },
          },
          requestStatus: "PENDING",
          directlyBooked: true,
        },
      });

      const appointment = await prisma.appointment.create({
        data: {
          appointmentType: "CONSULTATION",
          consultation: {
            connect: { id: consultation.id },
          },
          slotOfAppointment: {
            create: {
              slotStartTimeInUTC: new Date(body.startTime),
              slotEndTimeInUTC: new Date(body.endTime),
              consulteeProfile: {
                connect: { id: body.consulteeProfileId },
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
    console.error("Error creating consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the consultation" },
      { status: 500 }
    );
  }
}
