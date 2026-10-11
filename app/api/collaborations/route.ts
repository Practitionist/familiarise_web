import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  getMyCollaborations,
  getHostedCollaborations,
  getOrgHostedCollaborations,
} from "@/lib/collaborators/service";
import {
  ORG_SCOPE_READABLE_STATUSES,
  resolveOrgScope,
} from "@/lib/api/scope/parse";
import { hasOrgPermission } from "@/lib/auth/org-permissions";

const EMPTY_COLLABORATIONS = {
  webinarCollaborations: [],
  classCollaborations: [],
  hostedWebinarPlans: [],
  hostedClassPlans: [],
};

async function orgHostedView(
  request: NextRequest,
  userId: string,
): Promise<NextResponse | null> {
  const { searchParams } = request.nextUrl;
  const orgId = searchParams.get("orgScope");
  if (searchParams.get("view") !== "org" || !orgId) return null;
  const membership = await prisma.membership.findUnique({
    where: { userId_organizationId: { userId, organizationId: orgId } },
    select: {
      status: true,
      role: true,
      organization: { select: { status: true } },
    },
  });
  if (
    membership?.status !== "ACTIVE" ||
    !ORG_SCOPE_READABLE_STATUSES.includes(membership.organization.status) ||
    !hasOrgPermission(membership.role, "catalog.manage")
  ) {
    return NextResponse.json(
      { error: "Forbidden — your role does not grant catalog.manage" },
      { status: 403 },
    );
  }
  const hosted = await getOrgHostedCollaborations(orgId);
  return NextResponse.json({
    data: {
      ...EMPTY_COLLABORATIONS,
      hostedWebinarPlans: hosted.webinarPlans,
      hostedClassPlans: hosted.classPlans,
    },
  });
}

export async function GET(request: NextRequest) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const orgView = await orgHostedView(request, session.user.id);
    if (orgView) return orgView;

    const consultantProfile = await prisma.consultantProfile.findFirst({
      where: { userId: session.user.id },
    });

    if (!consultantProfile) {
      return NextResponse.json({ data: EMPTY_COLLABORATIONS });
    }

    const { searchParams } = request.nextUrl;
    const rawOrgScope = searchParams.get("orgScope");
    const memberships = await prisma.membership.findMany({
      where: { userId: session.user.id, status: "ACTIVE" },
      select: {
        organizationId: true,
        status: true,
        role: true,
        organization: { select: { status: true } },
      },
    });
    const matchedMembership = rawOrgScope
      ? memberships.find((m) => m.organizationId === rawOrgScope)
      : undefined;
    const scopeResolution = resolveOrgScope({
      raw: rawOrgScope,
      memberships,
      orgStatus: matchedMembership?.organization.status,
      userRole: session.user.role,
      userId: session.user.id,
      allowAllForOwner: true,
    });
    if (!scopeResolution.ok) {
      return NextResponse.json(
        { error: scopeResolution.message, code: scopeResolution.code },
        { status: scopeResolution.status },
      );
    }

    const [collaborations, hosted] = await Promise.all([
      getMyCollaborations(consultantProfile.id),
      getHostedCollaborations(consultantProfile.id, scopeResolution.scope),
    ]);

    return NextResponse.json({
      data: {
        ...collaborations,
        hostedWebinarPlans: hosted.webinarPlans,
        hostedClassPlans: hosted.classPlans,
        hostUser: {
          name: session.user.name ?? null,
          image: session.user.image ?? null,
        },
      },
    });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "collaborations" } },
    );
    console.error("Error fetching collaborations:", error);
    return NextResponse.json(
      { error: "Failed to fetch collaborations" },
      { status: 500 },
    );
  }
}
