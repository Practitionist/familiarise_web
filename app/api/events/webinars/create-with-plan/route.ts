import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      // Webinar Plan data
      title,
      description,
      durationInHours,
      price,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
      topicIds,
      scheduledAt,
      // Additional fields for webinar instance
      status = "SCHEDULED",
    } = body;

    // Input validation
    if (
      !title ||
      !durationInHours ||
      !price ||
      !maxParticipants ||
      !consultantProfileId ||
      !scheduledAt
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Calculate end time
    const startTime = new Date(scheduledAt);
    const endTime = new Date(startTime);
    endTime.setHours(endTime.getHours() + durationInHours);

    // Create webinar plan, instance, and appointment in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create the webinar plan
      const webinarPlan = await tx.webinarPlan.create({
        data: {
          title,
          description,
          durationInHours,
          price,
          maxParticipants,
          language,
          level,
          prerequisites,
          materialProvided,
          learningOutcomes,
          consultantProfile: { connect: { id: consultantProfileId } },
          topics: topicIds
            ? { connect: topicIds.map((id: string) => ({ id })) }
            : undefined,
        },
        include: {
          consultantProfile: true,
          topics: true,
        },
      });

      // 2. Create the webinar instance
      const webinar = await tx.webinar.create({
        data: {
          status,
          webinarPlan: { connect: { id: webinarPlan.id } },
          // Create the appointment at the same time
          appointment: {
            create: {
              appointmentType: "WEBINAR",
              slotsOfAppointment: {
                create: {
                  slotStartTimeInUTC: startTime,
                  slotEndTimeInUTC: endTime,
                  isTentative: false,
                },
              },
            },
          },
        },
        include: {
          webinarPlan: {
            include: {
              consultantProfile: true,
              topics: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: {
                include: {
                  user: true,
                },
              },
            },
          },
          meetingRoom: true,
          waitlist: true,
        },
      });

      return { webinarPlan, webinar };
    });

    return NextResponse.json({ data: result.webinar }, { status: 201 });
  } catch (error) {
    console.error("Error creating webinar with plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the webinar" },
      { status: 500 },
    );
  }
} 