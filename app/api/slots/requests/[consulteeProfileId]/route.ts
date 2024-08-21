import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";

export async function GET(
  req: NextRequest,
  { params }: { params: { consulteeProfileId: string } }
) {
  try {
    const slotRequests = await prisma.slotOfAppointmentRequest.findMany({
      where: {
        slotsOfAppointment: {
          consulteeProfileId: params.consulteeProfileId,
        },
      },
      include: {
        slotOfAvailabiltyWeekly: true,
        slotOfAvailabiltyCustom: true,
        slotsOfAppointment: {
          include: {
            consulteeProfile: true,
          },
        },
      },
    });
    return NextResponse.json(slotRequests, { status: 200 });
  } catch (error) {
    console.error("Error fetching slot requests:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const newSlotRequest = await prisma.slotOfAppointmentRequest.create({
      data: {
        status: body.status ?? "PENDING",
        slotOfAvailabiltyWeekly: {
          connect: { id: body.slotOfAvailabilityWeeklyId },
        },
        slotOfAvailabiltyCustom: {
          connect: { id: body.slotOfAvailabilityCustomId },
        },
        slotsOfAppointment: {
          create: {
            consulteeProfileId: body.consulteeProfileId,
            appointmentsType: body.appointmentsType,
          },
        },
        appointmentStartTimeInUTC: body.appointmentStartTimeInUTC,
        appointmentEndTimeInUTC: body.appointmentEndTimeInUTC,
      },
      include: {
        slotOfAvailabiltyWeekly: true,
        slotOfAvailabiltyCustom: true,
        slotsOfAppointment: {
          include: {
            consulteeProfile: true,
          },
        },
      },
    });

    return NextResponse.json(newSlotRequest, { status: 201 });
  } catch (error) {
    console.error("Error creating slot request:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: { consulteeProfileId: string } }
) {
  try {
    const body = await req.json();

    const updatedSlotRequest = await prisma.slotOfAppointmentRequest.update({
      where: { id: body.id },
      data: {
        status: body.status,
        slotOfAvailabiltyWeekly: {
          connect: { id: body.slotOfAvailabilityWeeklyId },
        },
        slotOfAvailabiltyCustom: {
          connect: { id: body.slotOfAvailabilityCustomId },
        },
        appointmentStartTimeInUTC: body.appointmentStartTimeInUTC,
        appointmentEndTimeInUTC: body.appointmentEndTimeInUTC,
      },
      include: {
        slotOfAvailabiltyWeekly: true,
        slotOfAvailabiltyCustom: true,
        slotsOfAppointment: {
          include: {
            consulteeProfile: true,
          },
        },
      },
    });

    return NextResponse.json(updatedSlotRequest, { status: 200 });
  } catch (error) {
    console.error("Error updating slot request:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { consulteeProfileId: string } }
) {
  try {
    const body = await req.json();

    const updatedSlotRequest = await prisma.slotOfAppointmentRequest.update({
      where: { id: body.id },
      data: {
        status: body.status,
        slotOfAvailabiltyWeekly: body.slotOfAvailabilityWeeklyId
          ? { connect: { id: body.slotOfAvailabilityWeeklyId } }
          : undefined,
        slotOfAvailabiltyCustom: body.slotOfAvailabilityCustomId
          ? { connect: { id: body.slotOfAvailabilityCustomId } }
          : undefined,
        appointmentStartTimeInUTC: body.appointmentStartTimeInUTC,
        appointmentEndTimeInUTC: body.appointmentEndTimeInUTC,
      },
      include: {
        slotOfAvailabiltyWeekly: true,
        slotOfAvailabiltyCustom: true,
        slotsOfAppointment: {
          include: {
            consulteeProfile: true,
          },
        },
      },
    });

    return NextResponse.json(updatedSlotRequest, { status: 200 });
  } catch (error) {
    console.error("Error partially updating slot request:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: { consulteeProfileId: string } }
) {
  try {
    const body = await req.json();
    await prisma.slotOfAppointmentRequest.delete({
      where: { id: body.id },
    });

    return NextResponse.json(
      { message: "Slot request deleted successfully" },
      { status: 200 }
    );
  } catch (error) {
    console.error("Error deleting slot request:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
