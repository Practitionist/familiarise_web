import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    console.log(
      "Received webinar creation request body:",
      JSON.stringify(body, null, 2),
    );

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
    console.log("Extracted fields:", {
      title,
      durationInHours,
      price,
      maxParticipants,
      consultantProfileId,
      scheduledAt,
      topicIds,
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
      console.log("Validation failed. Missing required fields:", {
        hasTitle: !!title,
        hasDuration: !!durationInHours,
        hasPrice: !!price,
        hasMaxParticipants: !!maxParticipants,
        hasConsultantId: !!consultantProfileId,
        hasScheduledAt: !!scheduledAt,
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

    console.log("Calculated times:", {
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      durationInHours,
    });

    // Create webinar plan, instance, and appointment in a transaction
    const result = await prisma.$transaction(
      async (tx) => {
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
        console.log("Creating webinar plan with data:", {
          title,
          description,
          durationInHours,
          price,
          maxParticipants,
          consultantProfileId,
          topicIds,
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

        console.log("Created webinar plan:", {
          id: webinarPlan.id,
          title: webinarPlan.title,
          topicsCount: webinarPlan.topics.length,
        });

        // 2. Create the webinar instance
        console.log("Creating webinar instance with plan ID:", webinarPlan.id);

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

        console.log("Created webinar instance:", {
          id: webinar.id,
          planId: webinar.webinarPlan.id,
          appointmentId: webinar.appointment?.id,
          hasSlots: webinar.appointment?.slotsOfAppointment?.length ?? 0 > 0,
        });

        return { webinarPlan, webinar };
      },
      {
        timeout: 10000, // 10 second timeout
        maxWait: 5000, // 5 second max wait
        isolationLevel: "Serializable", // Highest isolation level
      },
    );

    console.log("Transaction completed successfully. Returning webinar data.");
    return NextResponse.json({ data: result.webinar }, { status: 201 });
  } catch (error) {
    console.error("Error creating webinar with plan:", error);

    // If error indicates topics don't exist, we don't need to do cleanup
    if (
      error instanceof Error &&
      error.message === "Some topics do not exist"
    ) {
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

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    console.log(
      "Received webinar update request body:",
      JSON.stringify(body, null, 2),
    );

    const {
      id, // Webinar plan ID to update
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
      status,
      webinarId, // The actual webinar instance ID
    } = body;

    // Log extracted fields
    console.log("Extracted fields for update:", {
      id,
      webinarId,
      title,
      durationInHours,
      price,
      maxParticipants,
      consultantProfileId,
      scheduledAt,
      topicIds,
      status,
    });

    // Input validation
    if (!id) {
      return NextResponse.json(
        { error: "Missing webinar plan ID for update" },
        { status: 400 },
      );
    }

    if (
      !title ||
      !durationInHours ||
      !price ||
      !maxParticipants ||
      !consultantProfileId
    ) {
      console.log("Validation failed. Missing required fields:", {
        hasTitle: !!title,
        hasDuration: !!durationInHours,
        hasPrice: !!price,
        hasMaxParticipants: !!maxParticipants,
        hasConsultantId: !!consultantProfileId,
      });
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // First, check if the webinar plan exists
    const existingPlan = await prisma.webinarPlan.findUnique({
      where: { id },
      include: {
        topics: true,
        webinars: {
          include: {
            appointment: {
              include: {
                slotsOfAppointment: true,
              },
            },
          },
        },
      },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: `Webinar plan with ID ${id} not found` },
        { status: 404 },
      );
    }

    // Calculate end time if scheduledAt is provided
    let startTime: Date | undefined;
    let endTime: Date | undefined;
    
    if (scheduledAt) {
      startTime = new Date(scheduledAt);
      endTime = new Date(startTime);
      endTime.setHours(endTime.getHours() + durationInHours);
      
      console.log("Calculated times for update:", {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        durationInHours,
      });
    }

    // Get the webinar instance - use the provided webinarId or the first one associated with the plan
    const webinarToUpdate = webinarId 
      ? await prisma.webinar.findUnique({
          where: { id: webinarId },
          include: {
            appointment: {
              include: {
                slotsOfAppointment: true,
              },
            },
          },
        })
      : existingPlan.webinars.length > 0 
        ? existingPlan.webinars[0] 
        : null;

    if (!webinarToUpdate && (status || scheduledAt)) {
      return NextResponse.json(
        { error: "Cannot update status or schedule: no webinar instance found" },
        { status: 400 },
      );
    }

    // Update webinar plan and related data in a transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // Verify all topics exist if topicIds is provided
        if (topicIds && topicIds.length > 0) {
          const topics = await tx.topic.findMany({
            where: { id: { in: topicIds } },
          });

          if (topics.length !== topicIds.length) {
            throw new Error("Some topics do not exist");
          }
        }

        // 1. Update the webinar plan
        console.log("Updating webinar plan with data:", {
          id,
          title,
          description,
          topicIds,
        });

        // First disconnect existing topics if new topicIds are provided
        if (topicIds && topicIds.length > 0) {
          await tx.webinarPlan.update({
            where: { id },
            data: {
              topics: {
                set: [], // Disconnect all existing topics
              },
            },
          });
        }

        // Then update the plan with all new data
        const updatedWebinarPlan = await tx.webinarPlan.update({
          where: { id },
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
            topics: topicIds && topicIds.length > 0
              ? { connect: topicIds.map((topicId: string) => ({ id: topicId })) }
              : undefined,
          },
          include: {
            consultantProfile: true,
            topics: true,
          },
        });

        console.log("Updated webinar plan:", {
          id: updatedWebinarPlan.id,
          title: updatedWebinarPlan.title,
          topicsCount: updatedWebinarPlan.topics.length,
        });

        // 2. Update the webinar instance if it exists and status is provided
        let updatedWebinar = webinarToUpdate;
        if (updatedWebinar && status) {
          updatedWebinar = await tx.webinar.update({
            where: { id: updatedWebinar.id },
            data: {
              status,
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
        }

        // 3. Update appointment slot timing if scheduledAt is provided and we have an appointment
        if (startTime && endTime && updatedWebinar?.appointment) {
          // Update the first slot (or create if none exists)
          if (updatedWebinar.appointment.slotsOfAppointment.length > 0) {
            await tx.slotOfAppointment.update({
              where: { id: updatedWebinar.appointment.slotsOfAppointment[0].id },
              data: {
                slotStartTimeInUTC: startTime,
                slotEndTimeInUTC: endTime,
              },
            });
          } else {
            await tx.slotOfAppointment.create({
              data: {
                appointmentId: updatedWebinar.appointment.id,
                slotStartTimeInUTC: startTime,
                slotEndTimeInUTC: endTime,
                isTentative: false,
              },
            });
          }
        }

        // Fetch the fully updated webinar if it exists
        if (updatedWebinar) {
          const finalWebinar = await tx.webinar.findUnique({
            where: { id: updatedWebinar.id },
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
          
          return { 
            webinarPlan: updatedWebinarPlan, 
            webinar: finalWebinar 
          };
        }

        // Return just the plan if no webinar instance exists
        return { 
          webinarPlan: updatedWebinarPlan,
          webinar: null
        };
      },
      {
        timeout: 10000, // 10 second timeout
        maxWait: 5000, // 5 second max wait
        isolationLevel: "Serializable", // Highest isolation level
      },
    );

    console.log("Update transaction completed successfully. Returning updated webinar data.");
    
    // Return the appropriate response based on whether we had a webinar instance
    const responseData = result.webinar 
      ? result.webinar
      : { ...result.webinarPlan, topics: result.webinarPlan.topics };
      
    return NextResponse.json({ data: responseData }, { status: 200 });
  } catch (error) {
    console.error("Error updating webinar with plan:", error);

    // If error indicates topics don't exist
    if (
      error instanceof Error &&
      error.message === "Some topics do not exist"
    ) {
      return NextResponse.json(
        { error: "Invalid topics provided" },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "An error occurred while updating the webinar" },
      { status: 500 },
    );
  }
}