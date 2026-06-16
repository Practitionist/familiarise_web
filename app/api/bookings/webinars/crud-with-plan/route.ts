import prisma from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { WebinarPlanSchema } from "@/schemas/plans";
import { Prisma, WebinarStatus } from "@prisma/client";
import { findOrCreateTopics, transformNestedPlanTopics } from "@/lib/topics";
import { handleSlotOpening } from "@/lib/waitlist/slot-handler";
import { checkConsultantVerification } from "@/lib/verification";
import { countWebinarParticipants } from "@/lib/payments/utils/participants";
import {
  assertCollaboratorsAvailable,
  CollaboratorUnavailableError,
} from "@/lib/collaborators/availability";
import { isExclusionViolation } from "@/lib/db/pg-errors";

import { getSession } from "@/lib/auth-server";
// Schema for POST request body based on WebinarPlanSchema
// Topics are now accepted as names (strings) - API handles finding/creating
const PostWebinarWithPlanBodySchema = WebinarPlanSchema.omit({
  consultantProfile: true,
  topics: true,
  scheduledAt: true,
}).extend({
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  // Topics as names - API will find or create them
  topics: z
    .array(z.string().min(1, "Topic name cannot be empty"))
    .min(1, "At least one topic is required"),
  scheduledAt: z
    .string()
    .optional()
    .nullable()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for scheduledAt",
    }),
  status: z
    .nativeEnum(WebinarStatus)
    .optional()
    .default(WebinarStatus.SCHEDULED),
});

// Schema for PATCH request body
const PatchWebinarWithPlanBodySchema = PostWebinarWithPlanBodySchema.omit({
  topics: true,
})
  .partial()
  .extend({
    id: z.string().min(1, "Webinar Plan ID is required for update"),
    webinarId: z.string().optional().nullable(),
    topics: z.array(z.string()).optional(),
  });

