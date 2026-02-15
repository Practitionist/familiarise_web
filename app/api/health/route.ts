import { NextResponse } from "next/server";

import { getMaintenanceState } from "@/lib/maintenance";

export async function GET() {
  const maintenanceState = await getMaintenanceState();

  return NextResponse.json({
    status: "healthy",
    maintenance: {
      phase: maintenanceState.phase,
      reason: maintenanceState.reason,
      estimatedEnd: maintenanceState.estimatedEnd,
    },
    timestamp: new Date().toISOString(),
  });
}
