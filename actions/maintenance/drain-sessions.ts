"use server";

/**
 * Video Call Draining — called before entering OFFLINE maintenance phase.
 *
 * Finds active meeting sessions, stops any in-progress recordings,
 * notifies participants, and ends calls via Stream server SDK.
 */

import { RecordingService } from "@/lib/stream/recording-service";
import { getStreamVideoClient } from "@/lib/stream-client";
import prisma from "@/lib/prisma";
import { notifyMaintenanceStarted } from "@/lib/novu/service";

interface DrainResult {
  drained: number;
  recordingsStopped: number;
  notified: number;
  errors: string[];
}

export async function drainActiveSessions(): Promise<DrainResult> {
  const result: DrainResult = {
    drained: 0,
    recordingsStopped: 0,
    notified: 0,
    errors: [],
  };

  // Find all active (not yet ended) meeting sessions
  const activeSessions = await prisma.meetingSession.findMany({
    where: { endedAt: null },
    include: {
      slotOfAppointment: {
        include: {
          user: { select: { id: true } },
          appointment: {
            include: {
              consultation: {
                include: {
                  consultationPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                  requestedBy: {
                    select: { user: { select: { id: true } } },
                  },
                },
              },
              subscription: {
                include: {
                  subscriptionPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                  requestedBy: {
                    select: { user: { select: { id: true } } },
                  },
                },
              },
              webinar: {
                include: {
                  webinarPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                },
              },
              class: {
                include: {
                  classPlan: {
                    select: {
                      consultantProfile: {
                        select: { user: { select: { id: true } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (activeSessions.length === 0) {
    return result;
  }

  // Collect all unique user IDs across all active sessions for bulk notification
  const allUserIds = new Set<string>();

  for (const session of activeSessions) {
    // Collect participant user IDs from the slot
    for (const user of session.slotOfAppointment.user) {
      allUserIds.add(user.id);
    }

    // Collect consultant user ID from the appointment
    const appointment = session.slotOfAppointment.appointment;
    const consultantUserId =
      appointment.consultation?.consultationPlan?.consultantProfile?.user?.id ??
      appointment.subscription?.subscriptionPlan?.consultantProfile?.user?.id ??
      appointment.webinar?.webinarPlan?.consultantProfile?.user?.id ??
      appointment.class?.classPlan?.consultantProfile?.user?.id;
    if (consultantUserId) allUserIds.add(consultantUserId);

    // Collect consultee user ID (for 1:1 appointments)
    const consulteeUserId =
      appointment.consultation?.requestedBy?.user?.id ??
      appointment.subscription?.requestedBy?.user?.id;
    if (consulteeUserId) allUserIds.add(consulteeUserId);

    // Step 1: Stop recording if active
    if (session.isRecording) {
      try {
        await RecordingService.stopRecording(session.streamCallId);
        await prisma.meetingSession.update({
          where: { id: session.id },
          data: { isRecording: false },
        });
        result.recordingsStopped++;
      } catch (err) {
        result.errors.push(
          `Stop recording ${session.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    // Step 2: End call via Stream server SDK
    try {
      const client = getStreamVideoClient();
      const callId = session.streamCallId.includes(":")
        ? session.streamCallId.split(":")[1]
        : session.streamCallId;
      const call = client.video.call("default", callId);
      await call.end();
    } catch (err) {
      // Call may already be ended — not a critical error
      result.errors.push(
        `End call ${session.streamCallId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Step 3: Update DB session as ended
    await prisma.meetingSession.update({
      where: { id: session.id },
      data: {
        endedAt: new Date(),
        endedReason: "maintenance",
      },
    });

    result.drained++;
  }

  // Step 4: Send maintenance notification to all affected users (fire-and-forget)
  const userIdList = Array.from(allUserIds);
  if (userIdList.length > 0) {
    try {
      await notifyMaintenanceStarted({
        phase: "OFFLINE",
        reason: "Platform maintenance starting. Active calls have been ended.",
      });
      result.notified = userIdList.length;
    } catch (err) {
      result.errors.push(
        `Notification: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log(
    JSON.stringify({
      event: "maintenance_sessions_drained",
      ...result,
      timestamp: new Date().toISOString(),
    }),
  );

  return result;
}