export async function POST(request: NextRequest) {
  try {
    // Authentication check
    const session = await getSession();
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

    // Verification check - consultant must be verified to create webinars
    if (body.consultantProfileId) {
      const verification = await checkConsultantVerification(
        body.consultantProfileId,
      );
      if (!verification.isVerified) {
        return NextResponse.json(
          {
            error: "Verification required",
            message: verification.message,
            verificationStatus: verification.status,
          },
          { status: 403 },
        );
      }
    }

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
      topics: topicNames,
      scheduledAt,
      status,
    } = validatedData;

    // Verify ownership - user must own this consultant profile
    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: {
        id: consultantProfileId,
        userId: session.user.id,
      },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        {
          error:
            "You do not have permission to create webinars for this consultant profile",
        },
        { status: 403 },
      );
    }

    // Find or create topics by name
    const topicIds = await findOrCreateTopics(topicNames);

    console.log("Validated fields:", {
      title,
      durationInHours,
      price,
      maxParticipants,
      consultantProfileId,
      scheduledAt,
      topicNames,
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
        // Topics are already created/found by findOrCreateTopics, no verification needed

        // 1. Create the webinar plan using validated data
        console.log("Creating webinar plan with validated data:", {
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
            certificateProvided: validatedData.certificateProvided,
            recordingEnabled: validatedData.recordingEnabled,
            consultantProfile: { connect: { id: consultantProfileId } },
            topics:
              topicIds.length > 0
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
                          // #784 — owner denormalized so the slot overlap
                          // exclusion guards the host on group events too.
                          consultantProfileId,
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
    // Transform topics to strings in response
    const transformedWebinar = transformNestedPlanTopics(
      result.webinar,
      "webinarPlan",
    );
    return NextResponse.json({ data: transformedWebinar }, { status: 201 });
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

    // #784 — owner now denormalized onto group-event slots, so a scheduling
    // overlap trips slot_no_confirmed_overlap (23P01): that's a conflict, not 500.
    if (isExclusionViolation(error)) {
      return NextResponse.json(
        {
          error:
            "That time conflicts with another confirmed session on your calendar.",
        },
        { status: 409 },
      );
    }

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
    const session = await getSession();
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
      topics: topicNames,
      status,
      scheduledAt,
      priceCurrency,
      certificateProvided,
      recordingEnabled,
    } = validatedData;

    // Find or create topics by name if provided
    let topicIds: string[] | undefined;
    if (topicNames !== undefined) {
      topicIds = await findOrCreateTopics(topicNames);
    }

    console.log("Validated fields for update:", {
      id,
      webinarId,
      title,
      durationInHours,
      topicIds: topicIds ? `[${topicIds.length} topics]` : "undefined",
      status,
      scheduledAt,
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
    if (
      !existingPlan.consultantProfile ||
      existingPlan.consultantProfile.userId !== session.user.id
    ) {
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

    // FIX #626/#628: Guard against unsafe edits on webinars with confirmed bookings.
    // TODO: These guards run outside the transaction — a booking could theoretically
    // land between the check and the transaction commit. The window is milliseconds
    // and the risk is low, but moving inside the transaction would be more robust.
    if (webinarToUpdate?.appointment) {
      const activePayments = await prisma.payment.count({
        where: {
          appointmentId: webinarToUpdate.appointment.id,
          paymentStatus: { notIn: ["FAILED", "EXPIRED"] },
        },
      });

      // FIX #626: Block time changes when bookings exist.
      // Only block when the time ACTUALLY differs from the current slot
      // (the planner client may always send scheduledAt even for non-time edits).
      if (activePayments > 0 && (startTime || endTime)) {
        const existingSlot =
          webinarToUpdate.appointment?.slotsOfAppointment?.[0];
        const timeChanged =
          !existingSlot ||
          (startTime &&
            existingSlot.startsAt.getTime() !== startTime.getTime()) ||
          (endTime && existingSlot.endsAt.getTime() !== endTime.getTime());

        if (timeChanged) {
          return NextResponse.json(
            {
              error:
                "Cannot reschedule a webinar with confirmed bookings. Use the reschedule workflow instead.",
            },
            { status: 400 },
          );
        }
      }

      // FIX #628: Block lowering maxParticipants below current enrollment.
      // Use shared countWebinarParticipants helper for consistent counting.
      // Include ALL slots (not just non-tentative) because during reschedule
      // all slots become tentative but participants are still enrolled.
      if (maxParticipants !== undefined) {
        const appointmentWithSlots = await prisma.appointment.findUnique({
          where: { id: webinarToUpdate.appointment.id },
          include: {
            slotsOfAppointment: { include: { user: { select: { id: true } } } },
          },
        });
        const consultantUserId = existingPlan.consultantProfile?.userId;
        const enrolledCount = countWebinarParticipants(
          appointmentWithSlots,
          consultantUserId ? [consultantUserId] : [],
        );
        if (maxParticipants < enrolledCount) {
          return NextResponse.json(
            {
              error: `Cannot set max participants to ${maxParticipants}. There are ${enrolledCount} enrolled participants.`,
            },
            { status: 400 },
          );
        }
      }
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
        const updateData: Prisma.WebinarPlanUpdateInput = {};
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
        if (certificateProvided !== undefined)
          updateData.certificateProvided = certificateProvided;
        if (recordingEnabled !== undefined)
          updateData.recordingEnabled = recordingEnabled;
        if (learningOutcomes !== undefined)
          updateData.learningOutcomes = learningOutcomes;
        if (consultantProfileId !== undefined)
          updateData.consultantProfile = {
            connect: { id: consultantProfileId },
          };

        // Handle topics: topicIds are already validated/created by findOrCreateTopics
        if (topicIds !== undefined) {
          updateData.topics = {
            set: topicIds.map((topicId: string) => ({ id: topicId })),
          };
          console.log(
            `Syncing topics with provided IDs: [${topicIds.join(", ")}]`,
          );
        } else {
          console.log(
            "topics is undefined in PATCH request. Existing topics will not be modified.",
          );
        }

        // Execute the plan update only if there are changes
        let updatedWebinarPlan = existingPlan;
        if (Object.keys(updateData).length > 0 || topicIds !== undefined) {
          // Check topics for changes
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
          const webinarUpdateData: Prisma.WebinarUpdateInput = {};

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

            // AE-2 (#784) — block (re)scheduling onto a time any ACCEPTED co-host
            // is already committed to; co-hosts aren't slot participants, so no
            // other guard catches their double-booking. Throws → 409 below.
            await assertCollaboratorsAvailable(tx, {
              planType: "WEBINAR",
              planId: id,
              startsAt: startTime,
              endsAt: endTime,
              excludeAppointmentId: appointment?.id ?? null,
            });

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
                    // #784 — denormalize the owner so slot_no_confirmed_overlap
                    // guards the host against double-booking on group events too
                    // (group slots were NULL here, leaving the owner unprotected).
                    consultantProfileId: existingPlan.consultantProfileId,
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
                    // #784 — owner denormalized for the overlap exclusion guard.
                    consultantProfileId: existingPlan.consultantProfileId,
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
                      // #784 — owner denormalized for the overlap exclusion guard.
                      consultantProfileId: existingPlan.consultantProfileId,
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

    // Notify waitlist if capacity was increased
    const oldMaxParticipants = existingPlan.maxParticipants;
    const newMaxParticipants = result.webinarPlan.maxParticipants;

    if (newMaxParticipants > oldMaxParticipants && result.webinar?.id) {
      const newSlotsAvailable = newMaxParticipants - oldMaxParticipants;

      try {
        await handleSlotOpening({
          webinarId: result.webinar.id,
          slotsAvailable: newSlotsAvailable,
          reason: "capacity_increase",
        });

        console.log(
          JSON.stringify({
            event: "waitlist_notified_after_capacity_increase",
            webinarId: result.webinar.id,
            oldMaxParticipants,
            newMaxParticipants,
            newSlotsAvailable,
            timestamp: new Date().toISOString(),
          }),
        );
      } catch (waitlistError) {
        // Log but don't fail the update - waitlist notification is best-effort
        console.error(
          "Failed to notify waitlist after capacity increase:",
          waitlistError,
        );
      }
    }

    // Transform topics to strings in response
    let responseData;
    if (result.webinar) {
      responseData = transformNestedPlanTopics(result.webinar, "webinarPlan");
    } else {
      responseData = {
        ...result.webinarPlan,
        topics: result.webinarPlan.topics.map((t) => t.name),
      };
    }

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

    // AE-2 — co-host clash is a conflict, not a server error.
    if (error instanceof CollaboratorUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    // #784 — owner overlap on the shared exclusion constraint → 409, not 500.
    if (isExclusionViolation(error)) {
      return NextResponse.json(
        {
          error:
            "That time conflicts with another confirmed session on your calendar.",
        },
        { status: 409 },
      );
    }

    console.error("Error updating webinar with plan:", error);

    return NextResponse.json(
      { error: "An error occurred while updating the webinar" },
      { status: 500 },
    );
  }
}
