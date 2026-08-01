import * as Sentry from "@sentry/nextjs";
import prisma from "@/lib/prisma";
import {
  curriculumCreateNested,
  faqCreateNested,
  faqReplaceNested,
} from "@/lib/api/plans/content";
import { ClassPlanSchema, ClassContentSchema } from "@/schemas/plans";
import { ClassStatus, Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addMonthsSafely } from "@/utils/dateUtils";
import { findOrCreateTopics, transformNestedPlanTopics } from "@/lib/topics";
import { checkConsultantVerification } from "@/lib/verification";
import { countUniqueParticipants } from "@/lib/payments/utils/participants";
import {
  CapacityBelowEnrollmentError,
  capacityBelowRegisteredMessage,
} from "@/lib/events/capacity";

import { getSession } from "@/lib/auth-server";
import { resolveSchedulingTimezone } from "@/lib/scheduling/schedulingTimezone";
// Schema for class content input (without Prisma-managed fields like createdAt, updatedAt, classPlanId)
const ClassContentInputSchema = ClassContentSchema.omit({
  createdAt: true,
  updatedAt: true,
  classPlanId: true,
});

// Schema for POST request body based on ClassPlanSchema
// Topics are now accepted as names (strings) - API handles finding/creating
const PostClassWithPlanBodySchema = ClassPlanSchema.omit({
  planType: true,
  consultantProfile: true,
  startDate: true,
  endDate: true,
  topics: true,
  classContents: true, // Omit to override with input schema
}).extend({
  consultantProfileId: z.string().min(1, "Consultant profile ID is required"),
  // Topics as names - API will find or create them
  topics: z
    .array(z.string().min(1, "Topic name cannot be empty"))
    .min(1, "At least one topic is required"),
  status: z.nativeEnum(ClassStatus).optional().default(ClassStatus.SCHEDULED),
  startDate: z
    .string()
    .optional()
    .nullable()
    .refine((val) => !val || !isNaN(Date.parse(val)), {
      message: "Invalid date format for startDate",
    }),
  // Override classContents with input schema (without Prisma-managed date fields)
  classContents: z
    .array(ClassContentInputSchema)
    .min(1, "At least one class content item is required")
    .default([])
    .refine((contents) => {
      const titles = contents.map((c) => c.title.trim().toLowerCase());
      return new Set(titles).size === titles.length;
    }, "Class contents must have unique titles"),
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
    // Authentication check
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const body = await request.json();

    // Verification check - consultant must be verified to create classes
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
      subtitle,
      targetAudience,
      whatsIncluded,
      faqs,
      consultantProfileId,
      topics: topicNames,
      certificateProvided,
      recordingEnabled,
      sessionsPerWeek,
      emailSupport,
      classContents,
      status,
      startDate,
    } = validatedData;

    // Verify ownership - user must own this consultant profile
    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: {
        id: consultantProfileId,
        userId: session.user.id,
      },
      // #1076 — the host's zone is what the per-day/week caps bucket on.
      include: { user: { select: { timezone: true } } },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        {
          error:
            "You do not have permission to create classes for this consultant profile",
        },
        { status: 403 },
      );
    }

    // Find or create topics by name
    const topicIds = await findOrCreateTopics(topicNames);

    // Compute derived metrics using validated session duration from the plan
    const sessionDurationInHours = validatedData.sessionDurationInHours ?? 1.0;
    const totalSessions = sessionsPerWeek * durationInMonths * 4;
    const totalHours = totalSessions * sessionDurationInHours;

    // Calculate end date only if startDate is provided and valid
    let start: Date | undefined = startDate ? new Date(startDate) : undefined;
    let end: Date | undefined = undefined;
    if (start && !isNaN(start.getTime())) {
      // FIXED: Check if date is valid and handle month-end overflow
      end = new Date(start);
      // Ensure durationInMonths is valid before using
      if (typeof durationInMonths === "number" && durationInMonths > 0) {
        end = addMonthsSafely(start, durationInMonths);
      } else {
        // Handle invalid durationInMonths if necessary, maybe throw error or default
        console.warn("Invalid durationInMonths provided:", durationInMonths);
        end = undefined; // Or set default end date logic
      }
    } else {
      start = undefined; // Treat invalid start date string as undefined
    }

    // Create class plan, instance, and appointments in a transaction
    const result = await prisma.$transaction(
      async (tx) => {
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
            subtitle,
            targetAudience,
            whatsIncluded,
            faqs: faqCreateNested(faqs),
            certificateProvided,
            recordingEnabled,
            sessionsPerWeek,
            sessionDurationInHours,
            totalSessions,
            totalHours,
            emailSupport,
            consultantProfile: { connect: { id: consultantProfileId } },
            topics: topicIds // Use validated topics here
              ? { connect: topicIds.map((id: string) => ({ id })) }
              : undefined,
            classContents: curriculumCreateNested(classContents),
          },
          include: {
            consultantProfile: true,
            topics: true,
            classContents: true,
            faqs: { orderBy: { order: "asc" } },
          },
        });

        // 2. Create the class instance with appointments
        const classEvent = await tx.class.create({
          data: {
            status,
            schedulingPeriodStartsAt: start, // Will be undefined if not provided
            schedulingPeriodEndsAt: end, // Will be undefined if start is not provided
            schedulingTimezone: resolveSchedulingTimezone(
              consultantProfile.user.timezone,
            ),
            classPlan: { connect: { id: classPlan.id } },
            // Create appointments for the full duration
            appointments: {
              // Only create appointments if startDate is defined
              create: start
                ? Array.from({
                    // Use totalSessions (sessionsPerWeek * durationInMonths * 4)
                    // to stay in sync with ClassPlan.totalSessions
                    length: totalSessions,
                  }).map((_, index) => {
                    const appointmentDate = new Date(start!);
                    // Spread meetings evenly within each week:
                    // weekOffset positions the week, dayWithinWeek spaces meetings apart
                    // e.g. sessionsPerWeek=2 -> days 0,3 (Mon,Thu)
                    // e.g. sessionsPerWeek=3 -> days 0,2,4 (Mon,Wed,Fri)
                    const weekOffset = Math.floor(index / sessionsPerWeek) * 7;
                    const dayWithinWeek =
                      (index % sessionsPerWeek) *
                      Math.floor(7 / sessionsPerWeek);
                    appointmentDate.setDate(
                      appointmentDate.getDate() + weekOffset + dayWithinWeek,
                    );
                    const slotStart = new Date(appointmentDate);
                    const slotEnd = new Date(appointmentDate);
                    slotEnd.setTime(
                      slotEnd.getTime() +
                        sessionDurationInHours * 60 * 60 * 1000,
                    );

                    return {
                      appointmentType: "CLASS",
                      slotsOfAppointment: {
                        create: {
                          startsAt: slotStart,
                          endsAt: slotEnd,
                          isTentative: true, // Mark as tentative until confirmed
                          // #784 — owner denormalized so the overlap exclusion
                          // guards the host once the session is confirmed
                          // (constraint applies WHERE NOT isTentative).
                          consultantProfileId,
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
          },
        });

        return { classPlan, classEvent };
      },
      { timeout: 25000 },
    );

    // Transform topics to strings in response
    const transformedEvent = transformNestedPlanTopics(
      result.classEvent,
      "classPlan",
    );
    return NextResponse.json({ data: transformedEvent }, { status: 201 });
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
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: errorMessage, details: errorDetails }, // Return more details
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
      id,
      classId,
      title,
      description,
      durationInMonths,
      price,
      priceCurrency,
      certificateProvided,
      sessionsPerWeek,
      emailSupport,
      maxParticipants,
      language,
      level,
      prerequisites,
      materialProvided,
      learningOutcomes,
      subtitle,
      targetAudience,
      whatsIncluded,
      faqs,
      consultantProfileId,
      topics: topicNames,
      classContents,
      status,
      startDate: startDateString,
      endDate: endDateString,
      recordingEnabled,
      sessionDurationInHours: patchSessionDuration,
    } = validatedData;

    // Find or create topics by name if provided
    let topicIds: string[] | undefined;
    if (topicNames !== undefined) {
      topicIds = await findOrCreateTopics(topicNames);
    }

    console.log("Validated fields for update:", {
      id,
      classId,
      title,
      status,
      topicIds,
    });

    // First, check if the class plan exists
    const existingPlan = await prisma.classPlan.findUnique({
      where: { id },
      include: {
        consultantProfile: true,
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

    // Verify ownership - user must own this class plan
    if (
      !existingPlan.consultantProfile ||
      existingPlan.consultantProfile.userId !== session.user.id
    ) {
      return NextResponse.json(
        { error: "You do not have permission to update this class" },
        { status: 403 },
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

    // FIX #627/#628: Guard against unsafe edits on classes with confirmed bookings.
    // TODO: These guards run outside the transaction — a booking could theoretically
    // land between the check and the transaction commit. The window is milliseconds
    // and the risk is low, but moving inside the transaction would be more robust.
    if (classToUpdate) {
      const activePayments = await prisma.payment.count({
        where: {
          appointment: { classId: classToUpdate.id },
          paymentStatus: { notIn: ["FAILED", "EXPIRED"] },
        },
      });

      // FIX #627: Block scheduling period changes when bookings exist.
      // Only block when dates ACTUALLY differ from current values
      // (the planner client may always send startDate/endDate even for non-date edits).
      if (activePayments > 0) {
        const startChanged =
          startDateString !== undefined &&
          startDateString !== null &&
          classToUpdate.schedulingPeriodStartsAt
            ?.toISOString()
            ?.slice(0, 10) !==
            new Date(startDateString).toISOString().slice(0, 10);
        const endChanged =
          endDateString !== undefined &&
          endDateString !== null &&
          classToUpdate.schedulingPeriodEndsAt?.toISOString()?.slice(0, 10) !==
            new Date(endDateString).toISOString().slice(0, 10);

        if (startChanged || endChanged) {
          return NextResponse.json(
            {
              error:
                "Cannot modify class schedule with enrolled participants. Use the reschedule workflow instead.",
            },
            { status: 400 },
          );
        }
      }
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
            classContents: curriculumCreateNested(classContents),
          };
          console.log(
            `Updating class contents for plan ${id}. Creating ${classContents.length} new entries.`,
          );
        } else {
          console.log(`No class contents provided for update on plan ${id}.`);
        }

        // Prepare the main update data, only including fields present in validatedData
        const updateData: Prisma.ClassPlanUpdateInput = {};
        if (title !== undefined) updateData.title = title;
        if (description !== undefined) updateData.description = description;
        if (durationInMonths !== undefined)
          updateData.durationInMonths = durationInMonths;
        if (price !== undefined) updateData.price = price;
        if (priceCurrency !== undefined)
          updateData.priceCurrency = priceCurrency;
        if (certificateProvided !== undefined)
          updateData.certificateProvided = certificateProvided;
        if (recordingEnabled !== undefined)
          updateData.recordingEnabled = recordingEnabled;
        if (sessionsPerWeek !== undefined)
          updateData.sessionsPerWeek = sessionsPerWeek;
        if (emailSupport !== undefined) updateData.emailSupport = emailSupport;

        // Allow updating sessionDurationInHours
        if (patchSessionDuration !== undefined)
          updateData.sessionDurationInHours = patchSessionDuration;

        // Recompute derived metrics if base fields are being updated
        if (
          sessionsPerWeek !== undefined ||
          durationInMonths !== undefined ||
          patchSessionDuration !== undefined
        ) {
          const finalMeetingsPerWeek =
            sessionsPerWeek ?? existingPlan.sessionsPerWeek;
          const finalDurationInMonths =
            durationInMonths ?? existingPlan.durationInMonths;
          const finalSessionDurationInHours =
            patchSessionDuration ?? existingPlan.sessionDurationInHours ?? 1.0;

          updateData.totalSessions =
            finalMeetingsPerWeek * finalDurationInMonths * 4;
          updateData.totalHours =
            updateData.totalSessions * finalSessionDurationInHours;
        }
        // Capacity is per instance. Only move the plan's default when the
        // caller is editing the plan itself rather than one of its classes.
        if (maxParticipants !== undefined && !classToUpdate)
          updateData.maxParticipants = maxParticipants;
        if (language !== undefined) updateData.language = language;
        if (level !== undefined) updateData.level = level;
        if (prerequisites !== undefined)
          updateData.prerequisites = prerequisites; // handles null too
        if (materialProvided !== undefined)
          updateData.materialProvided = materialProvided; // handles null too
        if (learningOutcomes !== undefined)
          updateData.learningOutcomes = learningOutcomes;
        if (subtitle !== undefined) updateData.subtitle = subtitle;
        if (targetAudience !== undefined)
          updateData.targetAudience = targetAudience;
        if (whatsIncluded !== undefined)
          updateData.whatsIncluded = whatsIncluded;
        if (faqs !== undefined) updateData.faqs = faqReplaceNested(faqs);
        if (consultantProfileId !== undefined)
          updateData.consultantProfile = {
            connect: { id: consultantProfileId },
          };

        // Spread the contents update if any (only if classContents was in validatedData)
        if (classContents !== undefined) {
          Object.assign(updateData, classContentsUpdateData);
        }

        // Handle topics: topicIds are already validated/created by findOrCreateTopics
        if (topicIds !== undefined) {
          updateData.topics = {
            set: topicIds.map((topicId: string) => ({ id: topicId })),
          };
          console.log(
            `Syncing class topics with provided IDs: [${topicIds.join(", ")}]`,
          );
        } else {
          console.log(
            "Class topics is undefined in the request. Existing topics will not be modified.",
          );
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
            schedulingPeriodStartsAt?: Date | null;
            schedulingPeriodEndsAt?: Date | null;
            maxParticipants?: number;
          } = {};

          // Only include status if it's provided in the validated data
          if (status !== undefined) {
            classUpdateData.status = status;
          }

          // #628 — shrinking below the students already enrolled would strand
          // paying learners. Checked inside the tx (the old guard ran before
          // it and left a TOCTOU window).
          if (maxParticipants !== undefined) {
            const classAppointments = await tx.appointment.findMany({
              where: { classId: updatedClass.id },
              include: {
                slotsOfAppointment: {
                  include: { user: { select: { id: true } } },
                },
              },
            });
            const consultantUserId = existingPlan.consultantProfile?.userId;
            const enrolledCount = countUniqueParticipants(
              classAppointments,
              consultantUserId ? [consultantUserId] : [],
            );
            if (maxParticipants < enrolledCount) {
              throw new CapacityBelowEnrollmentError(
                capacityBelowRegisteredMessage(maxParticipants, enrolledCount),
              );
            }
            classUpdateData.maxParticipants = maxParticipants;
          }

          // Handle startDate: update if provided, set to null if explicitly null, otherwise leave unchanged
          // Need to parse the string date from validated data
          if (startDateString !== undefined) {
            classUpdateData.schedulingPeriodStartsAt = startDateString
              ? new Date(startDateString)
              : null;
            // Optional: Add check for valid date parsing: !isNaN(classUpdateData.schedulingPeriodStartsAt?.getTime())
            if (
              classUpdateData.schedulingPeriodStartsAt &&
              isNaN(classUpdateData.schedulingPeriodStartsAt.getTime())
            ) {
              console.warn(
                "Invalid startDate received in PATCH:",
                startDateString,
              );
              // Decide how to handle: throw error, ignore, set null?
              // For now, let's ignore the invalid date update for startDate
              delete classUpdateData.schedulingPeriodStartsAt;
            }
          }

          // Handle endDate: update if provided, set to null if explicitly null, otherwise leave unchanged
          if (endDateString !== undefined) {
            classUpdateData.schedulingPeriodEndsAt = endDateString
              ? new Date(endDateString)
              : null;
            // Optional: Add check for valid date parsing
            if (
              classUpdateData.schedulingPeriodEndsAt &&
              isNaN(classUpdateData.schedulingPeriodEndsAt.getTime())
            ) {
              console.warn("Invalid endDate received in PATCH:", endDateString);
              // Ignore invalid date update for endDate
              delete classUpdateData.schedulingPeriodEndsAt;
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
    // Transform topics to strings in response
    let responseData;
    if (result.class) {
      responseData = transformNestedPlanTopics(result.class, "classPlan");
    } else {
      responseData = {
        ...result.classPlan,
        topics: result.classPlan.topics.map((t) => t.name),
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

    // Shrinking below the current roster is a user error, not a 500.
    if (error instanceof CapacityBelowEnrollmentError) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }

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

    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "bookings" } },
    );
    return NextResponse.json(
      { error: "An error occurred while updating the class" },
      { status: 500 },
    );
  }
}
