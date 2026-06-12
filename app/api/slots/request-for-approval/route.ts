import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { AppointmentStatus } from "@prisma/client";
import { lockSlotBooking, unlockSlotBooking } from "@/utils/appointmentlock";
import { SlotLockError } from "@/utils/errors/SlotLockError";
import { SlotValidationService } from "@/utils/slotAllocation/SlotValidationService";
import { notifyNewBookingRequest } from "@/lib/novu";
import { RequestForApprovalSchema } from "@/schemas/slots";
import { requestApprovalLimiter, applyRateLimit } from "@/lib/rate-limit";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";

import { getSession } from "@/lib/auth-server";
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();

    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    // Rate limit: 10 approval requests per hour per user
    const rl = await applyRateLimit(requestApprovalLimiter, session.user.id);
    if (rl) return rl;

    const body = await req.json();
    const parseResult = RequestForApprovalSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: parseResult.error.issues },
        { status: 400 },
      );
    }
    const {
      consultantProfileId,
      startsAt,
      endsAt,
      slotOfAvailabilityWeeklyId,
      slotOfAvailabilityCustomId,
      consultationPlanId,
    } = parseResult.data;

    const startTime = new Date(startsAt);
    const endTime = new Date(endsAt);

    // Lazy-create ConsulteeProfile on first consumer action — org-workspace
    // operators and consultants who book approvals will otherwise 404 here.
    await ensureConsulteeProfile(prisma, session.user.id);
    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { userId: session.user.id },
      include: { user: true },
    });

    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    // Verify the consultation plan exists and belongs to the consultant
    const consultationPlan = await prisma.consultationPlan.findFirst({
      where: {
        id: consultationPlanId,
        consultantProfileId: consultantProfileId,
      },
      include: {
        consultantProfile: {
          include: {
            user: true,
          },
        },
      },
    });

    if (!consultationPlan) {
      return NextResponse.json(
        { error: "Consultation plan not found" },
        { status: 404 },
      );
    }

    // Create request notes with availability slot information
    const requestNotes =
      `Request for approval - Slot: ${startTime.toISOString()} to ${endTime.toISOString()}. ` +
      `Availability slot: ${slotOfAvailabilityWeeklyId ? `Weekly ID: ${slotOfAvailabilityWeeklyId}` : `Custom ID: ${slotOfAvailabilityCustomId}`}`;

    // DISTRIBUTED LOCK: Prevent double-booking at slot level
    let lock;

    try {
      // ACQUIRE LOCK for this specific slot
      // Use default 60s TTL (15s was too short for slow database operations)
      lock = await lockSlotBooking(consultantProfileId, startsAt);

      console.log(
        JSON.stringify({
          event: "slot_booking_lock_acquired",
          consultant: consultantProfileId,
          slot: startsAt,
          user: session.user.id,
          timestamp: new Date().toISOString(),
        }),
      );

      // Generate 30-minute slot chunks from startTime to endTime.
      // SlotOfAppointment records are always 30 minutes each — consistent with
      // manual and auto allocation paths in SlotAllocationService.
      const SLOT_DURATION_MS = 30 * 60 * 1000;
      const slotChunkStarts: Date[] = [];
      let current = new Date(startTime);
      while (current < endTime) {
        slotChunkStarts.push(new Date(current));
        current = new Date(current.getTime() + SLOT_DURATION_MS);
      }
      if (slotChunkStarts.length === 0) {
        return NextResponse.json(
          { error: "Invalid slot: start time must be before end time" },
          { status: 400 },
        );
      }

      // RE-VALIDATE inside lock: Ensure ALL 30-min chunks are still available
      // This is the critical missing piece - prevents double-booking even after lock
      const validationService = new SlotValidationService(prisma);
      const validation = await validationService.checkSlotAvailability(
        slotChunkStarts,
        consultationPlan.consultantProfile.user.id,
      );

      if (!validation.isValid) {
        console.log(
          JSON.stringify({
            event: "slot_booking_validation_failed",
            consultant: consultantProfileId,
            slot: startsAt,
            user: session.user.id,
            errors: validation.errors,
            timestamp: new Date().toISOString(),
          }),
        );

        return NextResponse.json(
          {
            error: "Slot no longer available",
            details: validation.errors,
          },
          { status: 409 },
        );
      }

      console.log(
        JSON.stringify({
          event: "slot_booking_validation_passed",
          consultant: consultantProfileId,
          slot: startsAt,
          user: session.user.id,
          timestamp: new Date().toISOString(),
        }),
      );

      // CRITICAL SECTION: Create consultation (protected by lock AND validated)
      // Create one SlotOfAppointment per 30-min chunk — consistent with
      // SlotAllocationService which also uses 30-min granularity.
      const slotChunksToCreate = slotChunkStarts.map((chunkStart) => ({
        startsAt: chunkStart,
        endsAt: new Date(chunkStart.getTime() + SLOT_DURATION_MS),
        isTentative: true, // Mark as tentative since it's pending approval
        // #440 — the overlap-guard column must be set at CREATE time even on
        // tentative rows: approval/webhook confirm flips isTentative via
        // updateMany, so whatever is on the row rides into confirmed state.
        consultantProfileId,
        user: {
          connect: [
            { id: session.user.id }, // Consultee
            { id: consultationPlan.consultantProfile.user.id }, // Consultant
          ],
        },
      }));

      const consultation = await prisma.consultation.create({
        data: {
          consultationPlanId: consultationPlanId,
          requestedById: consulteeProfile.id,
          status: AppointmentStatus.PENDING,
          requestNotes: requestNotes,
          appointment: {
            create: {
              appointmentType: "CONSULTATION",
              slotsOfAppointment: {
                create: slotChunksToCreate,
              },
            },
          },
        },
        include: {
          consultationPlan: {
            include: {
              consultantProfile: {
                include: {
                  user: true,
                },
              },
            },
          },
          requestedBy: {
            include: {
              user: true,
            },
          },
          appointment: {
            include: {
              slotsOfAppointment: true,
            },
          },
        },
      });

      console.log(
        JSON.stringify({
          event: "slot_booking_success",
          consultationId: consultation.id,
          consultant: consultantProfileId,
          slot: startsAt,
          user: session.user.id,
          timestamp: new Date().toISOString(),
        }),
      );

      // Fire-and-forget: notify consultant of new booking request
      void notifyNewBookingRequest(
        consultation.consultationPlan.consultantProfile.user.id,
        {
          consulteeName: consultation.requestedBy.user.name || "A consultee",
          planTitle: consultation.consultationPlan.title,
          appointmentType: "CONSULTATION",
          requestedDateTime: startTime.toISOString(),
          dashboardUrl: `/dashboard/consultant/${consultation.consultationPlan.consultantProfile.id}/requests`,
        },
      );

      return NextResponse.json(
        {
          message: "Request for approval submitted successfully",
          data: consultation,
        },
        { status: 201 },
      );
    } catch (lockError) {
      console.error(
        JSON.stringify({
          event: "slot_booking_error",
          consultant: consultantProfileId,
          slot: startsAt,
          user: session.user.id,
          error:
            lockError instanceof Error ? lockError.message : "Unknown error",
          timestamp: new Date().toISOString(),
        }),
      );

      // Check if error is lock acquisition failure (type-safe)
      if (lockError instanceof SlotLockError) {
        return NextResponse.json(
          {
            error: lockError.message,
            retryAfter: lockError.retryAfterSeconds,
          },
          { status: 409 }, // 409 Conflict
        );
      }

      throw lockError; // Re-throw other errors for general error handler
    } finally {
      // ALWAYS release lock (even on error)
      if (lock) {
        await unlockSlotBooking(lock);
        console.log(
          JSON.stringify({
            event: "slot_booking_lock_released",
            consultant: consultantProfileId,
            slot: startsAt,
            user: session.user.id,
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  } catch (error) {
    console.error("Error creating approval request:", error);
    return NextResponse.json(
      { error: "An error occurred while creating the approval request" },
      { status: 500 },
    );
  }
}
