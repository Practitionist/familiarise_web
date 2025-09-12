import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { Prisma, AppointmentsType } from "@prisma/client";
import { z } from "zod";

// Validation schemas
const SlotSchema = z.object({
  slotStartTimeInUTC: z.string().datetime(),
  slotEndTimeInUTC: z.string().datetime(),
  type: z.enum(["WEEKLY", "CUSTOM"]).optional().default("WEEKLY"),
});

const UpdateSlotsSchema = z.object({
  slotsOfAppointment: z.object({
    createMany: z.object({
      data: z.array(SlotSchema).min(1, "At least one slot is required"),
    }),
  }),
});

const UpdateAppointmentSchema = z.object({
  appointmentType: z.nativeEnum(AppointmentsType).optional(),
  consultationId: z.string().uuid().optional(),
  subscriptionId: z.string().uuid().optional(),
  webinarId: z.string().uuid().optional(),
  classId: z.string().uuid().optional(),
});

// Types are inferred directly from schemas when needed

// Reusable user selection
const userSelect = {
  id: true,
  name: true,
  email: true,
  image: true,
} as const;

const consultantProfileInclude = {
  include: {
    user: {
      select: userSelect,
    },
  },
} as const;

const requestedByInclude = {
  include: {
    user: {
      select: userSelect,
    },
  },
} as const;

// Common include configuration for appointment queries
const appointmentInclude = {
  slotsOfAppointment: {
    include: {
      user: {
        select: {
          ...userSelect,
          consulteeProfile: true,
        },
      },
    },
  },
  consultation: {
    include: {
      consultationPlan: {
        include: {
          consultantProfile: consultantProfileInclude,
        },
      },
      requestedBy: requestedByInclude,
    },
  },
  subscription: {
    include: {
      subscriptionPlan: {
        include: {
          consultantProfile: consultantProfileInclude,
        },
      },
      requestedBy: requestedByInclude,
    },
  },
  webinar: {
    include: {
      webinarPlan: {
        include: {
          consultantProfile: consultantProfileInclude,
        },
      },
    },
  },
  class: {
    include: {
      classPlan: {
        include: {
          consultantProfile: consultantProfileInclude,
        },
      },
    },
  },
  payment: {
    include: {
      user: {
        select: userSelect,
      },
    },
  },
} as const;

// AppointmentInclude type is inferred when needed

// Utility functions
function createErrorResponse(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function createSuccessResponse(data: unknown, status = 200) {
  return NextResponse.json({ data }, { status });
}

function logError(
  context: string,
  error: unknown,
  metadata?: Record<string, unknown>,
) {
  const timestamp = new Date().toISOString();
  const logData = {
    timestamp,
    context,
    error:
      error instanceof Error
        ? {
            name: error.name,
            message: error.message,
            stack: error.stack,
          }
        : error,
    metadata,
  };

  console.error(JSON.stringify(logData, null, 2));
}

function logInfo(
  context: string,
  message: string,
  metadata?: Record<string, unknown>,
) {
  const timestamp = new Date().toISOString();
  const logData = {
    timestamp,
    level: "info",
    context,
    message,
    metadata,
  };

  console.log(JSON.stringify(logData, null, 2));
}

function handlePrismaError(error: unknown, context?: string) {
  logError(context || "Database operation", error);

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    switch (error.code) {
      case "P2025":
        return createErrorResponse("Appointment not found", 404);
      case "P2002":
        return createErrorResponse("Duplicate constraint violation", 409);
      case "P2003":
        return createErrorResponse("Foreign key constraint failed", 400);
      default:
        logError("Unhandled Prisma error", error, { code: error.code });
        return createErrorResponse("Database operation failed", 500);
    }
  }

  return createErrorResponse("Internal server error", 500);
}

function validateSlotTimes(
  slots: Array<{ slotStartTimeInUTC: string; slotEndTimeInUTC: string }>,
) {
  for (const slot of slots) {
    const start = new Date(slot.slotStartTimeInUTC);
    const end = new Date(slot.slotEndTimeInUTC);

    if (start >= end) {
      throw new Error(`Invalid slot: start time must be before end time`);
    }

    if (start < new Date()) {
      throw new Error(`Invalid slot: start time cannot be in the past`);
    }
  }
}

