import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WebinarPlanSchema } from "@/schemas/plans";
import { WebinarStatus } from "@prisma/client";
import { getServerSession } from "next-auth";
import authOptions from "@/app/api/auth/[...nextauth]/options";

// Schema for POST request body based on WebinarPlanSchema
const PostWebinarWithPlanBodySchema = WebinarPlanSchema.omit({
  consultantProfile: true, // We use consultantProfileId
  topics: true, // We use topicIds instead
  scheduledAt: true, // We redefine below
  // priceCurrency is inherited from WebinarPlanSchema (which inherits from BaseEventPlanSchema)
}).extend({
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  topicIds: z.array(z.string()).min(1, "At least one topic ID is required"), // Expect topicIds
  // scheduledAt: Allow string, null, or undefined. Validate string if provided.
  scheduledAt: z
    .string()
    .optional()
    .nullable()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for scheduledAt",
    }),
  // Fields for the webinar instance
  status: z
    .nativeEnum(WebinarStatus)
    .optional()
    .default(WebinarStatus.SCHEDULED),
  // DO NOT define priceCurrency here, it's inherited and has default in base
});

// Schema for PATCH request body
// Inherits from corrected PostWebinarWithPlanBodySchema
const PatchWebinarWithPlanBodySchema = PostWebinarWithPlanBodySchema.omit({
  topicIds: true, // Make topicIds optional separately
})
  .partial()
  .extend({
    id: z.string().min(1, "Webinar Plan ID is required for update"), // Plan ID is required
    webinarId: z.string().optional().nullable(), // Webinar Instance ID is optional
    topicIds: z.array(z.string()).optional(), // topicIds is optional for PATCH
    // scheduledAt is already optional via partial()
    // priceCurrency is already optional via partial() inherited from base
  });

