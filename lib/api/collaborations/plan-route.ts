import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import {
  CollaboratorCapError,
  CollaboratorIneligibleError,
  getCollaboratorsForUser,
  inviteCollaborator,
} from "@/lib/collaborators/service";
import { hasOrgPermission } from "@/lib/auth/org-permissions";

export type PlanCollaborationKind = "webinar" | "class";

interface CollaboratorInviteShape {
  consultantProfileId: string;
  role: string;
  revenueSharePercentage: number;
}

interface PlanRecord {
  consultantProfileId: string | null;
  organizationId?: string | null;
  consultantProfile: unknown;
}

interface PlanRouteConfig {
  planKind: PlanCollaborationKind;
  schema: z.ZodType<CollaboratorInviteShape, z.ZodTypeDef, unknown>;
  fetchLogLabel: string;
  inviteLogLabel: string;
  findPlan: (planId: string) => Promise<PlanRecord | null>;
  findExisting: (
    planId: string,
    consultantProfileId: string,
  ) => Promise<unknown>;
}

export function createPlanCollaborationHandlers(config: PlanRouteConfig) {
  const { planKind, schema, fetchLogLabel, inviteLogLabel } = config;

  async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ planId: string }> },
  ) {
    try {
      const session = await getSession(true);
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const { planId } = await params;
      const result = await getCollaboratorsForUser(
        planKind,
        planId,
        session.user.id,
      );

      if (result.status === "not_found")
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      if (result.status === "forbidden")
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });

      return NextResponse.json({ data: result.data });
    } catch (error) {
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "collaborations" } },
      );
      console.error(`Error fetching ${fetchLogLabel} collaborators:`, error);
      return NextResponse.json(
        { error: "Failed to fetch collaborators" },
        { status: 500 },
      );
    }
  }

  async function POST(
    req: NextRequest,
    { params }: { params: Promise<{ planId: string }> },
  ) {
    try {
      const session = await getSession(true);
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const { planId } = await params;

      const plan = await config.findPlan(planId);
      if (!plan) {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }

      const ownerProfile = await prisma.consultantProfile.findFirst({
        where: { userId: session.user.id },
      });

      const isOwner =
        Boolean(ownerProfile?.id) &&
        plan.consultantProfileId === ownerProfile?.id;

      let isOrgAdmin = false;
      if (!isOwner && plan.organizationId) {
        const membership = await prisma.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: session.user.id,
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
          membership &&
          membership.status === "ACTIVE" &&
          membership.organization.status !== "DEACTIVATED" &&
          hasOrgPermission(membership.role, "catalog.manage"),
        );
      }

      if (!isOwner && !isOrgAdmin) {
        return NextResponse.json(
          { error: "Only the plan owner can invite collaborators" },
          { status: 403 },
        );
      }

      const body = await req.json();
      const parsed = schema.safeParse(body);

      if (!parsed.success) {
        return NextResponse.json(
          { error: parsed.error.errors.map((e) => e.message).join(", ") },
          { status: 400 },
        );
      }

      const { consultantProfileId, role, revenueSharePercentage } = parsed.data;

      if (
        (ownerProfile && consultantProfileId === ownerProfile.id) ||
        (plan.consultantProfileId &&
          consultantProfileId === plan.consultantProfileId)
      ) {
        return NextResponse.json(
          { error: "You cannot invite yourself as a collaborator" },
          { status: 400 },
        );
      }

      const existingCollab = await config.findExisting(
        planId,
        consultantProfileId,
      );
      if (existingCollab) {
        return NextResponse.json(
          {
            error:
              "This consultant already has an active or pending collaboration on this plan",
          },
          { status: 409 },
        );
      }

      const collab = await inviteCollaborator(
        planKind,
        planId,
        consultantProfileId,
        role,
        revenueSharePercentage,
        ownerProfile?.id ?? null,
      );

      if (!collab) {
        return NextResponse.json(
          {
            error:
              "Failed to invite. Revenue share may exceed limit (max 90% total for collaborators).",
          },
          { status: 400 },
        );
      }

      return NextResponse.json({ data: collab });
    } catch (error) {
      if (error instanceof CollaboratorCapError) {
        return NextResponse.json({ error: error.message }, { status: 409 });
      }
      if (error instanceof CollaboratorIneligibleError) {
        return NextResponse.json(
          { error: error.message },
          { status: error.httpStatus },
        );
      }
      Sentry.captureException(
        error instanceof Error ? error : new Error(String(error)),
        { tags: { subsystem: "collaborations" } },
      );
      console.error(`Error inviting ${inviteLogLabel} collaborator:`, error);
      return NextResponse.json(
        { error: "Failed to invite collaborator" },
        { status: 500 },
      );
    }
  }

  return { GET, POST };
}
