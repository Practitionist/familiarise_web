import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import authOptions from "../../../auth/[...nextauth]/options";
import prisma from "@/lib/prisma";
import { ScheduleType, DayOfWeek, Prisma } from "@prisma/client";

interface WeeklySlot {
  dayOfWeekforStartTimeInUTC: DayOfWeek;
  dayOfWeekforEndTimeInUTC: DayOfWeek;
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}

interface CustomSlot {
  slotStartTimeInUTC: string;
  slotEndTimeInUTC: string;
}

interface UpdateConsultantData {
  description?: string;
  qualifications?: string;
  specialization?: string;
  experience?: string;
  scheduleType: ScheduleType;
  domainId: string;
  subDomainIds: string[];
  tagIds: string[];
  slotsOfAvailabilityWeekly?: WeeklySlot[];
  slotsOfAvailabilityCustom?: CustomSlot[];
  language?: string;
  level?: string;
  prerequisites?: string;
}

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const consultant = await prisma.consultantProfile.findUnique({
      where: { id: params.id },
      include: {
        user: true,
        domain: true,
        subDomains: true,
        tags: true,
        slotsOfAvailabilityWeekly: true,
        slotsOfAvailabilityCustom: true,
        consultationPlans: true,
        subscriptionPlans: true,
        webinarPlans: true,
        classPlans: true,
      },
    });

    if (!consultant) {
      return NextResponse.json(
        { error: "Consultant not found" },
        { status: 404 },
      );
    }

    return NextResponse.json({ data: consultant });
  } catch (error) {
    console.error("Error fetching consultant:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const data: UpdateConsultantData = await request.json();
    const {
      description,
      qualifications,
      specialization,
      experience,
      scheduleType,
      domainId,
      subDomainIds,
      tagIds,
      slotsOfAvailabilityWeekly,
      slotsOfAvailabilityCustom,
      language,
      level,
      prerequisites,
    } = data;

    // Validate required fields
    if (!domainId) {
      return NextResponse.json(
        { error: "Domain is required" },
        { status: 400 },
      );
    }

    // Update consultant profile
    const updatedConsultant = await prisma.consultantProfile.update({
      where: { id: params.id },
      data: {
        description,
        qualifications,
        specialization,
        experience,
        scheduleType,
        domain: {
          connect: { id: domainId },
        },
        subDomains: {
          set: subDomainIds.map((id: string) => ({ id })),
        },
        tags: {
          set: tagIds.map((id: string) => ({ id })),
        },
      },
    });

    // Update weekly slots if schedule type is WEEKLY
    if (scheduleType === ScheduleType.WEEKLY) {
      // Delete existing weekly slots
      await prisma.slotOfAvailabilityWeekly.deleteMany({
        where: { consultantProfileId: params.id },
      });

      // Create new weekly slots
      if (slotsOfAvailabilityWeekly?.length) {
        const weeklySlotData: Prisma.SlotOfAvailabilityWeeklyCreateManyInput[] =
          slotsOfAvailabilityWeekly.map((slot) => ({
            consultantProfileId: params.id,
            dayOfWeekforStartTimeInUTC: slot.dayOfWeekforStartTimeInUTC,
            dayOfWeekforEndTimeInUTC: slot.dayOfWeekforEndTimeInUTC,
            slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
            slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
          }));

        await prisma.slotOfAvailabilityWeekly.createMany({
          data: weeklySlotData,
        });
      }
    }

    // Update custom slots if schedule type is CUSTOM
    if (scheduleType === ScheduleType.CUSTOM) {
      // Delete existing custom slots
      await prisma.slotOfAvailabilityCustom.deleteMany({
        where: { consultantProfileId: params.id },
      });

      // Create new custom slots
      if (slotsOfAvailabilityCustom?.length) {
        const customSlotData: Prisma.SlotOfAvailabilityCustomCreateManyInput[] =
          slotsOfAvailabilityCustom.map((slot) => ({
            consultantProfileId: params.id,
            slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
            slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
          }));

        await prisma.slotOfAvailabilityCustom.createMany({
          data: customSlotData,
        });
      }
    }

    // Update service settings in all plans if provided
    if (language || level || prerequisites) {
      await Promise.all([
        // Update consultation plans
        prisma.consultationPlan.updateMany({
          where: { consultantProfileId: params.id },
          data: {
            ...(language && { language }),
            ...(level && { level }),
            ...(prerequisites && { prerequisites }),
          },
        }),
        // Update subscription plans
        prisma.subscriptionPlan.updateMany({
          where: { consultantProfileId: params.id },
          data: {
            ...(language && { language }),
            ...(level && { level }),
            ...(prerequisites && { prerequisites }),
          },
        }),
        // Update webinar plans
        prisma.webinarPlan.updateMany({
          where: { consultantProfileId: params.id },
          data: {
            ...(language && { language }),
            ...(level && { level }),
            ...(prerequisites && { prerequisites }),
          },
        }),
        // Update class plans
        prisma.classPlan.updateMany({
          where: { consultantProfileId: params.id },
          data: {
            ...(language && { language }),
            ...(level && { level }),
            ...(prerequisites && { prerequisites }),
          },
        }),
      ]);
    }

    return NextResponse.json({ data: updatedConsultant });
  } catch (error) {
    console.error("Error updating consultant:", error);
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Delete all related records first
    await prisma.$transaction([
      // Delete slots
      prisma.slotOfAvailabilityWeekly.deleteMany({
        where: { consultantProfileId: params.id },
      }),
      prisma.slotOfAvailabilityCustom.deleteMany({
        where: { consultantProfileId: params.id },
      }),

      // Delete plans
      prisma.consultationPlan.deleteMany({
        where: { consultantProfileId: params.id },
      }),
      prisma.subscriptionPlan.deleteMany({
        where: { consultantProfileId: params.id },
      }),
      prisma.webinarPlan.deleteMany({
        where: { consultantProfileId: params.id },
      }),
      prisma.classPlan.deleteMany({
        where: { consultantProfileId: params.id },
      }),

      // Delete reviews
      prisma.consultantReview.deleteMany({
        where: { consultantProfileId: params.id },
      }),

      // Delete the consultant profile
      prisma.consultantProfile.delete({
        where: { id: params.id },
      }),
    ]);

    return NextResponse.json({ message: "Consultant deleted successfully" });
  } catch (error) {
    console.error("Error deleting consultant:", error);
    if (error instanceof Error) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}
