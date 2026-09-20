/**
 * Subscription Slot Allocation API Route — resolves the segment param and delegates
 * to the shared handler in lib/scheduling/allocate-route.ts.
 */

import { NextRequest } from "next/server";
import { handleAllocate } from "@/lib/scheduling/allocate-route";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subscriptionId: string }> },
) {
  const { subscriptionId } = await params;
  return handleAllocate(request, "subscription", subscriptionId);
}
