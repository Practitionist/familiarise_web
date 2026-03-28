/**
 * Admin: Exchange Rate Cache Management
 *
 * GET  — Returns current cache status (age, staleness)
 * POST — Force-invalidates the in-memory cache, triggering a fresh fetch on next use
 *
 * Useful when FX markets move significantly within the 1-hour cache window.
 */

import { NextResponse } from "next/server";
import { UserRole } from "@prisma/client";
import { getSession } from "@/lib/auth-server";
import {
  invalidateExchangeRateCache,
  getExchangeRateCacheInfo,
  getExchangeRates,
} from "@/lib/currency";
import prisma from "@/lib/prisma";

async function requireAdmin() {
  const session = await getSession();
  if (!session?.user?.id) {
    return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { role: true },
  });
  if (user?.role !== UserRole.ADMIN) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };
  }
  return { userId: session.user.id };
}

export async function GET() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  const info = getExchangeRateCacheInfo();
  return NextResponse.json({
    cached: info.cachedAt !== null,
    cachedAt: info.cachedAt ? new Date(info.cachedAt).toISOString() : null,
    ageMs: info.ageMs,
    ageMinutes: info.ageMs !== null ? Math.round(info.ageMs / 60000) : null,
  });
}

export async function POST() {
  const auth = await requireAdmin();
  if ("error" in auth) return auth.error;

  invalidateExchangeRateCache();

  // Eagerly fetch fresh rates so the next request is fast
  const rates = await getExchangeRates();
  const currencyCount = Object.keys(rates).length;

  return NextResponse.json({
    success: true,
    message: "Exchange rate cache invalidated and refreshed",
    currencyCount,
    refreshedAt: new Date().toISOString(),
  });
}
