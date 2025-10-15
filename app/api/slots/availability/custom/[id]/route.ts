import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const customSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id: id },
      include: {
        consultantProfile: true,
      },
    });

    if (!customSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: customSlot }, { status: 200 });
  } catch (error) {
    console.error("Error fetching custom slot:", error);
    return NextResponse.json(
      { error: "An error occurred while fetching the custom slot" },
      { status: 500 },
    );
  }
}

export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();

    if (!body.availabilityStartsAt || !body.availabilityEndsAt) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    const startTime = new Date(body.availabilityStartsAt);
    const endTime = new Date(body.availabilityEndsAt);

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots
    const overlappingSlot = await prisma.slotOfAvailabilityCustom.findFirst({
      where: {
        id: { not: id },
        consultantProfileId: body.consultantProfileId,
        OR: [
          {
            availabilityStartsAt: { lte: startTime },
            availabilityEndsAt: { gt: startTime },
          },
          {
            availabilityStartsAt: { lt: endTime },
            availabilityEndsAt: { gte: endTime },
          },
          {
            availabilityStartsAt: { gte: startTime },
            availabilityEndsAt: { lte: endTime },
          },
        ],
      },
    });

    if (overlappingSlot) {
      return NextResponse.json(
        { error: "This slot overlaps with an existing slot" },
        { status: 409 },
      );
    }

    const updatedSlot = await prisma.slotOfAvailabilityCustom.update({
      where: { id: id },
      data: {
        availabilityStartsAt: startTime,
        availabilityEndsAt: endTime,
        consultantProfile: body.consultantProfileId
          ? { connect: { id: body.consultantProfileId } }
          : undefined,
      },
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json({ data: updatedSlot }, { status: 200 });
  } catch (error) {
    console.error("Error updating custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Custom slot not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the custom slot" },
      { status: 500 },
    );
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const body = await req.json();

    const currentSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id: id },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
        { status: 404 },
      );
    }

    const startTime = body.availabilityStartsAt
      ? new Date(body.availabilityStartsAt)
      : currentSlot.availabilityStartsAt;
    const endTime = body.availabilityEndsAt
      ? new Date(body.availabilityEndsAt)
      : currentSlot.availabilityEndsAt;

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots
    const overlappingSlot = await prisma.slotOfAvailabilityCustom.findFirst({
      where: {
        id: { not: id },
        consultantProfileId:
          body.consultantProfileId || currentSlot.consultantProfileId,
        OR: [
          {
            availabilityStartsAt: { lte: startTime },
            availabilityEndsAt: { gt: startTime },
          },
          {
            availabilityStartsAt: { lt: endTime },
            availabilityEndsAt: { gte: endTime },
          },
          {
            availabilityStartsAt: { gte: startTime },
            availabilityEndsAt: { lte: endTime },
          },
        ],
      },
    });

    if (overlappingSlot) {
      return NextResponse.json(
        { error: "This slot overlaps with an existing slot" },
        { status: 409 },
      );
    }

    const updatedSlot = await prisma.slotOfAvailabilityCustom.update({
      where: { id: id },
      data: {
        availabilityStartsAt: startTime,
        availabilityEndsAt: endTime,
        consultantProfile: body.consultantProfileId
          ? { connect: { id: body.consultantProfileId } }
          : undefined,
      },
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json({ data: updatedSlot }, { status: 200 });
  } catch (error) {
    console.error("Error partially updating custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Custom slot not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while updating the custom slot" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    // Check if there are any associated appointments
    const associatedAppointments = await prisma.slotOfAppointment.findMany({
      where: { id: id },
    });

    if (associatedAppointments.length > 0) {
      return NextResponse.json(
        { error: "Cannot delete custom slot with associated appointments" },
        { status: 400 },
      );
    }

    const deletedSlot = await prisma.slotOfAvailabilityCustom.delete({
      where: { id: id },
      include: {
        consultantProfile: true,
      },
    });

    return NextResponse.json(
      { message: "Custom slot deleted successfully", data: deletedSlot },
      { status: 200 },
    );
  } catch (error) {
    console.error("Error deleting custom slot:", error);
    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2025") {
        return NextResponse.json(
          { error: "Custom slot not found" },
          { status: 404 },
        );
      }
    }
    return NextResponse.json(
      { error: "An error occurred while deleting the custom slot" },
      { status: 500 },
    );
  }
}
