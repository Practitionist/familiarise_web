import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import { ClassPlanSchema } from "@/schemas/plans";
import { ClassStatus } from "@prisma/client"; // Import Enum
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

// Schema for POST request body based on ClassPlanSchema
// Topics field name matches PlanSchema ('topics' instead of 'topicIds')
const PostClassWithPlanBodySchema = ClassPlanSchema.omit({
  planType: true,
  consultantProfile: true,
  startDate: true,
  endDate: true,
  topics: true, // Omit the inherited topics definition
}).extend({
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  // Redefine topics to expect an array of IDs without content validation
  topics: z
    .array(z.string().min(1, "Topic ID cannot be empty"))
    .min(1, "At least one topic ID is required"),
  // Fields for the class instance
  status: z.nativeEnum(ClassStatus).optional().default(ClassStatus.SCHEDULED),
  startDate: z
    .string()
    .optional()
    .nullable()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for startDate",
    }), // Validate string can be parsed as Date
});

// Schema for PATCH request body
// Makes most fields optional, requires plan 'id', adds 'classId'
const PatchClassWithPlanBodySchema =
  PostClassWithPlanBodySchema.partial().extend({
    id: z.string().min(1, "Class Plan ID is required for update"), // Plan ID is required
    classId: z.string().optional().nullable(), // Class Instance ID is optional
    // topics is already optional via partial()
    // Add endDate specific to PATCH updates
    endDate: z
      .string()
      .optional()
      .nullable()
      .refine((val) => !val || !isNaN(Date.parse(val)), {
        message: "Invalid date format for endDate",
      }),
  });

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    // --- Zod Validation ---
    const validationResult = PostClassWithPlanBodySchema.safeParse(body);

    if (!validationResult.success) {
      console.error("Validation Error (POST):", validationResult.error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;
    const {
      title,
      description,
      durationInMonths,
      price,
      priceCurrency,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      consultantProfileId,
      topics: topicIds, // Use validated 'topics' as 'topicIds' for connect logic
      certificateProvided,
      callsPerWeek,
      videoMeetings,
      emailSupport,
      classContents,
      status,
      startDate,
    } = validatedData;
    // --- End Zod Validation ---

    // Calculate end date only if startDate is provided and valid
    let start: Date | undefined = startDate ? new Date(startDate) : undefined;
    let end: Date | undefined = undefined;
    if (start && !isNaN(start.getTime())) {
      // Check if date is valid
      end = new Date(start);
      // Ensure durationInMonths is valid before using
      if (typeof durationInMonths === "number" && durationInMonths > 0) {
        end.setMonth(end.getMonth() + durationInMonths);
      } else {
        // Handle invalid durationInMonths if necessary, maybe throw error or default
        console.warn("Invalid durationInMonths provided:", durationInMonths);
        end = undefined; // Or set default end date logic
      }
    } else {
      start = undefined; // Treat invalid start date string as undefined
    }

    // Create class plan, instance, and appointments in a transaction
    const result = await prisma.$transaction(async (tx) => {
      // 1. Create the class plan using validated data
      const classPlan = await tx.classPlan.create({
        data: {
          title,
          description,
          durationInMonths,
          price,
          priceCurrency,
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
          topics: topicIds // Use validated topics here
            ? { connect: topicIds.map((id: string) => ({ id })) }
            : undefined,
          classContents: {
            create: classContents.map((content) => ({
              // No 'any' needed
              title: content.title,
              description: content.description,
              contentType: content.contentType ?? null, // Use nullish coalescing
              contentUrl: content.contentUrl ?? null, // Use nullish coalescing
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
          startDate: start, // Will be undefined if not provided
          endDate: end, // Will be undefined if start is not provided
          classPlan: { connect: { id: classPlan.id } },
          // Create initial appointments for the first month
          appointments: {
            // Only create appointments if startDate is defined
            create: start
              ? Array.from({ length: callsPerWeek * 4 }).map((_, index) => {
                  const appointmentDate = new Date(start!);
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
                })
              : undefined,
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
          waitlist: true,
        },
      });

      return { classPlan, classEvent };
    });

    return NextResponse.json({ data: result.classEvent }, { status: 201 });
  } catch (error) {
    Sentry.captureException(error);
    // --- Zod Error Handling ---
    if (error instanceof z.ZodError) {
      console.error("Validation Error (POST Catch):", error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: error.issues },
        { status: 400 },
      );
    }
    // --- End Zod Error Handling ---
    console.error("Error creating class with plan:", error);
    // Add more detailed logging
    let errorMessage = "An error occurred while creating the class";
    let errorDetails = null;
    if (error instanceof Error) {
      errorMessage = error.message;
      // Log stack trace for more context if available
      console.error("Stack trace:", error.stack);
      // Capture Prisma-specific errors if possible (example)
      if ("code" in error && "meta" in error) {
        // Basic check for Prisma error structure
        errorDetails = { code: error.code, meta: error.meta };
        console.error("Prisma Error Code:", error.code);
        console.error("Prisma Error Meta:", error.meta);
      }
    }
    return NextResponse.json(
      { error: errorMessage, details: errorDetails }, // Return more details
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

    // --- Zod Validation ---
    const validationResult = PatchClassWithPlanBodySchema.safeParse(body);

    if (!validationResult.success) {
      console.error("Validation Error (PATCH):", validationResult.error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;
    const {
      id, // Plan ID (required)
      classId, // Instance ID (optional)
      // Optional fields from validated data
      title,
      description,
      durationInMonths,
      price,
      priceCurrency,
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
      topics: topicIds, // Use validated 'topics' as 'topicIds' for connect/set logic
      classContents,
      status,
      startDate: startDateString, // Rename to avoid conflict with Date object
      endDate: endDateString, // Rename to avoid conflict with Date object
    } = validatedData;
    // --- End Zod Validation ---

    // Log validated fields (optional, adjust as needed)
    console.log("Validated fields for update:", {
      id,
      classId,
      title, // May be undefined
      // ... other fields if needed for logging
      status, // May be undefined
      topicIds, // May be undefined
    });

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

    // Check if trying to update instance fields without an instance (still necessary)
    if (
      !classToUpdate &&
      (status !== undefined ||
        startDateString !== undefined ||
        endDateString !== undefined)
    ) {
      return NextResponse.json(
        { error: "Cannot update status or dates: no class instance found" },
        { status: 400 },
      );
    }

    // Update class plan and related data in a transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // Use topics from existingPlan fetched *before* the transaction
        const currentTopicIdsFromOuterScope = existingPlan.topics.map(
          (t) => t.id,
        );
        console.log(
          `[Before Transaction Update] Topics from initial fetch for class plan ${id}:`,
          currentTopicIdsFromOuterScope,
        );

        // Handle class contents update logic (only if provided in validated data)
        let classContentsUpdateData = {};
        if (classContents && Array.isArray(classContents)) {
          // Zod validation for contents already happened via main schema parse

          // Delete existing class contents first
          await tx.classContent.deleteMany({
            where: { classPlanId: id },
          });
          // Prepare new class contents for creation
          classContentsUpdateData = {
            classContents: {
              create: classContents.map((content) => ({
                // Use validated content
                title: content.title,
                description: content.description,
                contentType: content.contentType ?? null,
                contentUrl: content.contentUrl ?? null,
                order: content.order,
                hoursAllotted: content.hoursAllotted,
              })),
            },
          };
          console.log(
            `Updating class contents for plan ${id}. Creating ${classContents.length} new entries.`,
          );
        } else {
          console.log(`No class contents provided for update on plan ${id}.`);
        }

        // Prepare the main update data, only including fields present in validatedData
        const updateData: any = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (durationInMonths !== undefined)
          updateData.durationInMonths = durationInMonths;
        if (price !== undefined) updateData.price = price;
        if (priceCurrency !== undefined)
          updateData.priceCurrency = priceCurrency;
        if (certificateProvided !== undefined)
          updateData.certificateProvided = certificateProvided;
        if (callsPerWeek !== undefined) updateData.callsPerWeek = callsPerWeek;
        if (videoMeetings !== undefined)
          updateData.videoMeetings = videoMeetings;
        if (emailSupport !== undefined) updateData.emailSupport = emailSupport;
        if (maxParticipants !== undefined)
          updateData.maxParticipants = maxParticipants;
        if (language !== undefined) updateData.language = language;
        if (level !== undefined) updateData.level = level;
        if (prerequisites !== undefined)
          updateData.prerequisites = prerequisites; // handles null too
        if (materialProvided !== undefined)
          updateData.materialProvided = materialProvided; // handles null too
        if (learningOutcomes !== undefined)
          updateData.learningOutcomes = learningOutcomes;
        if (consultantProfileId !== undefined)
          updateData.consultantProfile = {
            connect: { id: consultantProfileId },
          };

        // Spread the contents update if any (only if classContents was in validatedData)
        if (classContents !== undefined) {
          Object.assign(updateData, classContentsUpdateData);
        }

        // Determine how to handle topics: Use validated 'topicIds' if provided in the request,
        // otherwise, do *not* modify topics (leave existing relation untouched).
        if (topicIds !== undefined) {
          // If topicIds are explicitly provided (even if empty array), use set to synchronize
          if (!Array.isArray(topicIds)) {
            // This case should be caught by Zod validation, but double-check defensively
            console.error(
              "topicIds was provided but is not an array:",
              topicIds,
            );
            throw new Error("Invalid format for topicIds");
          }
          // Verify provided topicIds actually exist (optional but recommended for robustness)
          const topics = await tx.topic.findMany({
            where: { id: { in: topicIds } },
            select: { id: true },
          });
          if (topics.length !== topicIds.length) {
            const missingIds = topicIds.filter(
              (reqId) => !topics.some((dbTopic) => dbTopic.id === reqId),
            );
            console.error(
              "Attempted to set non-existent topic IDs:",
              missingIds,
            );
            throw new Error(
              `The following topic IDs do not exist: ${missingIds.join(", ")}`,
            );
          }

          updateData.topics = {
            set: topicIds.map((topicId: string) => ({ id: topicId })),
          };
          console.log(
            `Syncing class topics with provided IDs: [${topicIds.join(", ")}]`,
          );
        } else {
          // If topicIds (validatedData.topics) is undefined, do *not* include the topics key in the updateData.
          // This leaves the existing topic relations untouched.
          console.log(
            "Class topics is undefined in the request. Existing topics will not be modified.",
          );
          // No `updateData.topics = ...` line here
        }

        // Execute the plan update only if there's data to update
        let updatedClassPlan = existingPlan; // Start with existing if no updates
        // Check if updateData has keys, or if topics/contents were explicitly provided for update
        if (
          Object.keys(updateData).length > 0 ||
          topicIds !== undefined ||
          classContents !== undefined
        ) {
          updatedClassPlan = await tx.classPlan.update({
            where: { id }, // Use validated id
            data: updateData,
            include: {
              consultantProfile: true,
              topics: true,
              classContents: true,
              classes: true, // Keep included to match existingPlan type
            },
          });
        }

        console.log("Updated class plan:", {
          id: updatedClassPlan.id,
          title: updatedClassPlan.title,
          topicsCount: updatedClassPlan.topics.length,
          contentsCount: updatedClassPlan.classContents.length,
        });

        // Update the class instance if it exists and relevant fields are provided
        let updatedClass = classToUpdate;
        if (updatedClass) {
          // Prepare update data for the Class instance, handling optional validated fields
          const classUpdateData: {
            status?: ClassStatus;
            startDate?: Date | null;
            endDate?: Date | null;
          } = {};

          // Only include status if it's provided in the validated data
          if (status !== undefined) {
            classUpdateData.status = status;
          }

          // Handle startDate: update if provided, set to null if explicitly null, otherwise leave unchanged
          // Need to parse the string date from validated data
          if (startDateString !== undefined) {
            classUpdateData.startDate = startDateString
              ? new Date(startDateString)
              : null;
            // Optional: Add check for valid date parsing: !isNaN(classUpdateData.startDate?.getTime())
            if (
              classUpdateData.startDate &&
              isNaN(classUpdateData.startDate.getTime())
            ) {
              console.warn(
                "Invalid startDate received in PATCH:",
                startDateString,
              );
              // Decide how to handle: throw error, ignore, set null?
              // For now, let's ignore the invalid date update for startDate
              delete classUpdateData.startDate;
            }
          }

          // Handle endDate: update if provided, set to null if explicitly null, otherwise leave unchanged
          if (endDateString !== undefined) {
            classUpdateData.endDate = endDateString
              ? new Date(endDateString)
              : null;
            // Optional: Add check for valid date parsing
            if (
              classUpdateData.endDate &&
              isNaN(classUpdateData.endDate.getTime())
            ) {
              console.warn("Invalid endDate received in PATCH:", endDateString);
              // Ignore invalid date update for endDate
              delete classUpdateData.endDate;
            }
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
                waitlist: true,
              },
            });
          }
        }

        // Return the results
        return {
          classPlan: updatedClassPlan,
          class: updatedClass,
        };
      },
      {
        timeout: 10000, // 10 second timeout
        maxWait: 5000, // 5 second max wait
        isolationLevel: "Serializable", // Highest isolation level
      },
    );

    console.log(
      "Update transaction completed successfully. Returning updated class data.",
    );

    // Return the appropriate response based on whether we had a class instance
    // Ensure topics are included in the response if only the plan was updated
    const responseData = result.class
      ? result.class // Contains nested plan with topics
      : { ...result.classPlan, topics: result.classPlan.topics }; // Add topics explicitly if only plan returned

    return NextResponse.json({ data: responseData }, { status: 200 });
  } catch (error) {
    Sentry.captureException(error);
    // --- Zod Error Handling ---
    if (error instanceof z.ZodError) {
      console.error("Validation Error (PATCH Catch):", error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: error.issues },
        { status: 400 },
      );
    }
    // --- End Zod Error Handling ---

    console.error("Error updating class with plan:", error);

    // If error indicates topics don't exist (keep specific error handling)
    if (
      error instanceof Error &&
      error.message.includes("The following topic IDs do not exist:") // More specific check
    ) {
      return NextResponse.json(
        { error: `Invalid topics provided: ${error.message}` },
        { status: 400 },
      );
    }
    if (
      error instanceof Error &&
      error.message === "Invalid data provided for class contents." // Catch specific content error
    ) {
      return NextResponse.json(
        { error: "Invalid class contents provided." },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "An error occurred while updating the class" },
      { status: 500 },
    );
  }
}
