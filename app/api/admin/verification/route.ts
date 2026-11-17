/**
 * GET /api/admin/verification — one page of profile verifications in one
 * status (PENDING by default), oldest submission first.
 */

import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { ProfileVerificationStatus } from "@prisma/client";
import { z } from "zod";
import { requireBackofficeSurface } from "@/lib/auth-helpers";
import { getVerificationQueue } from "@/lib/api/operators";
import { readPageParams } from "@/lib/backoffice/list-paging";

const statusSchema = z
  .nativeEnum(ProfileVerificationStatus)
  .default(ProfileVerificationStatus.PENDING);

export async function GET(req: NextRequest) {
  try {
    const auth = await requireBackofficeSurface("users.verify");
    if (auth.error) return auth.error;

    const { searchParams } = new URL(req.url);
    const status = statusSchema.safeParse(
      searchParams.get("status") ?? undefined,
    );
    if (!status.success) {
      return NextResponse.json(
        { error: "Unknown verification status", code: "INVALID_STATUS" },
        { status: 400 },
      );
    }

    const result = await getVerificationQueue({
      status: status.data,
      paging: readPageParams(searchParams, 20),
    });

    return NextResponse.json(result);
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "admin" } },
    );
    console.error("Error fetching verifications:", error);
    return NextResponse.json(
      { error: "Failed to fetch verifications" },
      { status: 500 },
    );
  }
}
