import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { answerFileRoute, fileApiError } from "@/lib/documents/api-error";
import {
  readRecordingSlots,
  resolveRecordingViewer,
} from "@/lib/stream/recording-slots";

/** The booking's recordings as the viewer's session slots, with parts and catch-up. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    const { appointmentId } = await params;
    const viewer = await resolveRecordingViewer(appointmentId, session.user.id);
    if (!viewer) return fileApiError("NOT_FOUND");
    const view = await readRecordingSlots(viewer, session.user.id);
    return NextResponse.json(view, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }, "stream");
}
