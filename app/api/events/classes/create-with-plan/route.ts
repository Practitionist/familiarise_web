import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { ClassContentSchema } from "@/schemas/PlanSchema";

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
        // Use topics from existingPlan fetched *before* the transaction
        const currentTopicIdsFromOuterScope = existingPlan.topics.map(t => t.id);
        console.log(`[Before Transaction Update] Topics from initial fetch for class plan ${id}:`, currentTopicIdsFromOuterScope);

        // Handle class contents update logic (as before)
        let classContentsUpdateData = {};
        if (classContents && Array.isArray(classContents)) {
          // Validate contents before deleting/creating
          const contentValidation = z.array(ClassContentSchema).safeParse(classContents);
          if (!contentValidation.success) {
             console.error("Invalid class contents provided:", contentValidation.error);
             throw new Error("Invalid data provided for class contents.");
          }
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
          console.log(`Updating class contents for plan ${id}. Creating ${classContents.length} new entries.`);
        } else {
          console.log(`No class contents provided for update on plan ${id}.`);
        }

        // Prepare the main update data
        const updateData: any = {
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
          ...classContentsUpdateData, // Spread the contents update if any
        };

        // Determine how to handle topics
        if (topicIds !== undefined) {
          // If topicIds are provided, use set to sync
          if (!Array.isArray(topicIds)) {
            console.error("topicIds was provided but is not an array:", topicIds);
            throw new Error("Invalid format for topicIds");
          }
          // Verify provided topicIds actually exist
          const topics = await tx.topic.findMany({
            where: { id: { in: topicIds } },
            select: { id: true }
          });
          if (topics.length !== topicIds.length) {
            const missingIds = topicIds.filter(reqId => !topics.some(dbTopic => dbTopic.id === reqId));
            console.error("Attempted to set non-existent topic IDs:", missingIds);
            throw new Error(`The following topic IDs do not exist: ${missingIds.join(', ')}`);
          }
          
          updateData.topics = {
            set: topicIds.map((topicId: string) => ({ id: topicId }))
          };
          console.log(`Syncing class topics with provided IDs: [${topicIds.join(', ')}]`);
        } else {
          // If topicIds is undefined, explicitly set topics to the list fetched *before* the transaction
          console.log("Class topicIds is undefined. Explicitly setting topics to list fetched before transaction.");
          updateData.topics = { 
            set: currentTopicIdsFromOuterScope.map(id => ({ id })) 
          };
        }

        // Execute the plan update
        const updatedClassPlan = await tx.classPlan.update({
          where: { id },
          data: updateData,
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
