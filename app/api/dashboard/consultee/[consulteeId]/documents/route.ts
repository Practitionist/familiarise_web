import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import prisma from "@/lib/prisma";
import {
  requireApiAuth,
  isPrivileged,
  forbiddenResponse,
} from "@/lib/auth-helpers";
import { readConsulteeDocuments } from "@/lib/data/consultee-documents";

/**
 * GET /api/dashboard/consultee/[consulteeId]/documents — #1527
 *
 * The Documents page: plan materials plus the learner's own files and the
 * expert's responses, paged with `?limit=&offset=` and filterable by
 * `?status=` like the consultant documents route. Owner-checked like the
 * resources route; never cached, because a file list is per-person.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ consulteeId: string }> },
) {
  const authResult = await requireApiAuth();
  if (authResult.error) return authResult.error;
  const { session } = authResult;

  try {
    const { consulteeId } = await params;

    if (
      !isPrivileged(session.user.role) &&
      session.user.consulteeProfileId !== consulteeId
    ) {
      return forbiddenResponse("You can only access your own documents");
    }

    const consulteeProfile = await prisma.consulteeProfile.findUnique({
      where: { id: consulteeId },
      select: { userId: true },
    });
    if (!consulteeProfile) {
      return NextResponse.json(
        { error: "Consultee profile not found" },
        { status: 404 },
      );
    }

    const { searchParams } = new URL(request.url);
    const payload = await readConsulteeDocuments({
      consulteeId,
      userId: consulteeProfile.userId,
      limit: Number(searchParams.get("limit") ?? Number.NaN),
      offset: Number(searchParams.get("offset") ?? Number.NaN),
      status: searchParams.get("status"),
    });

    return NextResponse.json(payload, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "dashboard" } },
    );
    return NextResponse.json(
      { error: "Failed to fetch documents" },
      { status: 500 },
    );
  }
}
