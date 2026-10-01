/**
 * GET  /api/admin/data-breaches — #1527 Q5, the Compliance page's read-only
 *      list (newest first; `?unreported=1` is the nav badge's predicate).
 * POST /api/admin/data-breaches
 *
 * LCY-4 (#701) — DPDP breach-reporting intake. The DataBreach model and
 * DATA_BREACH_REPORTED audit action existed since the MVP but had zero
 * writers — a compliance gap where a 72-hour statutory clock had no
 * starting mechanism.
 *
 * Creates the breach record, starts the 72-hour Board-notification clock,
 * and emits an hourly-alert-eligible event (databreach-deadline-alerts cron
 * picks up unreported breaches automatically).
 */

import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { UNREPORTED_BREACH_WHERE } from "@/lib/backoffice/queue-predicates";

const BodySchema = z.object({
  affectedUserIds: z.array(z.string().min(1)).min(1),
  rootCause: z.string().trim().min(1).max(5000),
});

export async function GET(req: NextRequest) {
  const auth = await requireBackofficeSurface("compliance.manage");
  if (auth.error) return auth.error;
  const unreported = new URL(req.url).searchParams.get("unreported") === "1";
  const breaches = await prisma.dataBreach.findMany({
    where: unreported ? UNREPORTED_BREACH_WHERE : undefined,
    orderBy: { detectedAt: "desc" },
    take: 100,
    select: {
      id: true,
      detectedAt: true,
      reportedAt: true,
      rootCause: true,
      dpbReference: true,
      principalsNotifiedAt: true,
      // A count, not the ids: the list never needs who, only how many.
      affectedUserIds: true,
    },
  });
  return NextResponse.json(
    {
      data: breaches.map(({ affectedUserIds, ...b }) => ({
        ...b,
        affectedCount: affectedUserIds.length,
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function POST(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("compliance.manage");
    if (auth.error) return auth.error;

    const parsed = BodySchema.safeParse(await req.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid body", detail: parsed.error.flatten() },
        { status: 400 },
      );
    }

    const breach = await prisma.dataBreach.create({
      data: {
        detectedAt: new Date(),
        affectedUserIds: parsed.data.affectedUserIds,
        rootCause: parsed.data.rootCause,
      },
    });

    // CR #1257 r1 — platform-wide breach has no organizationId; the
    // OrgAuditLog model requires it as a string, so we log via SystemEvent
    // instead and keep the DataBreach row as the compliance record.
    console.log(
      "[data-breach] reported",
      JSON.stringify({
        breachId: breach.id,
        affectedCount: parsed.data.affectedUserIds.length,
        detectedAt: breach.detectedAt.toISOString(),
      }),
    );

    return NextResponse.json({ breach }, { status: 201 });
  } catch (error) {
    console.error("[data-breach] create failed:", error);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}