function compareSlotArrays(
  newSlots: Array<{ slotStartTimeInUTC: string; slotEndTimeInUTC: string }>,
  existingSlots: Array<{ slotStartTimeInUTC: Date; slotEndTimeInUTC: Date }>,
): boolean {
  if (newSlots.length !== existingSlots.length) {
    return false;
  }

  // Sort both arrays by start time for accurate comparison
  const sortedNew = [...newSlots]
    .map((slot) => ({
      start: new Date(slot.slotStartTimeInUTC).getTime(),
      end: new Date(slot.slotEndTimeInUTC).getTime(),
    }))
    .sort((a, b) => a.start - b.start);

  const sortedExisting = [...existingSlots]
    .map((slot) => ({
      start: slot.slotStartTimeInUTC.getTime(),
      end: slot.slotEndTimeInUTC.getTime(),
    }))
    .sort((a, b) => a.start - b.start);

  return sortedNew.every((newSlot, index) => {
    const existingSlot = sortedExisting[index];
    return (
      newSlot.start === existingSlot.start && newSlot.end === existingSlot.end
    );
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;

    // Validate appointmentId format
    if (!appointmentId || typeof appointmentId !== "string") {
      return createErrorResponse("Invalid appointment ID", 400);
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      include: appointmentInclude,
    });

    if (!appointment) {
      return createErrorResponse("Appointment not found", 404);
    }

    logInfo(
      "GET /api/slots/appointments/[appointmentId]",
      "Appointment retrieved successfully",
      { appointmentId },
    );
    return createSuccessResponse(appointment);
  } catch (error) {
    return handlePrismaError(
      error,
      "GET /api/slots/appointments/[appointmentId]",
    );
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;

    // Validate appointmentId format
    if (!appointmentId || typeof appointmentId !== "string") {
      return createErrorResponse("Invalid appointment ID", 400);
    }

    // Parse and validate request body
    const body = await request.json();
    const validationResult = UpdateSlotsSchema.safeParse(body);

    if (!validationResult.success) {
      return createErrorResponse(
        `Validation error: ${validationResult.error.issues.map((i) => i.message).join(", ")}`,
        400,
      );
    }

    const validatedData = validationResult.data;
    const newSlots = validatedData.slotsOfAppointment.createMany.data;

    // Validate slot times
    try {
      validateSlotTimes(newSlots);
    } catch (error) {
      return createErrorResponse(
        error instanceof Error ? error.message : "Invalid slot times",
        400,
      );
    }

    // Use transaction to ensure atomic slot updates
    const updatedAppointment = await prisma.$transaction(
      async (tx) => {
        // First, verify the appointment exists and get current data
        const existingAppointment = await tx.appointment.findUnique({
          where: { id: appointmentId },
          include: {
            slotsOfAppointment: true,
          },
        });

        if (!existingAppointment) {
          throw new Error("Appointment not found");
        }

        // Check if this is a duplicate update by comparing slot times
        const slotsAreIdentical = compareSlotArrays(
          newSlots,
          existingAppointment.slotsOfAppointment,
        );

        if (slotsAreIdentical) {
          // Return the full appointment with includes if slots are identical
          return await tx.appointment.findUnique({
            where: { id: appointmentId },
            include: appointmentInclude,
          });
        }

        const data: Prisma.AppointmentUpdateInput = {
          slotsOfAppointment: {
            deleteMany: {},
            create: newSlots.map((slot) => ({
              slotStartTimeInUTC: new Date(slot.slotStartTimeInUTC),
              slotEndTimeInUTC: new Date(slot.slotEndTimeInUTC),
              type: slot.type,
            })),
          },
        };

        const updatedAppointment = await tx.appointment.update({
          where: { id: appointmentId },
          data,
          include: appointmentInclude,
        });

        return updatedAppointment;
      },
      {
        maxWait: 5000, // 5 seconds max wait
        timeout: 10000, // 10 seconds timeout
        isolationLevel: "Serializable", // Ensure serializable isolation
      },
    );

    logInfo(
      "PATCH /api/slots/appointments/[appointmentId]",
      "Appointment slots updated successfully",
      {
        appointmentId,
        slotCount: newSlots.length,
      },
    );
    return createSuccessResponse(updatedAppointment);
  } catch (error) {
    return handlePrismaError(
      error,
      "PATCH /api/slots/appointments/[appointmentId]",
    );
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;

    // Validate appointmentId format
    if (!appointmentId || typeof appointmentId !== "string") {
      return createErrorResponse("Invalid appointment ID", 400);
    }

    // Parse and validate request body
    const body = await request.json();
    const validationResult = UpdateAppointmentSchema.safeParse(body);

    if (!validationResult.success) {
      return createErrorResponse(
        `Validation error: ${validationResult.error.issues.map((i) => i.message).join(", ")}`,
        400,
      );
    }

    const validatedData = validationResult.data;

    // Ensure at least one field is being updated
    if (Object.keys(validatedData).length === 0) {
      return createErrorResponse("No valid fields provided for update", 400);
    }

    const data: Prisma.AppointmentUpdateInput = {
      appointmentType: validatedData.appointmentType,
      consultation: validatedData.consultationId
        ? { connect: { id: validatedData.consultationId } }
        : undefined,
      subscription: validatedData.subscriptionId
        ? { connect: { id: validatedData.subscriptionId } }
        : undefined,
      webinar: validatedData.webinarId
        ? { connect: { id: validatedData.webinarId } }
        : undefined,
      class: validatedData.classId
        ? { connect: { id: validatedData.classId } }
        : undefined,
    };

    const updatedAppointment = await prisma.appointment.update({
      where: { id: appointmentId },
      data,
      include: appointmentInclude,
    });

    logInfo(
      "PUT /api/slots/appointments/[appointmentId]",
      "Appointment updated successfully",
      {
        appointmentId,
        updatedFields: Object.keys(validatedData),
      },
    );
    return createSuccessResponse(updatedAppointment);
  } catch (error) {
    return handlePrismaError(
      error,
      "PUT /api/slots/appointments/[appointmentId]",
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  try {
    const { appointmentId } = await params;

    // Validate appointmentId format
    if (!appointmentId || typeof appointmentId !== "string") {
      return createErrorResponse("Invalid appointment ID", 400);
    }

    // Check if there's an associated payment
    const appointment = await prisma.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        id: true,
        payment: {
          select: {
            id: true,
          },
        },
      },
    });

    if (!appointment) {
      return createErrorResponse("Appointment not found", 404);
    }

    if (appointment.payment) {
      return createErrorResponse(
        "Cannot delete appointment with associated payment",
        400,
      );
    }

    const deletedAppointment = await prisma.appointment.delete({
      where: { id: appointmentId },
      include: appointmentInclude,
    });

    logInfo(
      "DELETE /api/slots/appointments/[appointmentId]",
      "Appointment deleted successfully",
      { appointmentId },
    );
    return createSuccessResponse(deletedAppointment);
  } catch (error) {
    return handlePrismaError(
      error,
      "DELETE /api/slots/appointments/[appointmentId]",
    );
  }
}
