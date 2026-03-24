/**
 * POST /api/webhooks/stream/recording
 *
 * Handles Stream.io call recording webhooks.
 * When a recording is ready, notifies all participants.
 *
 * Stream webhook event: call.recording.ready
 * Docs: https://getstream.io/video/docs/api/webhooks/overview/
 */

import { NextRequest, NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import { notifyRecordingAvailable } from "@/lib/novu/service";
import { createHmac } from "crypto";
import { getAppUrl } from "@/lib/url";

const STREAM_WEBHOOK_SECRET = process.env.STREAM_WEBHOOK_SECRET ?? "";

function verifyStreamSignature(
  body: string,
  signature: string | null,
): boolean {
  if (!STREAM_WEBHOOK_SECRET || !signature) return false;
  const expected = createHmac("sha256", STREAM_WEBHOOK_SECRET)
    .update(body)
    .digest("hex");
  return signature === expected;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const rawBody = await req.text();
    const signature = req.headers.get("x-signature");

    // Verify webhook signature in production
    if (
      process.env.NODE_ENV === "production" &&
      !verifyStreamSignature(rawBody, signature)
    ) {
      console.warn("[stream/recording] Invalid webhook signature");
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    const body = JSON.parse(rawBody);
    const eventType = body?.type;

    // Only handle recording ready events
    if (eventType !== "call.recording.ready") {
      return NextResponse.json({ received: true, skipped: true });
    }

    const callCid = body?.call_cid; // e.g., "default:meeting-abc123"
    const recordingUrl = body?.call_recording?.url;

    if (!callCid || !recordingUrl) {
      console.warn("[stream/recording] Missing callCid or recordingUrl");
      return NextResponse.json(
        { error: "Missing required fields" },
        { status: 400 },
      );
    }

    // Extract the call ID from CID (format: "type:id")
    const streamCallId = callCid.split(":")[1] ?? callCid;

    // Look up the meeting session to find participants
    const meetingSession = await prisma.meetingSession.findFirst({
      where: { streamCallId },
      include: {
        slotOfAppointment: {
          include: {
            appointment: {
              include: {
                consultation: {
                  include: {
                    consultationPlan: {
                      select: {
                        consultantProfile: {
                          select: {
                            user: { select: { name: true } },
                          },
                        },
                      },
                    },
                  },
                },
                subscription: {
                  include: {
                    subscriptionPlan: {
                      select: {
                        consultantProfile: {
                          select: {
                            user: { select: { name: true } },
                          },
                        },
                      },
                    },
                  },
                },
                webinar: {
                  include: {
                    webinarPlan: {
                      select: {
                        consultantProfile: {
                          select: {
                            user: { select: { name: true } },
                          },
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
                          select: {
                            user: { select: { name: true } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            user: { select: { id: true } },
          },
        },
      },
    });

    if (!meetingSession?.slotOfAppointment) {
      console.warn(
        `[stream/recording] No meeting session found for call: ${streamCallId}`,
      );
      return NextResponse.json({ received: true, noSession: true });
    }

    const slot = meetingSession.slotOfAppointment;
    const apt = slot.appointment;

    // Determine event type and consultant name
    let appointmentType = "consultation";
    let consultantName = "Consultant";

    if (apt?.consultation) {
      appointmentType = "consultation";
      consultantName =
        apt.consultation.consultationPlan?.consultantProfile?.user?.name ??
        "Consultant";
    } else if (apt?.subscription) {
      appointmentType = "subscription";
      consultantName =
        apt.subscription.subscriptionPlan?.consultantProfile?.user?.name ??
        "Consultant";
    } else if (apt?.webinar) {
      appointmentType = "webinar";
      consultantName =
        apt.webinar.webinarPlan?.consultantProfile?.user?.name ?? "Consultant";
    } else if (apt?.class) {
      appointmentType = "class";
      consultantName =
        apt.class.classPlan?.consultantProfile?.user?.name ?? "Consultant";
    }

    // Get all participant user IDs from the slot's M2M relation
    const userIds = slot.user.map((u: { id: string }) => u.id);

    if (userIds.length > 0) {
      const baseUrl = getAppUrl();

      await notifyRecordingAvailable(userIds, {
        appointmentType,
        consultantName,
        recordingUrl,
        dashboardUrl: `${baseUrl}/dashboard`,
      });

      console.log(
        `[stream/recording] Notified ${userIds.length} users for call ${streamCallId}`,
      );
    }

    return NextResponse.json({ received: true, notified: userIds.length });
  } catch (error) {
    console.error("[stream/recording] Error:", error);
    return NextResponse.json(
      { error: "Webhook processing failed" },
      { status: 500 },
    );
  }
}
