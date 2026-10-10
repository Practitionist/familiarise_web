import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import prisma from "@/lib/prisma";
import {
  CollaboratorCapError,
  CollaboratorNotFoundError,
  CollaboratorTermsLockedError,
  updateCollaborator,
  removeCollaborator,
} from "@/lib/collaborators/service";
import {
  updateClassCollaboratorSchema,
  updateWebinarCollaboratorSchema,
} from "@/schemas/collaborators";
import { hasOrgPermission } from "@/lib/auth/org-permissions";

type PlanType = "webinar" | "class";
type RouteContext = { params: Promise<{ planId: string; id: string }> };

const UPDATE_SCHEMAS = {
  webinar: updateWebinarCollaboratorSchema,
  class: updateClassCollaboratorSchema,
} as const;

const captureRouteError = (
  error: unknown,
  what: string,
  planType: PlanType,
) => {
  Sentry.captureException(
    error instanceof Error ? error : new Error(String(error)),
    { tags: { subsystem: "collaborations" } },
  );
  console.error(`Error ${what} ${planType} collaborator:`, error);
};

async function resolveParties(
  planType: PlanType,
  planId: string,
  userId: string,
) {
  const [plan, callerProfile] = await Promise.all([
    planType === "webinar"
      ? prisma.webinarPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true, organizationId: true },
        })
      : prisma.classPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true, organizationId: true },
        }),
    prisma.consultantProfile.findFirst({
      where: { userId },
      select: { id: true },
    }),
  ]);
  if (!plan) return null;

  const isOwner =
    Boolean(callerProfile?.id) &&
    plan.consultantProfileId === callerProfile?.id;

  let isOrgAdmin = false;
  if (!isOwner && plan.organizationId) {
    const membership = await prisma.membership.findUnique({
      where: {
        userId_organizationId: {
          userId,
          organizationId: plan.organizationId,
        },
      },
      select: {
        status: true,
        role: true,
        organization: { select: { status: true } },
      },
    });
    isOrgAdmin = Boolean(
      membership?.status === "ACTIVE" &&
      membership.organization.status !== "DEACTIVATED" &&
      hasOrgPermission(membership.role, "catalog.manage"),
    );
  }

  if (!callerProfile && !isOrgAdmin) return null;

  return {
    callerProfileId: callerProfile?.id ?? null,
    canManagePlan: isOwner || isOrgAdmin,
  };
}

export async function patchCollaborator(
  planType: PlanType,
  req: NextRequest,
  { params }: RouteContext,
) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { planId, id } = await params;

    const parties = await resolveParties(planType, planId, session.user.id);
    if (!parties?.canManagePlan) {
      return NextResponse.json(
        { error: "Only the plan owner can update collaborators" },
        { status: 403 },
      );
    }

    const body = await req.json();
    const parsed = UPDATE_SCHEMAS[planType].safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors.map((e) => e.message).join(", ") },
        { status: 400 },
      );
    }

    const collab = await updateCollaborator(planType, id, planId, parsed.data);
    if (!collab) {
      return NextResponse.json(
        { error: "Failed to update collaborator" },
        { status: 400 },
      );
    }
    return NextResponse.json({ data: collab });
  } catch (error) {
    if (error instanceof CollaboratorTermsLockedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CollaboratorCapError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof CollaboratorNotFoundError) {
      return NextResponse.json({ error: error.message }, { status: 404 });
    }
    captureRouteError(error, "updating", planType);
    return NextResponse.json(
      { error: "Failed to update collaborator" },
      { status: 500 },
    );
  }
}

const NOT_A_PARTY =
  "Only the plan owner or the collaborator can remove this collaboration";

export async function deleteCollaborator(
  planType: PlanType,
  _req: NextRequest,
  { params }: RouteContext,
) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const { planId, id } = await params;

    const parties = await resolveParties(planType, planId, session.user.id);
    if (!parties) {
      return NextResponse.json({ error: NOT_A_PARTY }, { status: 403 });
    }

    let collab = null;
    if (parties.canManagePlan) {
      collab = await removeCollaborator(planType, id, planId);
    } else if (parties.callerProfileId) {
      collab = await removeCollaborator(planType, id, planId, {
        withdrawnByProfileId: parties.callerProfileId,
      });
    }
    if (!collab) {
      return parties.canManagePlan
        ? NextResponse.json(
            { error: "Failed to remove collaborator" },
            { status: 400 },
          )
        : NextResponse.json({ error: NOT_A_PARTY }, { status: 403 });
    }
    return NextResponse.json({ data: collab });
  } catch (error) {
    captureRouteError(error, "removing", planType);
    return NextResponse.json(
      { error: "Failed to remove collaborator" },
      { status: 500 },
    );
  }
}
