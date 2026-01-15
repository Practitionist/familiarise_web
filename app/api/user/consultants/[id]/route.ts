import prisma from "@/lib/prisma";
import { Prisma, ScheduleType, SessionType } from "@prisma/client";
import { getServerSession } from "next-auth";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import authOptions from "../../../auth/[...nextauth]/options";
import { experienceValidation } from "@/schemas/shared";

// Zod schema for UUID validation
const uuidSchema = z.string().uuid();

// Zod schema for date-time string validation
const dateTimeSchema = z.string().datetime({ offset: true });

// Zod schema for weekly slot
const weeklySlotSchema = z.object({
  dayOfWeekforStartTimeInUTC: z.enum([
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ]),
  dayOfWeekforEndTimeInUTC: z.enum([
    "MONDAY",
    "TUESDAY",
    "WEDNESDAY",
    "THURSDAY",
    "FRIDAY",
    "SATURDAY",
    "SUNDAY",
  ]),
  slotStartTimeInUTC: dateTimeSchema,
  slotEndTimeInUTC: dateTimeSchema,
});

// Zod schema for custom slot
const customSlotSchema = z.object({
  slotStartTimeInUTC: dateTimeSchema,
  slotEndTimeInUTC: dateTimeSchema,
});

// Main request body schema
const updateConsultantSchema = z
  .object({
    description: z.string().optional(),
    qualifications: z.string().optional(),
    specialization: z.string().optional(),
    experience: experienceValidation,
    scheduleType: z.enum(["WEEKLY", "CUSTOM"]),
    domainId: uuidSchema,
    subDomainIds: z.array(uuidSchema),
    tagIds: z.array(uuidSchema),
    slotsOfAvailabilityWeekly: z.array(weeklySlotSchema).optional(),
    slotsOfAvailabilityCustom: z.array(customSlotSchema).optional(),
    // New fields
    headline: z.string().max(120).optional(),
    websiteUrl: z.string().url().optional().or(z.literal("")),
    twitterUrl: z.string().url().optional().or(z.literal("")),
    githubUrl: z.string().url().optional().or(z.literal("")),
    videoIntroUrl: z.string().url().optional().or(z.literal("")),
    languages: z.array(z.string()).optional(),
    toolsAndTechnologies: z.array(z.string()).optional(),
    mentoringStyle: z.string().optional(),
    sessionTypes: z.array(z.nativeEnum(SessionType)).optional(),
  })
  .refine(
    (data) => {
      if (data.scheduleType === "WEEKLY") {
        return (
          data.slotsOfAvailabilityWeekly &&
          data.slotsOfAvailabilityWeekly.length > 0
        );
      }
      if (data.scheduleType === "CUSTOM") {
        return (
          data.slotsOfAvailabilityCustom &&
          data.slotsOfAvailabilityCustom.length > 0
        );
      }
      return false;
    },
    {
      message: "Must provide corresponding slots array based on scheduleType",
      path: ["scheduleType"],
    },
  );

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // const session = await getServerSession(authOptions);
    // if (!session) {
    //   return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    // }

    const { id } = await params;
    if (!id) {
      return NextResponse.json(
        { error: "Consultant ID is required" },
        { status: 400 },
      );
    }

    const consultant = await prisma.consultantProfile.findUnique({
      where: { id },
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
        workExperiences: true,
        certifications: true,
        education: true,
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
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;
    const requestData = await request.json();

    // Validate request body using zod schema
    const validationResult = updateConsultantSchema.safeParse(requestData);
    if (!validationResult.success) {
      return NextResponse.json(
        {
          error: "Validation failed",
          details: validationResult.error.format(),
        },
        { status: 400 },
      );
    }

    const data = validationResult.data;
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
      // New fields
      headline,
      websiteUrl,
      twitterUrl,
      githubUrl,
      videoIntroUrl,
      languages,
      toolsAndTechnologies,
      mentoringStyle,
      sessionTypes,
    } = data;

    // Check if schedule type is being changed
    const existingConsultant = await prisma.consultantProfile.findUnique({
      where: { id },
      select: { scheduleType: true },
    });

    if (
      existingConsultant &&
      existingConsultant.scheduleType !== scheduleType
    ) {
      // Validate that there are no active appointments before allowing switch
      const [
        pendingConsultations,
        activeSubscriptions,
        upcomingWebinars,
        upcomingClasses,
      ] = await Promise.all([
        prisma.consultation.count({
          where: {
            consultationPlan: { consultantProfileId: id },
            requestStatus: {
              in: [
                "PENDING",
                "APPROVED",
                "APPROVED_PENDING_PAYMENT",
                "SCHEDULED",
              ],
            },
          },
        }),
        prisma.subscription.count({
          where: {
            subscriptionPlan: { consultantProfileId: id },
            requestStatus: {
              in: [
                "PENDING",
                "APPROVED",
                "APPROVED_PENDING_PAYMENT",
                "SCHEDULED",
              ],
            },
          },
        }),
        prisma.webinar.count({
          where: {
            webinarPlan: { consultantProfileId: id },
            status: { in: ["SCHEDULED", "IN_PROGRESS"] },
            appointment: {
              slotsOfAppointment: {
                some: { startsAt: { gte: new Date() } },
              },
            },
          },
        }),
        prisma.class.count({
          where: {
            classPlan: { consultantProfileId: id },
            status: { in: ["SCHEDULED", "IN_PROGRESS"] },
          },
        }),
      ]);

      const totalPending =
        pendingConsultations +
        activeSubscriptions +
        upcomingWebinars +
        upcomingClasses;

      if (totalPending > 0) {
        return NextResponse.json(
          {
            error: `Cannot switch schedule type while you have ${totalPending} active appointment(s). Please complete or cancel them first.`,
            code: "SCHEDULE_SWITCH_BLOCKED",
            breakdown: {
              pendingConsultations,
              activeSubscriptions,
              upcomingWebinars,
              upcomingClasses,
            },
          },
          { status: 400 },
        );
      }
    }

    // Update consultant profile
    await prisma.consultantProfile.update({
      where: { id },
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
        // New fields
        headline: headline ?? null,
        websiteUrl: websiteUrl || null,
        twitterUrl: twitterUrl || null,
        githubUrl: githubUrl || null,
        videoIntroUrl: videoIntroUrl || null,
        languages: languages ?? [],
        toolsAndTechnologies: toolsAndTechnologies ?? [],
        mentoringStyle: mentoringStyle ?? null,
        sessionTypes: sessionTypes ?? [],
      },
    });

    // Update weekly slots if schedule type is WEEKLY
    if (scheduleType === ScheduleType.WEEKLY) {
      // Delete existing weekly slots
      await prisma.slotOfAvailabilityWeekly.deleteMany({
        where: { consultantProfileId: id },
      });

      // Create new weekly slots
      if (slotsOfAvailabilityWeekly?.length) {
        const weeklySlotData: Prisma.SlotOfAvailabilityWeeklyCreateManyInput[] =
          slotsOfAvailabilityWeekly.map((slot) => ({
            consultantProfileId: id,
            dayOfWeekForStartsAt: slot.dayOfWeekforStartTimeInUTC,
            dayOfWeekForEndsAt: slot.dayOfWeekforEndTimeInUTC,
            availabilityStartsAt: new Date(slot.slotStartTimeInUTC),
            availabilityEndsAt: new Date(slot.slotEndTimeInUTC),
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
        where: { consultantProfileId: id },
      });

      // Create new custom slots
      if (slotsOfAvailabilityCustom?.length) {
        const customSlotData: Prisma.SlotOfAvailabilityCustomCreateManyInput[] =
          slotsOfAvailabilityCustom.map((slot) => ({
            consultantProfileId: id,
            availabilityStartsAt: new Date(slot.slotStartTimeInUTC),
            availabilityEndsAt: new Date(slot.slotEndTimeInUTC),
          }));

        await prisma.slotOfAvailabilityCustom.createMany({
          data: customSlotData,
        });
      }
    }

    // Fetch and return the updated consultant with all relations
    const updatedConsultant = await prisma.consultantProfile.findUnique({
      where: { id },
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
        workExperiences: true,
        certifications: true,
        education: true,
      },
    });

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
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { id } = await params;

    // Delete all related records first
    await prisma.$transaction([
      // Delete slots
      prisma.slotOfAvailabilityWeekly.deleteMany({
        where: { consultantProfileId: id },
      }),
      prisma.slotOfAvailabilityCustom.deleteMany({
        where: { consultantProfileId: id },
      }),

      // Delete plans
      prisma.consultationPlan.deleteMany({
        where: { consultantProfileId: id },
      }),
      prisma.subscriptionPlan.deleteMany({
        where: { consultantProfileId: id },
      }),
      prisma.webinarPlan.deleteMany({
        where: { consultantProfileId: id },
      }),
      prisma.classPlan.deleteMany({
        where: { consultantProfileId: id },
      }),

      // Delete reviews
      prisma.consultantReview.deleteMany({
        where: { consultantProfileId: id },
      }),

      // Delete the consultant profile
      prisma.consultantProfile.delete({
        where: { id },
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
