import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { answerFileRoute, fileApiError } from "@/lib/documents/api-error";
import { loadRecordingView } from "@/lib/stream/recording-slots";

/** The booking's recordings as the viewer's session slots, with parts and catch-up. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    const { appointmentId } = await params;
    const view = await loadRecordingView(appointmentId, session.user.id);
    if (!view) return fileApiError("NOT_FOUND");
    return NextResponse.json(view, {
      headers: { "Cache-Control": "private, no-store" },
    });
  }, "stream");
}
