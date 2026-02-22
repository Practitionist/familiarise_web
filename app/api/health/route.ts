import { NextResponse } from "next/server";

import { getMaintenanceState } from "@/lib/maintenance";

async function checkBetterStack(): Promise<{
  configured: boolean;
  reachable: boolean | null;
  monitors?: { name: string; status: string }[];
}> {
  const apiKey = process.env.BETTERSTACK_API_KEY;
  if (!apiKey) return { configured: false, reachable: null };

  try {
    const res = await fetch("https://uptime.betterstack.com/api/v2/monitors", {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return { configured: true, reachable: false };

    const data = await res.json();
    const monitors = (data?.data ?? []).map(
      (m: { attributes: { url: string; status: string } }) => ({
        name: m.attributes.url,
        status: m.attributes.status,
      }),
    );

    return { configured: true, reachable: true, monitors };
  } catch {
    return { configured: true, reachable: false };
  }
}

export async function GET() {
  const [maintenanceState, betterstack] = await Promise.all([
    getMaintenanceState(),
    checkBetterStack(),
  ]);

  return NextResponse.json({
    status: "healthy",
    maintenance: {
      phase: maintenanceState.phase,
      reason: maintenanceState.reason,
      estimatedEnd: maintenanceState.estimatedEnd,
    },
    betterstack,
    timestamp: new Date().toISOString(),
  });
}