export async function POST(request: NextRequest) {
  try {
    // Authentication check
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await request.json();
    console.log(
      "Received webinar creation request body:",
      JSON.stringify(body, null, 2),
    );

    // --- Zod Validation ---
    const validationResult = PostWebinarWithPlanBodySchema.safeParse(body);
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
      durationInHours,
      price,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      priceCurrency,
      consultantProfileId,
      topicIds,
      scheduledAt,
      status,
    } = validatedData;
    // --- End Zod Validation ---

    // Verify ownership - user must own this consultant profile
    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: {
        id: consultantProfileId,
        userId: session.user.id,
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        { error: "You do not have permission to create webinars for this consultant profile" },
        { status: 403 },
      );
    }

    // Log validated fields
    console.log("Validated fields:", {
      title,
      durationInHours,
      price,
      maxParticipants,
      consultantProfileId,
      scheduledAt,
      topicIds,
      status,
    });

    // Calculate end time using validated data if scheduledAt is provided
    let startTime: Date | undefined = undefined;
    let endTime: Date | undefined = undefined;

    if (scheduledAt) {
      // Zod refine ensures parseable date if scheduledAt is a string
      const parsedStartTime = new Date(scheduledAt);
      if (!isNaN(parsedStartTime.getTime())) {
        startTime = parsedStartTime;
        endTime = new Date(startTime);
        // Zod ensures durationInHours is a valid number
        endTime.setHours(startTime.getHours() + durationInHours);
        console.log("Calculated times:", {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          durationInHours,
        });
      } else {
        // Handle case where refine might somehow miss an invalid date string
        // Or if null was somehow passed despite schema (shouldn't happen)
        console.warn(
          "Invalid date format received for scheduledAt despite validation:",
          scheduledAt,
        );
        // startTime and endTime remain undefined
      }
    } else {
      console.log(
        "No scheduledAt provided. Webinar will be created without an initial appointment.",
      );
      // startTime and endTime remain undefined
    }

    // Create webinar plan, instance, and appointment in a transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // Verify all topics exist (still useful within transaction)
        if (topicIds && topicIds.length > 0) {
          const topics = await tx.topic.findMany({
            where: { id: { in: topicIds } },
            select: { id: true }, // Only select ID for verification
          });

          if (topics.length !== topicIds.length) {
            const missingIds = topicIds.filter(
              (reqId) => !topics.some((dbTopic) => dbTopic.id === reqId),
            );
            throw new Error(
              `The following topic IDs do not exist: ${missingIds.join(", ")}`,
            );
          }
        }

        // 1. Create the webinar plan using validated data
        console.log("Creating webinar plan with validated data:", {
          title,
          description,
          durationInHours,
          price,
          maxParticipants,
          consultantProfileId,
          topicIds, // Log topicIds
        });

        const webinarPlan = await tx.webinarPlan.create({
          data: {
            // Spread validated plan fields
            title,
            description,
            durationInHours,
            price,
            priceCurrency,
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

        // 2. Create the webinar instance using validated data
        console.log("Creating webinar instance with plan ID:", webinarPlan.id);

        const webinar = await tx.webinar.create({
          data: {
            status, // Use validated status
            webinarPlan: { connect: { id: webinarPlan.id } },
            // Create the appointment at the same time
            // Ensure startTime and endTime are valid before creating appointment
            appointment:
              startTime && endTime
                ? {
                    // Check if dates were successfully calculated
                    create: {
                      appointmentType: "WEBINAR",
                      slotsOfAppointment: {
                        create: {
                          startsAt: startTime, // Use calculated startTime
                          endsAt: endTime, // Use calculated endTime
                          isTentative: false,
                        },
                      },
                    },
                  }
                : undefined, // Don't create appointment if no valid scheduledAt
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
            waitlist: true,
          },
        });

        console.log("Created webinar instance:", {
          id: webinar.id,
          planId: webinar.webinarPlanId,
          appointmentId: webinar.appointment?.id,
          hasSlots: (webinar.appointment?.slotsOfAppointment?.length ?? 0) > 0,
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
    // --- Zod Error Handling ---
    if (error instanceof z.ZodError) {
      console.error("Validation Error (POST Catch):", error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: error.issues },
        { status: 400 },
      );
    }
    // --- End Zod Error Handling ---

    console.error("Error creating webinar with plan:", error);

    // If error indicates topics don't exist, handle specifically
    if (
      error instanceof Error &&
      error.message.includes("The following topic IDs do not exist:") // More specific check
    ) {
      return NextResponse.json(
        { error: `Invalid topics provided: ${error.message}` },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "An error occurred while creating the webinar" },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    // Authentication check
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await request.json();
    console.log(
      "Received webinar update request body:",
      JSON.stringify(body, null, 2),
    );

    // --- Zod Validation ---
    const validationResult = PatchWebinarWithPlanBodySchema.safeParse(body);
    if (!validationResult.success) {
      console.error("Validation Error (PATCH):", validationResult.error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: validationResult.error.issues },
        { status: 400 },
      );
    }

    const validatedData = validationResult.data;
    const {
      id, // Webinar plan ID (required)
      webinarId, // Webinar instance ID (optional)
      // Optional fields from validated data
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
      topicIds, // Use validated topicIds directly
      status,
      scheduledAt, // Optional string date
      priceCurrency, // <-- Add this line back
    } = validatedData;
    // --- End Zod Validation ---

    // Log validated fields
    console.log("Validated fields for update:", {
      id,
      webinarId,
      title, // May be undefined
      durationInHours, // May be undefined
      // ... other fields if needed for logging ...
      topicIds: topicIds ? `[${topicIds.length} topics]` : "undefined",
      status, // May be undefined
      scheduledAt, // May be undefined
    });

    // Remove old manual validation
    // if (!id) { ... } // Handled by Zod
    // if (!title || !durationInHours || ...) { ... } // Handled by Zod (optionality)

    // First, check if the webinar plan exists (still necessary)
    const existingPlan = await prisma.webinarPlan.findUnique({
      where: { id },
      include: {
        consultantProfile: true,
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

    // Verify ownership - user must own this webinar plan
    if (!existingPlan.consultantProfile ||
        existingPlan.consultantProfile.userId !== session.user.id) {
      return NextResponse.json(
        { error: "You do not have permission to update this webinar" },
        { status: 403 },
      );
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

    if (
      !webinarToUpdate &&
      (status !== undefined || scheduledAt !== undefined)
    ) {
      return NextResponse.json(
        {
          error:
            "Cannot update status or scheduling: no webinar instance found",
        },
        { status: 400 },
      );
    }

    // Calculate startTime and endTime if scheduledAt is provided
    let startTime = undefined;
    let endTime = undefined;

    // Use the validated scheduledAt (optional) and durationInHours (required if scheduledAt provided for calc)
    if (scheduledAt) {
      // Zod refine should ensure valid date string if present
      const scheduledDate = new Date(scheduledAt);
      if (isNaN(scheduledDate.getTime())) {
        throw new Error(
          "Invalid scheduledAt date format after validation (PATCH).",
        );
      }

      startTime = scheduledDate;

      // Duration needed to calculate end time. Use plan's existing if not provided in patch.
      // Ensure durationInHours from validatedData (optional) or existingPlan is valid
      const effectiveDuration = durationInHours ?? existingPlan.durationInHours;
      if (typeof effectiveDuration !== "number" || effectiveDuration <= 0) {
        throw new Error("Invalid duration for calculating end time.");
      }

      const endTimeDate = new Date(scheduledDate);
      endTimeDate.setHours(endTimeDate.getHours() + effectiveDuration);
      endTime = endTimeDate;

      console.log("Calculated slot times (PATCH):", {
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        effectiveDuration,
      });
    } else if (
      durationInHours !== undefined &&
      webinarToUpdate?.appointment?.slotsOfAppointment[0]
    ) {
      // Handle case where only duration changes, recalculate end time based on existing start time
      const existingSlot = webinarToUpdate.appointment.slotsOfAppointment[0];
      startTime = existingSlot.startsAt; // Keep existing start time
      endTime = new Date(startTime);
      endTime.setHours(startTime.getHours() + durationInHours);
      console.log(
        "Recalculated slot end time due to duration change (PATCH):",
        {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          newDuration: durationInHours,
        },
      );
    }

    // Update webinar plan and related data in a transaction
    const result = await prisma.$transaction(
      async (tx) => {
        // -> Use topics from existingPlan fetched *before* the transaction
        const currentTopicIdsFromOuterScope = existingPlan.topics.map(
          (t) => t.id,
        );
        console.log(
          `[Before Transaction Update] Topics from initial fetch for plan ${id}:`,
          currentTopicIdsFromOuterScope,
        );

        // Prepare base update data using validated fields (excluding topics for now)
        const updateData: any = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (durationInHours !== undefined)
          updateData.durationInHours = durationInHours;
        if (price !== undefined) updateData.price = price;
        if (priceCurrency !== undefined)
          updateData.priceCurrency = priceCurrency;
        if (maxParticipants !== undefined)
          updateData.maxParticipants = maxParticipants;
        if (language !== undefined) updateData.language = language;
        if (level !== undefined) updateData.level = level;
        if (prerequisites !== undefined)
          updateData.prerequisites = prerequisites;
        if (materialProvided !== undefined)
          updateData.materialProvided = materialProvided;
        if (learningOutcomes !== undefined)
          updateData.learningOutcomes = learningOutcomes;
        if (consultantProfileId !== undefined)
          updateData.consultantProfile = {
            connect: { id: consultantProfileId },
          };

        // Determine how to handle topics (using validated 'topicIds')
        if (topicIds !== undefined) {
          // If topicIds are provided (can be empty array for removal), use set to sync
          if (!Array.isArray(topicIds)) {
            // This case should be caught by Zod validation, but double-check defensively
            console.error(
              "topicIds was provided but is not an array:",
              topicIds,
            );
            throw new Error("Invalid format for topicIds");
          }
          // Verify provided topicIds actually exist (important!)
          const topics = await tx.topic.findMany({
            where: { id: { in: topicIds } },
            select: { id: true }, // Only need IDs
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
            `Syncing topics with provided IDs: [${topicIds.join(", ")}]`,
          );
        } else {
          // If topicIds is undefined in the validated PATCH data, do *not* include the topics key
          // This leaves the existing topic relations untouched.
          console.log(
            "topicIds is undefined in PATCH request. Existing topics will not be modified.",
          );
        }

        // Execute the plan update only if there are changes
        let updatedWebinarPlan = existingPlan;
        if (Object.keys(updateData).length > 0 || topicIds !== undefined) {
          // Check topicIds for changes
          updatedWebinarPlan = await tx.webinarPlan.update({
            where: { id },
            data: updateData,
            include: {
              consultantProfile: true,
              topics: true,
              webinars: {
                // Ensure webinars relation is included
                include: {
                  // And nest includes to match existingPlan type
                  appointment: {
                    // Include the appointment
                    include: {
                      // And the slots within the appointment
                      slotsOfAppointment: true,
                    },
                  },
                },
              },
            },
          });
        }

        // Update the webinar instance status if provided in the validated data
        let updatedWebinar = webinarToUpdate;
        if (updatedWebinar) {
          const webinarUpdateData: any = {};

          // Only update status if it was present in validatedData
          if (status !== undefined) {
            webinarUpdateData.status = status;
          }

          if (Object.keys(webinarUpdateData).length > 0) {
            updatedWebinar = await tx.webinar.update({
              where: { id: updatedWebinar.id },
              data: webinarUpdateData,
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
                waitlist: true,
              },
            });
          }

          // 8. Update appointment slot if startTime and endTime were calculated
          if (startTime && endTime) {
            // Check if recalculation happened
            const appointment = updatedWebinar.appointment;

            if (appointment) {
              // Update existing appointment slots
              if (
                appointment.slotsOfAppointment &&
                appointment.slotsOfAppointment.length > 0
              ) {
                const slot = appointment.slotsOfAppointment[0];

                console.log("Updating existing slot:", {
                  slotId: slot.id,
                  oldStartTime: slot.startsAt,
                  oldEndTime: slot.endsAt,
                  newStartTime: startTime,
                  newEndTime: endTime,
                });

                await tx.slotOfAppointment.update({
                  where: { id: slot.id },
                  data: {
                    startsAt: startTime,
                    endsAt: endTime,
                  },
                });
              } else {
                // Create a new slot if none exists
                console.log("Creating new slot for appointment:", {
                  appointmentId: appointment.id,
                  startTime: startTime.toISOString(),
                  endTime: endTime.toISOString(),
                });

                await tx.slotOfAppointment.create({
                  data: {
                    appointmentId: appointment.id,
                    startsAt: startTime,
                    endsAt: endTime,
                    isTentative: false,
                  },
                });
              }
            } else {
              // Create a new appointment and slot if no appointment exists
              console.log("Creating new appointment and slot for webinar");

              const newAppointment = await tx.appointment.create({
                data: {
                  webinar: { connect: { id: updatedWebinar.id } },
                  appointmentType: "WEBINAR",
                  slotsOfAppointment: {
                    create: {
                      startsAt: startTime,
                      endsAt: endTime,
                      isTentative: false,
                    },
                  },
                },
              });

              console.log("Created new appointment:", newAppointment.id);
            }
          }

          // Retrieve the fully updated webinar after all changes
          updatedWebinar = await tx.webinar.findUnique({
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
              waitlist: true,
            },
          });
        }

        // Return the results
        return {
          webinarPlan: updatedWebinarPlan,
          webinar: updatedWebinar,
        };
      },
      {
        timeout: 10000, // 10 second timeout
        maxWait: 5000, // 5 second max wait
        isolationLevel: "Serializable", // Highest isolation level
      },
    );

    console.log(
      "Update transaction completed successfully. Returning updated webinar data.",
    );

    // Return the appropriate response based on whether we had a webinar instance
    // Ensure topics are included in the response if only the plan was updated
    const responseData = result.webinar
      ? result.webinar // Includes nested plan with topics
      : { ...result.webinarPlan, topics: result.webinarPlan.topics }; // Add topics if only plan returned

    return NextResponse.json({ data: responseData }, { status: 200 });
  } catch (error) {
    // --- Zod Error Handling ---
    if (error instanceof z.ZodError) {
      console.error("Validation Error (PATCH Catch):", error.issues);
      return NextResponse.json(
        { error: "Invalid input", details: error.issues },
        { status: 400 },
      );
    }
    // --- End Zod Error Handling ---

    console.error("Error updating webinar with plan:", error);

    // If error indicates topics don't exist
    if (
      error instanceof Error &&
      error.message.includes("The following topic IDs do not exist:") // More specific check
    ) {
      return NextResponse.json(
        { error: `Invalid topics provided: ${error.message}` },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { error: "An error occurred while updating the webinar" },
      { status: 500 },
    );
  }
}
