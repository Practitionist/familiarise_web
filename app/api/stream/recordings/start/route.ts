/**
 * Start Recording API Route
 * POST /api/stream/recordings/start
 *
 * Starts recording for a video call. Only consultants can start recordings.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { RecordingService } from "@/lib/stream/recording-service";
import {
  consentRegimeFor,
  getRecordingBlock,
} from "@/lib/stream/recording-consent";
import { RecordingConsentDecision } from "@prisma/client";
import { getMeetingOwnershipInfo } from "@/lib/stream/recording-utils";
import prisma from "@/lib/prisma";
import { streamLogger } from "@/lib/stream-logger";
import {
  answerFileRoute,
  fileApiError,
  parseJsonBody,
} from "@/lib/documents/api-error";

import { getSession } from "@/lib/auth-server";
/** A room records only while unended and its session is still scheduled and unclassified. */
const RECORDABLE_ROOM_WHERE = {
  endedAt: null,
  occurrence: {
    completionStatus: "SCHEDULED" as const,
    outcome: null,
    deletedAt: null,
  },
};

function isRecordableRoom(meeting: {
  endedAt: Date | null;
  occurrence: {
    completionStatus: string;
    outcome: string | null;
    deletedAt: Date | null;
  };
}): boolean {
  return (
    meeting.endedAt === null &&
    meeting.occurrence.completionStatus === "SCHEDULED" &&
    meeting.occurrence.outcome === null &&
    meeting.occurrence.deletedAt === null
  );
}

const startRecordingSchema = z.object({
  meetingId: z.string().min(1, "Meeting session ID is required"),
});

function normalizeTrialMeeting<
  T extends {
    occurrence?: {
      appointment?: {
        trial?: unknown;
        subscription?: unknown;
      } | null;
    } | null;
  },
>(meeting: T): T {
  const appointment = meeting.occurrence?.appointment;
  if (!appointment?.trial || appointment.subscription) {
    return meeting;
  }
  return {
    ...meeting,
    occurrence: {
      ...meeting.occurrence,
      appointment: {
        ...appointment,
        subscription: appointment.trial,
      },
    },
  };
}

