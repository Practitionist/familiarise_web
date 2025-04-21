import prisma from "@/lib/prisma";
import { AppointmentsType } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";

// Define the expected structure of the request body
interface AllocationRequestBody {
  slots: string[]; // Array of ISO 8601 date strings for start times
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const { webinarId } = await params;

  if (!webinarId) {
    return NextResponse.json(
      { error: "Webinar ID is required" },
      { status: 400 },
    );
  }

  let requestBody: AllocationRequestBody;
  try {
    requestBody = await request.json();
  } catch (error) {
    // Log the specific error before returning generic response
    console.error("Failed to parse request body:", error);
    return NextResponse.json(
      { error: "Invalid request body" },
      { status: 400 },
    );
  }

  const { slots } = requestBody;

  // Webinars typically only have one slot
  if (!Array.isArray(slots) || slots.length !== 1) {
    return NextResponse.json(
      { error: "Webinar requires exactly one slot" },
      { status: 400 },
    );
  }

  // Validate slot string as a date
  const slotData: { slotStartTimeInUTC: Date; slotEndTimeInUTC: Date }[] = [];
  const startTime = new Date(slots[0]);
  if (isNaN(startTime.getTime())) {
    return NextResponse.json(
      { error: `Invalid date format for slot: ${slots[0]}` },
      { status: 400 },
    );
  }
  // Assuming 30-minute slots for webinars based on EventTimingsCalendar logic
  const endTime = new Date(startTime.getTime() + 30 * 60 * 1000);
  slotData.push({ slotStartTimeInUTC: startTime, slotEndTimeInUTC: endTime });

  try {
    await prisma.$transaction(async (tx) => {
      // 1. Find the webinar to ensure it exists
      const webinar = await tx.webinar.findUnique({
        where: { id: webinarId },
      });

      if (!webinar) {
        throw new Error("Webinar not found");
      }

      // 2. Find existing appointment for this webinar
      // Webinars should only have one appointment
      const existingAppointment = await tx.appointment.findUnique({
        where: { webinarId: webinarId },
        select: { id: true },
      });

      // 3. If an appointment exists, delete its existing slots
      if (existingAppointment) {
        await tx.slotOfAppointment.deleteMany({
          where: { appointmentId: existingAppointment.id },
        });
      }

      // 4. Determine the appointment ID (create if doesn't exist)
      let appointmentId: string;
      if (!existingAppointment) {
        const newAppointment = await tx.appointment.create({
          data: {
            appointmentType: AppointmentsType.WEBINAR,
            webinar: {
              connect: { id: webinarId },
            },
          },
        });
        appointmentId = newAppointment.id;
      } else {
        appointmentId = existingAppointment.id;
      }

      // 5. Create the new slot
      await tx.slotOfAppointment.create({
        data: {
          appointmentId: appointmentId,
          slotStartTimeInUTC: slotData[0].slotStartTimeInUTC,
          slotEndTimeInUTC: slotData[0].slotEndTimeInUTC,
          // Add user connections if necessary based on webinar participants/host
        },
      });

      // Potential future step: Update Webinar status if needed (e.g., to SCHEDULED)
    });

    return NextResponse.json(
      { message: "Webinar slot allocated successfully" },
      { status: 200 },
    );
  } catch (error: any) {
    console.error("Error allocating webinar slot:", error);
    if (error.message === "Webinar not found") {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    return NextResponse.json(
      { error: "Failed to allocate webinar slot" },
      { status: 500 },
    );
  }
}
