import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { getSession } from "@/lib/auth-server";
import { reportSentryError } from "@/lib/observability/report";
import {
  AVAILABILITY_REFUSAL_STATUS,
  weeklyZoneRefusal,
} from "@/lib/scheduling/availability-contract";
import { reportIncompleteWeeklyRows } from "@/lib/scheduling/incomplete-weekly-rows";
import { settleAvailabilityWrite } from "@/lib/scheduling/uncovered-upcoming";
import {
  resolveWeeklyTimezone,
  resolveWeeklyUtcOffsetMinutes,
} from "@/lib/scheduling/weeklyUtcOffset";
import {
  isKnownTimeZone,
  partitionWeeklyRows,
  sameTimeZone,
  weeklySaveProbeOffsetMinutes,
  weeklyWriterColumnsFromLocal,
} from "@/utils/schedule/weekly-projection";

const convertWeeklyZoneSchema = z
  .object({
    timezone: z.string().max(64).refine(isKnownTimeZone, "Unknown time zone"),
  })
  .strict();

/**
 * Moves every weekly row of the caller's schedule into their profile zone,
 * keeping each row's local clock times; only the UTC writer columns change.
 * The zone must equal the saved profile zone, so a stale prompt cannot convert
 * into a zone the consultant has since left.
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401 },
      );
    }

    const parsed = convertWeeklyZoneSchema.safeParse(
      await req.json().catch(() => null),
    );
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", details: parsed.error.format() },
        { status: 400 },
      );
    }

    const profile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id, deletedAt: null },
      select: { id: true, user: { select: { timezone: true } } },
    });
    if (!profile) {
      return NextResponse.json(
        { error: "Consultant profile not found" },
        { status: 404 },
      );
    }

    const zone = resolveWeeklyTimezone(parsed.data.timezone);
    if (zone !== resolveWeeklyTimezone(profile.user?.timezone)) {
      return NextResponse.json(
        {
          error: "Save this timezone on your profile before converting to it",
          code: "ZONE_NOT_PROFILE_ZONE",
        },
        { status: 409 },
      );
    }
    const refusal = weeklyZoneRefusal(zone);
    if (refusal) {
      return NextResponse.json(
        { error: refusal.message, code: refusal.code },
        { status: AVAILABILITY_REFUSAL_STATUS[refusal.code] },
      );
    }

    const probeOffset = weeklySaveProbeOffsetMinutes(zone);
    const utcOffsetMinutes = resolveWeeklyUtcOffsetMinutes({
      profileTimezone: zone,
    });

    return await withSerializableRetry(() =>
      prisma.$transaction(
        async (tx) => {
          const rows = await tx.availabilityWindowWeekly.findMany({
            where: { consultantProfileId: profile.id },
            select: {
              id: true,
              timezone: true,
              localStartDay: true,
              localStartMinutes: true,
              localEndMinutes: true,
              localEndDay: true,
            },
          });
          const { usable, refused } = partitionWeeklyRows(rows);
          reportIncompleteWeeklyRows(refused, {
            op: "convert-weekly-zone",
            consultantProfileId: profile.id,
          });
          const toConvert = usable.filter(
            (row) => !sameTimeZone(row.timezone, zone),
          );
          for (const row of toConvert) {
            await tx.availabilityWindowWeekly.update({
              where: { id: row.id },
              data: {
                ...weeklyWriterColumnsFromLocal(row, probeOffset),
                timezone: zone,
                utcOffsetMinutes,
              },
            });
          }
          const { uncoveredUpcoming } = await settleAvailabilityWrite(
            tx,
            profile.id,
          );
          return NextResponse.json(
            {
              data: { converted: toConvert.length, timezone: zone },
              uncoveredUpcoming,
            },
            { status: 200 },
          );
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
          maxWait: 10_000,
          timeout: 15_000,
        },
      ),
    );
  } catch (error) {
    reportSentryError(error, {
      subsystem: "scheduling",
      op: "convert-weekly-zone",
    });
    return NextResponse.json(
      { error: "An error occurred while converting your weekly hours" },
      { status: 500 },
    );
  }
}