export async function POST(req: NextRequest) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user) return fileApiError("UNAUTHORIZED");

    // Capability, not UserRole (#org-appts): owning a consultantProfile is what
    // matters (an org EXPERT counts); the per-appointment ownership check below
    // is the real authz.
    if (!session.user.consultantProfileId) return fileApiError("FORBIDDEN");

    const { meetingId } = await parseJsonBody(req, startRecordingSchema);

    // Verify the meeting session exists and belongs to consultant's appointment
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: {
        occurrence: {
          include: {
            appointment: {
              include: {
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        consultantProfileId: true,
                        recordingEnabled: true,
                        // #1580 C-P1-4 — the accepted co-presenter may record too.
                        collaborators: {
                          where: {
                            status: "ACCEPTED" as const,
                            consultantProfile: { deletedAt: null },
                          },
                          select: { consultantProfileId: true, role: true },
                        },
                      },
                    },
                  },
                },
                class: {
                  include: {
                    classPlan: {
                      select: {
                        consultantProfileId: true,
                        recordingEnabled: true,
                        // #1580 C-P1-4 — the accepted co-presenter may record too.
                        collaborators: {
                          where: {
                            status: "ACCEPTED" as const,
                            consultantProfile: { deletedAt: null },
                          },
                          select: { consultantProfileId: true, role: true },
                        },
                      },
                    },
                  },
                },
                // #1134 P1-6 — without these two the resolver sees no plan for a
                // 1:1, so the actual owner fails isAppointmentOwner and start
                // returns 403. Recording a consultation was not disabled, it was
                // impossible.
                consultation: {
                  include: {
                    consultationPlan: {
                      select: {
                        consultantProfileId: true,
                        recordingEnabled: true,
                      },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        consultantProfileId: true,
                        recordingEnabled: true,
                      },
                    },
                  },
                },
                trial: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        consultantProfileId: true,
                        recordingEnabled: true,
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

    if (!meeting) return fileApiError("NOT_FOUND");

    // Look up consultant profile for the logged-in user
    const consultantProfile = await prisma.consultantProfile.findUnique({
      where: { userId: session.user.id },
      select: { id: true },
    });

    const normalizedMeeting = normalizeTrialMeeting(meeting);

    // Verify the consultant owns this appointment using helper function
    const { isOwner, recordingEnabled } = getMeetingOwnershipInfo(
      normalizedMeeting,
      consultantProfile?.id,
    );

    if (!isOwner) return fileApiError("FORBIDDEN");
    if (!recordingEnabled) return fileApiError("RECORDING_NOT_ENABLED");

    // #1134 P1-7 — consent gate, BEFORE the claim. A 1:1 participant who
    // declined in the lobby blocks recording outright; declining has to have an
    // effect or it is not consent. Group sessions are never blocked here — their
    // recording is the product, disclosed at purchase, and acknowledged rather
    // than consented to.
    const appointment = meeting.occurrence?.appointment;

    /** One shape for a refusal, used by the pre-claim gate and the race re-read. */
    const refuse = () => {
      streamLogger.info("Recording refused — participant declined", {
        meetingId,
      });
      return fileApiError("RECORDING_DECLINED");
    };

    const consentBlock = await getRecordingBlock(meetingId, appointment);
    if (consentBlock.blocked) return refuse();

    // Claim atomically, and re-assert the consent condition IN the claim.
    //
    // The `getRecordingBlock` call above is a separate read, so a participant
    // could commit a DECLINED decision in the window between that count and this
    // write, and recording would start despite a refusal that was already in the
    // database. Check-then-act, with a compliance record as the loser.
    //
    // The relation filter closes it without a transaction: Postgres evaluates the
    // whole predicate at write time, so a decline that commits first makes this
    // match zero rows. The earlier read stays because it produces the specific
    // user-facing reason; this is the part that has to be true.
    const blockOnDecline = consentRegimeFor(appointment) === "OPT_OUT";
    if (!isRecordableRoom(meeting)) return fileApiError("APPOINTMENT_TERMINAL");
    const startedAt = new Date();
    const updated = await prisma.meeting.updateMany({
      where: {
        id: meetingId,
        isRecording: false,
        ...RECORDABLE_ROOM_WHERE,
        ...(blockOnDecline
          ? {
              recordingConsents: {
                none: { decision: RecordingConsentDecision.DECLINED },
              },
            }
          : {}),
      },
      data: {
        isRecording: true,
        recordingStartedAt: startedAt,
        recordingStartedBy: session.user.id,
      },
    });

    if (updated.count === 0) {
      // Either a concurrent start won, or a decline landed between the read and
      // this write. Re-read to say which, so a refused host is not told the
      // wrong thing.
      const raced = await getRecordingBlock(meetingId, appointment);
      if (raced.blocked) return refuse();
      return fileApiError("RECORDING_IN_PROGRESS");
    }

    // Start recording via Stream API (use DB-stored call ID, never trust client)
    const result = await RecordingService.startRecording(
      meeting.streamCallId,
      session.user.id,
    );

    if (!result.success) {
      // Revert only the claim this request wrote; a started webhook that
      // advanced recordingStartedAt means Stream is recording after all.
      await prisma.meeting.updateMany({
        where: {
          id: meetingId,
          isRecording: true,
          recordingStartedAt: startedAt,
          recordingStartedBy: session.user.id,
        },
        data: {
          isRecording: false,
          recordingStartedAt: null,
          recordingStartedBy: null,
        },
      });
      streamLogger.warn("Stream did not start the recording", {
        meetingId,
        error: result.error,
      });
      return fileApiError("VENDOR_UNAVAILABLE");
    }

    return NextResponse.json({
      success: true,
      message: "Recording started",
    });
  }, "stream");
}
