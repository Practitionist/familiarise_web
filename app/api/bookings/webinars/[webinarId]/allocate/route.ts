/**
 * Webinar Slot Allocation API Route — resolves the segment param and delegates
 * to the shared handler in lib/scheduling/allocate-route.ts.
 */

import { NextRequest } from "next/server";
import { handleAllocate } from "@/lib/scheduling/allocate-route";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ webinarId: string }> },
) {
  const { webinarId } = await params;
  return handleAllocate(request, "webinar", webinarId);
}
