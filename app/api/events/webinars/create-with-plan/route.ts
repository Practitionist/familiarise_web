import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    console.log('Received webinar creation request body:', JSON.stringify(body, null, 2));

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

    // Log extracted fields
    console.log('Extracted fields:', {
      title,
      durationInHours,
      price,
      maxParticipants,
      consultantProfileId,
      scheduledAt,
      topicIds
    });

    // Input validation
    if (
      !title ||
      !durationInHours ||
      !price ||
      !maxParticipants ||
      !consultantProfileId ||
      !scheduledAt
    ) {
      console.log('Validation failed. Missing required fields:', {
        hasTitle: !!title,
        hasDuration: !!durationInHours,
        hasPrice: !!price,
        hasMaxParticipants: !!maxParticipants,
        hasConsultantId: !!consultantProfileId,
        hasScheduledAt: !!scheduledAt
      });
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Calculate end time
    const startTime = new Date(scheduledAt);
    const endTime = new Date(startTime);
    endTime.setHours(endTime.getHours() + durationInHours);
    
    console.log('Calculated times:', {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationInHours
    });

    // Create webinar plan, instance, and appointment in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // Verify all topics exist
      if (topicIds && topicIds.length > 0) {
        const topics = await tx.topic.findMany({
          where: { id: { in: topicIds } },
        });

        if (topics.length !== topicIds.length) {
          throw new Error("Some topics do not exist");
        }
      }

      // 1. Create the webinar plan
      console.log('Creating webinar plan with data:', {
        title,
        description,
        durationInHours,
        price,
        maxParticipants,
        consultantProfileId,
        topicIds
      });

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

      console.log('Created webinar plan:', {
        id: webinarPlan.id,
        title: webinarPlan.title,
        topicsCount: webinarPlan.topics.length
      });

      // 2. Create the webinar instance
      console.log('Creating webinar instance with plan ID:', webinarPlan.id);

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

      console.log('Created webinar instance:', {
        id: webinar.id,
        planId: webinar.webinarPlan.id,
        appointmentId: webinar.appointment?.id,
        hasSlots: webinar.appointment?.slotsOfAppointment?.length ?? 0 > 0
      });

      return { webinarPlan, webinar };
    }, {
      timeout: 10000, // 10 second timeout
      maxWait: 5000,  // 5 second max wait
      isolationLevel: 'Serializable' // Highest isolation level
    });

    console.log('Transaction completed successfully. Returning webinar data.');
    return NextResponse.json({ data: result.webinar }, { status: 201 });
  } catch (error) {
    console.error("Error creating webinar with plan:", error);

    // If error indicates topics don't exist, we don't need to do cleanup
    if (error instanceof Error && error.message === "Some topics do not exist") {
      return NextResponse.json(
        { error: "Invalid topics provided" },
        { status: 400 },
      );
    }

    // For other errors, attempt to clean up any created topics if needed
    // This would be handled by the calling service if topics were created in the same transaction

    return NextResponse.json(
      { error: "An error occurred while creating the webinar" },
      { status: 500 },
    );
  }
} 