import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { AppointmentsType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

// Define the expected structure of the request body
interface AllocationRequestBody {
  slots: string[]; // Array of ISO 8601 date strings for start times
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ classId: string }> },
) {
  const { classId } = await params;

  if (!classId) {
    return NextResponse.json(
      { error: "Class ID is required" },
      { status: 400 },
    );
  }

  let requestBody: AllocationRequestBody;
  try {
    requestBody = await request.json();
  } catch (error) {
    Sentry.captureException(error);
    // Log the specific error before returning generic response
    console.error("Failed to parse request body:", error);
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { slots } = requestBody;

  if (!Array.isArray(slots) || slots.length === 0) {
    return NextResponse.json(
      { error: "Slots array is required and must not be empty" },
      { status: 400 },
    );
  }

  // Validate slot strings as dates
  const slotData: { slotStartTimeInUTC: Date; slotEndTimeInUTC: Date }[] = [];
  for (const slotStr of slots) {
    const startTime = new Date(slotStr);
    if (isNaN(startTime.getTime())) {
      return NextResponse.json(
        { error: `Invalid date format for slot: ${slotStr}` },
        { status: 400 },
      );
    }
    // Assuming 30-minute slots for classes based on EventTimingsCalendar logic
    const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
    slotData.push({ slotStartTimeInUTC: startTime, slotEndTimeInUTC: endTime });
  }

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Find the class to ensure it exists
      const classPlan = await tx.class.findUnique({
        where: { id: classId },
      });

      if (!classPlan) {
        throw new Error("Class not found");
      }

      // 2. Find existing appointments for this class
      const existingAppointments = await tx.appointment.findMany({
        where: { classId: classId },
        select: { id: true },
      });

      // 3. Delete existing slots for all found appointments
      if (existingAppointments.length > 0) {
        const appointmentIds = existingAppointments.map((appt) => appt.id);
        await tx.slotOfAppointment.deleteMany({
          where: { appointmentId: { in: appointmentIds } },
        });
      }

      // 4. If no appointments exist, create one. Otherwise, use the first found one.
      let appointmentId: string;
      if (existingAppointments.length === 0) {
        const newAppointment = await tx.appointment.create({
          data: {
            appointmentType: AppointmentsType.CLASS,
            class: {
              connect: { id: classId },
            },
          },
        });
        appointmentId = newAppointment.id;
      } else {
        appointmentId = existingAppointments[0].id;
        // Optionally, delete other appointments if logic requires only one per class
        if (existingAppointments.length > 1) {
          const idsToDelete = existingAppointments.slice(1).map((a) => a.id);
          await tx.appointment.deleteMany({
            where: { id: { in: idsToDelete } },
          });
        }
      }

      // 5. Create the new slots
      await tx.slotOfAppointment.createMany({
        data: slotData.map((slot) => ({
          appointmentId: appointmentId,
          slotStartTimeInUTC: slot.slotStartTimeInUTC,
          slotEndTimeInUTC: slot.slotEndTimeInUTC,
          // Add user connections if necessary based on class participants
        })),
      });

      // Potential future step: Update Class status if needed (e.g., to SCHEDULED)
    });

    return NextResponse.json(
      { message: "Class slots allocated successfully" },
      { status: 200 },
    );
  } catch (error: any) {
    Sentry.captureException(error);
    console.error("Error allocating class slots:", error);
    // Check for specific known errors (like 'Class not found')
    if (error.message === "Class not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    // Generic error for other issues
    return NextResponse.json(
      { error: "Failed to allocate class slots" },
      { status: 500 },
    );
  }
}
