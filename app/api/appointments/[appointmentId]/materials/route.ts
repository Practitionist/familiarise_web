import { NextResponse } from "next/server";

import { getSession } from "@/lib/auth-server";
import { answerFileRoute, fileApiError } from "@/lib/documents/api-error";
import { readBookingMaterials } from "@/lib/plans/booking-materials";

/** The booking's plan materials the viewer may open; metadata only, opened through the viewer route. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ appointmentId: string }> },
) {
  return answerFileRoute(async () => {
    const session = await getSession();
    if (!session?.user?.id) return fileApiError("UNAUTHORIZED");
    const { appointmentId } = await params;
    const materials = await readBookingMaterials(
      appointmentId,
      session.user.id,
    );
    if (!materials) return fileApiError("NOT_FOUND");
    return NextResponse.json(
      { materials },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  }, "plans");
}
