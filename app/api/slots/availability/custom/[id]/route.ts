import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { getSession } from "@/lib/auth-server";

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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "slots" } });
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

    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    // Fetch existing slot for authoritative consultantProfileId and ownership
    const currentSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id },
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (currentSlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
      );
    }

    const body = await req.json();

    if (!body.startsAt || !body.endsAt) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    if (isNaN(Date.parse(body.startsAt)) || isNaN(Date.parse(body.endsAt))) {
      return NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 },
      );
    }

    const startTime = new Date(body.startsAt);
    const endTime = new Date(body.endsAt);

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Reject consultant reassignment
    if (
      body.consultantProfileId &&
      body.consultantProfileId !== currentSlot.consultantProfileId
    ) {
      return NextResponse.json(
        { error: "Cannot reassign slot to a different consultant" },
        { status: 400 },
      );
    }

    // Check for overlapping slots using authoritative consultantProfileId
    const overlappingSlot = await prisma.slotOfAvailabilityCustom.findFirst({
      where: {
        id: { not: id },
        consultantProfileId: currentSlot.consultantProfileId,
        OR: [
          {
            startsAt: { lte: startTime },
            endsAt: { gt: startTime },
          },
          {
            startsAt: { lt: endTime },
            endsAt: { gte: endTime },
          },
          {
            startsAt: { gte: startTime },
            endsAt: { lte: endTime },
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
        startsAt: startTime,
        endsAt: endTime,
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
    Sentry.captureException(error instanceof Error ? error : new Error(String(error)), { tags: { subsystem: "slots" } });
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

    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await req.json();

    const currentSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id: id },
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!currentSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (currentSlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
      );
    }

    // Reject consultant reassignment
    if (
      body.consultantProfileId &&
      body.consultantProfileId !== currentSlot.consultantProfileId
    ) {
      return NextResponse.json(
        { error: "Cannot reassign slot to a different consultant" },
        { status: 400 },
      );
    }

    if (
      (body.startsAt && isNaN(Date.parse(body.startsAt))) ||
      (body.endsAt && isNaN(Date.parse(body.endsAt)))
    ) {
      return NextResponse.json(
        { error: "Invalid date format" },
        { status: 400 },
      );
    }

    const startTime = body.startsAt
      ? new Date(body.startsAt)
      : currentSlot.startsAt;
    const endTime = body.endsAt ? new Date(body.endsAt) : currentSlot.endsAt;

    if (startTime >= endTime) {
      return NextResponse.json(
        { error: "Start time must be before end time" },
        { status: 400 },
      );
    }

    // Check for overlapping slots using authoritative consultantProfileId
    const overlappingSlot = await prisma.slotOfAvailabilityCustom.findFirst({
      where: {
        id: { not: id },
        consultantProfileId: currentSlot.consultantProfileId,
        OR: [
          {
            startsAt: { lte: startTime },
            endsAt: { gt: startTime },
          },
          {
            startsAt: { lt: endTime },
            endsAt: { gte: endTime },
          },
          {
            startsAt: { gte: startTime },
            endsAt: { lte: endTime },
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
        startsAt: startTime,
        endsAt: endTime,
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

    // Auth check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const customSlot = await prisma.slotOfAvailabilityCustom.findUnique({
      where: { id },
      include: { consultantProfile: { select: { userId: true } } },
    });

    if (!customSlot) {
      return NextResponse.json(
        { error: "Custom slot not found" },
        { status: 404 },
      );
    }

    // Ownership check
    if (customSlot.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "Forbidden: you do not own this slot" },
        { status: 403 },
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
