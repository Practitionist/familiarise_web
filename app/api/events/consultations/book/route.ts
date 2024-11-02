import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { getServerSession } from "next-auth/next";
import authOptions from "@/app/api/auth/[...nextauth]/options";
import { DayOfWeek } from "@prisma/client";

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session || !session.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { consultationPlanId, preferredDateTime, requestNotes } =
      await request.json();

    const consultee = await prisma.consulteeProfile.findUnique({
      where: { userId: session.user.id },
    });

    if (!consultee) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const consultationPlan = await prisma.consultationPlan.findUnique({
      where: { id: consultationPlanId },
      include: { consultantProfile: true },
    });

    if (!consultationPlan) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }

    // Check for existing pending requests for the same slot
    const existingRequests = await prisma.consultation.findMany({
      where: {
        consultationPlanId: consultationPlanId,
        preferredDateTime: new Date(preferredDateTime),
        requestStatus: "PENDING",
      },
    });

    if (existingRequests.length > 0) {
      return NextResponse.json(
        { error: "Slot is currently pending approval for another request" },
        { status: 409 },
      );
    }

    const consultation = await prisma.consultation.create({
      data: {
        consultationPlan: { connect: { id: consultationPlanId } },
        requestedBy: { connect: { id: consultee.id } },
        preferredDateTime: new Date(preferredDateTime),
        requestNotes,
        requestStatus: "PENDING",
        directlyBooked: false,
      },
    });

    const appointmentEndTime = new Date(
      new Date(preferredDateTime).getTime() +
        consultationPlan.durationInHours * 60 * 60 * 1000,
    );

    if (consultationPlan.consultantProfile.scheduleType === "WEEKLY") {
      // Find the corresponding weekly slot of availability
      const dayOfWeek = getDayOfWeek(new Date(preferredDateTime).getUTCDay());
      const slotOfAvailability =
        await prisma.slotOfAvailabilityWeekly.findFirst({
          where: {
            consultantProfileId: consultationPlan.consultantProfile.id,
            dayOfWeekforStartTimeInUTC: dayOfWeek,
            slotStartTimeInUTC: {
              equals: new Date(preferredDateTime).toISOString().split("T")[1],
            },
          },
        });

      if (slotOfAvailability) {
        await prisma.appointment.create({
          data: {
            appointmentType: "CONSULTATION",
            consultation: { connect: { id: consultation.id } },
            slotOfAppointment: {
              create: {
                slotStartTimeInUTC: new Date(preferredDateTime),
                slotEndTimeInUTC: appointmentEndTime,
                consulteeProfile: { connect: { id: consultee.id } },
              },
            },
          },
        });
      }
    } else {
      // For custom schedule, create an appointment without creating a new SlotOfAvailabilityCustom
      await prisma.appointment.create({
        data: {
          appointmentType: "CONSULTATION",
          consultation: { connect: { id: consultation.id } },
          slotOfAppointment: {
            create: {
              slotStartTimeInUTC: new Date(preferredDateTime),
              slotEndTimeInUTC: appointmentEndTime,
              consulteeProfile: { connect: { id: consultee.id } },
            },
          },
        },
      });
    }

    return NextResponse.json({ consultation }, { status: 201 });
  } catch (error) {
    console.error("Error booking consultation:", error);
    return NextResponse.json(
      { error: "An error occurred while booking the consultation" },
      { status: 500 },
    );
  }
}

function getDayOfWeek(day: number): DayOfWeek {
  const days: DayOfWeek[] = [
    "SUNDAY",
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
  ];
  return days[day] as DayOfWeek;
}
