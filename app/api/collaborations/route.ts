import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "@/lib/api/cache-headers";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  getMyCollaborations,
  getHostedCollaborations,
} from "@/lib/collaborators/service";
import { resolveOrgScope } from "@/lib/api/scope/parse";

// #org-appts / #1025 — hosted-plan collaborators split by the PLAN's
// org-ness: org-hosted plans belong in the org dashboard, B2C plans in the
// personal one. `?orgScope=` picks the hosted-plan slice; received
// invitations (getMyCollaborations) always aggregate personally.
export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json(
        { error: "Unauthorized" },
        { status: 401, headers: NO_STORE_HEADERS },
      );
    }

    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json(
        {
          data: {
            webinarCollaborations: [],
            classCollaborations: [],
            hostedWebinarPlans: [],
            hostedClassPlans: [],
          },
        },
        { headers: NO_STORE_HEADERS },
      );
    }

    const { searchParams } = request.nextUrl;
    const memberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: { organizationId: true, status: true, role: true },
    });
    const scopeResolution = resolveOrgScope({
      raw: searchParams.get("orgScope"),
      memberships,
      userRole: session.user.role,
      userId: session.user.id,
      // Self-scoped to the caller's own hosted plans — no cross-tenant leak.
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        {
          status: scopeResolution.status,
          headers: NO_STORE_HEADERS,
        },
      );
    }

    const [collaborations, hosted] = await Promise.all([
      getMyCollaborations(consultantProfile.id),
      getHostedCollaborations(consultantProfile.id, scopeResolution.scope),
    ]);

    return NextResponse.json(
      {
        data: {
          ...collaborations,
          hostedWebinarPlans: hosted.webinarPlans,
          hostedClassPlans: hosted.classPlans,
          hostUser: {
            name: session.user.name ?? null,
            image: session.user.image ?? null,
          },
        },
      },
      { headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "collaborations" } },
    );
    console.error("Error fetching collaborations:", error);
    return NextResponse.json(
      { error: "Failed to fetch collaborations" },
      { status: 500, headers: NO_STORE_HEADERS },
    );
  }
}
