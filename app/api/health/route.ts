import { NextResponse } from "next/server";

import { getMaintenanceState } from "@/lib/maintenance";

type BetterStackHealth = {
  configured: boolean;
  reachable: boolean | null;
  monitors?: { name: string; status: string }[];
};

const BETTERSTACK_CACHE_TTL_MS = 60_000;
// Module-level cache: instance-local in serverless (each cold start resets).
// Acceptable here — just prevents redundant BetterStack API calls within a warm instance.
let betterStackCache: { at: number; value: BetterStackHealth } | null = null;

async function checkBetterStack(): Promise<{
  configured: boolean;
  reachable: boolean | null;
  monitors?: { name: string; status: string }[];
}> {
  const now = Date.now();
  if (betterStackCache && now - betterStackCache.at < BETTERSTACK_CACHE_TTL_MS) {
    return betterStackCache.value;
  }

  const apiKey = process.env.BETTERSTACK_API_KEY;
  if (!apiKey) {
    const value = { configured: false, reachable: null };
    betterStackCache = { at: now, value };
    return value;
  }

  try {
    const res = await fetch("https://uptime.betterstack.com/api/v2/monitors", {
      headers: { Authorization: `Bearer ${apiKey}` },
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      const value = { configured: true, reachable: false };
      betterStackCache = { at: now, value };
      return value;
    }

    const data = await res.json();
    const monitors = (data?.data ?? []).map(
      (m: { attributes: { url: string; status: string } }) => ({
        name: m.attributes.url,
        status: m.attributes.status,
      }),
    );

    const value = { configured: true, reachable: true, monitors };
    betterStackCache = { at: now, value };
    return value;
  } catch {
    const value = { configured: true, reachable: false };
    betterStackCache = { at: now, value };
    return value;
  }
}

export async function GET(request: Request) {
  const includeBetterStack =
    new URL(request.url).searchParams.get("includeBetterStack") === "1";

  const [maintenanceState, betterstack] = await Promise.all([
    getMaintenanceState(),
    includeBetterStack
      ? checkBetterStack()
      : Promise.resolve({
          configured: Boolean(process.env.BETTERSTACK_API_KEY),
          reachable: null,
        }),
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
