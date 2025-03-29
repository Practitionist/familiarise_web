import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      // Class Plan data
      title,
      description,
      durationInMonths,
      price,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
      topicIds,
      certificateProvided,
      callsPerWeek,
      videoMeetings,
      emailSupport,
      classContents,
      // Additional fields for class instance
      status = "SCHEDULED",
      startDate,
    } = body;

    // Input validation
    if (
      !title ||
      !durationInMonths ||
      !price ||
      !maxParticipants ||
      !consultantProfileId ||
      !startDate ||
      !callsPerWeek ||
      !classContents?.length
    ) {
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Calculate end date (startDate + durationInMonths)
    const start = new Date(startDate);
    const end = new Date(start);
    end.setMonth(end.getMonth() + durationInMonths);

    // Create class plan, instance, and appointments in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create the class plan
      const classPlan = await tx.classPlan.create({
        data: {
          title,
          description,
          durationInMonths,
          price,
          maxParticipants,
          language,
          level,
          prerequisites,
          materialProvided,
          learningOutcomes,
          certificateProvided,
          callsPerWeek,
          videoMeetings,
          emailSupport,
          consultantProfile: { connect: { id: consultantProfileId } },
          topics: topicIds
            ? { connect: topicIds.map((id: string) => ({ id })) }
            : undefined,
          classContents: {
            create: classContents.map((content: any) => ({
              title: content.title,
              description: content.description,
              contentType: content.contentType,
              contentUrl: content.contentUrl,
              order: content.order,
              hoursAllotted: content.hoursAllotted,
            })),
          },
        },
        include: {
          consultantProfile: true,
          topics: true,
          classContents: true,
        },
      });

      // 2. Create the class instance with appointments
      const classEvent = await tx.class.create({
        data: {
          status,
          startDate: start,
          endDate: end,
          classPlan: { connect: { id: classPlan.id } },
          // Create initial appointments for the first month
          appointments: {
            create: Array.from({ length: callsPerWeek * 4 }).map((_, index) => {
              const appointmentDate = new Date(start);
              appointmentDate.setDate(
                appointmentDate.getDate() +
                  Math.floor(index / callsPerWeek) * 7,
              );
              const slotStart = new Date(appointmentDate);
              const slotEnd = new Date(appointmentDate);
              slotEnd.setHours(slotEnd.getHours() + 1); // Default 1-hour slots

              return {
                appointmentType: "CLASS",
                slotsOfAppointment: {
                  create: {
                    slotStartTimeInUTC: slotStart,
                    slotEndTimeInUTC: slotEnd,
                    isTentative: true, // Mark as tentative until confirmed
                  },
                },
              };
            }),
          },
        },
        include: {
          classPlan: {
            include: {
              consultantProfile: true,
              topics: true,
              classContents: true,
            },
          },
          appointments: {
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

      return { classPlan, classEvent };
    });

    return NextResponse.json({ data: result.classEvent }, { status: 201 });
  } catch (error) {
    console.error("Error creating class with plan:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the class" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    console.log(
      "Received class update request body:",
      JSON.stringify(body, null, 2),
    );

    const {
      id, // Class plan ID to update
      // Class Plan data
      title,
      description,
      durationInMonths,
      price,
      certificateProvided,
      callsPerWeek,
      videoMeetings,
      emailSupport,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
      topicIds,
      classContents,
      // Additional fields for class instance
      status,
      startDate,
      endDate,
      classId, // The actual class instance ID
    } = body;

    // Log extracted fields
    console.log("Extracted fields for update:", {
      id,
      classId,
      title,
      durationInMonths,
      price,
      maxParticipants,
      consultantProfileId,
      topicIds,
      status,
    });

    // Input validation
    if (!id) {
      return NextResponse.json(
        { error: "Missing class plan ID for update" },
        { status: 400 },
      );
    }

    if (
      !title ||
      !durationInMonths ||
      !price ||
      !maxParticipants ||
      !consultantProfileId
    ) {
      console.log("Validation failed. Missing required fields:", {
        hasTitle: !!title,
        hasDuration: !!durationInMonths,
        hasPrice: !!price,
        hasMaxParticipants: !!maxParticipants,
        hasConsultantId: !!consultantProfileId,
      });
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // First, check if the class plan exists
    const existingPlan = await prisma.classPlan.findUnique({
      where: { id },
      include: {
        topics: true,
        classContents: true,
        classes: true,
      },
    });

    if (!existingPlan) {
      return NextResponse.json(
        { error: `Class plan with ID ${id} not found` },
        { status: 404 },
      );
    }

    // Get the class instance - use the provided classId or the first one associated with the plan
    const classToUpdate = classId 
      ? await prisma.class.findUnique({
          where: { id: classId },
        })
      : existingPlan.classes.length > 0 
        ? existingPlan.classes[0] 
        : null;

    if (!classToUpdate && (status || startDate || endDate)) {
      return NextResponse.json(
        { error: "Cannot update status or dates: no class instance found" },
        { status: 400 },
      );
    }

    // Update class plan and related data in a transaction
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

        // 1. Update the class plan
        console.log("Updating class plan with data:", {
          id,
          title,
          description,
          topicIds,
        });

        // First disconnect existing topics if new topicIds are provided
        if (topicIds && topicIds.length > 0) {
          await tx.classPlan.update({
            where: { id },
            data: {
              topics: {
                set: [], // Disconnect all existing topics
              },
            },
          });
        }

        // Handle class contents if provided
        let classContentsUpdateData = {};
        if (classContents && Array.isArray(classContents)) {
          // Delete existing class contents first
          await tx.classContent.deleteMany({
            where: { classPlanId: id },
          });

          // Prepare new class contents for creation
          classContentsUpdateData = {
            classContents: {
              create: classContents.map((content: any) => ({
                title: content.title,
                description: content.description,
                contentType: content.contentType || null,
                contentUrl: content.contentUrl || null,
                order: content.order,
                hoursAllotted: content.hoursAllotted,
              })),
            },
          };
        }

        // Then update the plan with all new data
        const updatedClassPlan = await tx.classPlan.update({
          where: { id },
          data: {
            title,
            description,
            durationInMonths,
            price,
            certificateProvided,
            callsPerWeek,
            videoMeetings,
            emailSupport,
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
            ...classContentsUpdateData,
          },
          include: {
            consultantProfile: true,
            topics: true,
            classContents: true,
          },
        });

        console.log("Updated class plan:", {
          id: updatedClassPlan.id,
          title: updatedClassPlan.title,
          topicsCount: updatedClassPlan.topics.length,
          contentsCount: updatedClassPlan.classContents.length,
        });

        // 2. Update the class instance if it exists
        let updatedClass = classToUpdate;
        if (updatedClass) {
          const classUpdateData: any = {};
          
          if (status) {
            classUpdateData.status = status;
          }
          
          if (startDate) {
            classUpdateData.startDate = new Date(startDate);
          }
          
          if (endDate) {
            classUpdateData.endDate = new Date(endDate);
          }
          
          if (Object.keys(classUpdateData).length > 0) {
            updatedClass = await tx.class.update({
              where: { id: updatedClass.id },
              data: classUpdateData,
              include: {
                classPlan: {
                  include: {
                    consultantProfile: true,
                    topics: true,
                    classContents: true,
                  },
                },
                appointments: {
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
          } else {
            // If we have a class instance but no updates, fetch it with all its relations
            updatedClass = await tx.class.findUnique({
              where: { id: updatedClass.id },
              include: {
                classPlan: {
                  include: {
                    consultantProfile: true,
                    topics: true,
                    classContents: true,
                  },
                },
                appointments: {
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
        }

        // Return the results
        return { 
          classPlan: updatedClassPlan,
          class: updatedClass 
        };
      },
      {
        timeout: 10000, // 10 second timeout
        maxWait: 5000, // 5 second max wait
        isolationLevel: "Serializable", // Highest isolation level
      },
    );

    console.log("Update transaction completed successfully. Returning updated class data.");
    
    // Return the appropriate response based on whether we had a class instance
    const responseData = result.class 
      ? result.class
      : { ...result.classPlan, topics: result.classPlan.topics };
      
    return NextResponse.json({ data: responseData }, { status: 200 });
  } catch (error) {
    console.error("Error updating class with plan:", error);

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
      { error: "An error occurred while updating the class" },
      { status: 500 },
    );
  }
}
