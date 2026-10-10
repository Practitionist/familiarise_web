import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import {
  calculateRevenueSplit,
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

const revenueSplitAmountSchema = z.coerce
  .number()
  .int()
  .min(0)
  .max(1_000_000_000);

async function isOrgCatalogAdmin(
  userId: string,
  organizationId: string | null | undefined,
): Promise<boolean> {
  if (!organizationId) return false;
  const membership = await prisma.membership.findUnique({
    where: {
      userId_organizationId: {
        userId,
        organizationId,
      },
    },
    select: {
      status: true,
      role: true,
      organization: { select: { status: true } },
    },
  });
  return Boolean(
    membership?.status === "ACTIVE" &&
    membership.organization.status !== "DEACTIVATED" &&
    hasOrgPermission(membership.role, "catalog.manage"),
  );
}

async function authorizePlanInviteCaller(
  userId: string,
  plan: PlanRecord,
): Promise<{
  allowed: boolean;
  ownerProfileId: string | null;
}> {
  const ownerProfile = await prisma.consultantProfile.findFirst({
    where: { userId },
  });
  const ownerProfileId = ownerProfile?.id ?? null;
  const isOwner =
    Boolean(ownerProfileId) && plan.consultantProfileId === ownerProfileId;
  const isOrgAdmin =
    !isOwner && (await isOrgCatalogAdmin(userId, plan.organizationId));
  return { allowed: isOwner || isOrgAdmin, ownerProfileId };
}

export function createPlanCollaborationHandlers(config: PlanRouteConfig) {
  const { planKind, schema, fetchLogLabel, inviteLogLabel } = config;

  async function GET(
    _req: NextRequest,
    { params }: { params: Promise<{ planId: string }> },
  ) {
    try {
      const session = await getSession();
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const { planId } = await params;
      const result = await getCollaboratorsForUser(
        planKind,
        planId,
        session.user.id,
      );

      if (result.status === "not_found") {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }
      if (result.status === "forbidden") {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }

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
      const session = await getSession();
      if (!session?.user?.id) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }

      const { planId } = await params;

      const plan = await config.findPlan(planId);
      if (!plan) {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }

      const { allowed, ownerProfileId } = await authorizePlanInviteCaller(
        session.user.id,
        plan,
      );
      if (!allowed) {
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
        consultantProfileId === ownerProfileId ||
        consultantProfileId === plan.consultantProfileId
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
        ownerProfileId,
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

async function authorizeRevenueSplitReader(
  planType: PlanCollaborationKind,
  planId: string,
  userId: string,
  consultantProfileId: string | null | undefined,
): Promise<{ denied: NextResponse | null; canSeeAll: boolean }> {
  const plan =
    planType === "webinar"
      ? await prisma.webinarPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true, organizationId: true },
        })
      : await prisma.classPlan.findUnique({
          where: { id: planId },
          select: { consultantProfileId: true, organizationId: true },
        });
  if (!plan) {
    return {
      denied: NextResponse.json({ error: "Plan not found" }, { status: 404 }),
      canSeeAll: false,
    };
  }

  const isOwner =
    Boolean(consultantProfileId) &&
    consultantProfileId === plan.consultantProfileId;
  if (isOwner) return { denied: null, canSeeAll: true };

  if (await isOrgCatalogAdmin(userId, plan.organizationId)) {
    return { denied: null, canSeeAll: true };
  }

  const collab = consultantProfileId
    ? await prisma.collaborator.findFirst({
        where: {
          ...(planType === "webinar"
            ? { webinarPlanId: planId }
            : { classPlanId: planId }),
          consultantProfileId,
          status: "ACCEPTED",
        },
      })
    : null;

  if (!collab) {
    return {
      denied: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
      canSeeAll: false,
    };
  }

  return { denied: null, canSeeAll: false };
}

export async function handlePlanRevenueSplitGet(
  planType: PlanCollaborationKind,
  planId: string,
  req?: NextRequest,
): Promise<NextResponse> {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let canSeeAll = isPrivileged(session.user.role);
    if (!canSeeAll) {
      const auth = await authorizeRevenueSplitReader(
        planType,
        planId,
        session.user.id,
        session.user.consultantProfileId,
      );
      if (auth.denied) return auth.denied;
      canSeeAll = auth.canSeeAll;
    }

    const rawAmount = req?.nextUrl.searchParams.get("amount");
    const amountParsed = revenueSplitAmountSchema.safeParse(
      rawAmount || "10000",
    );
    if (!amountParsed.success) {
      return NextResponse.json(
        { error: "amount must be an integer between 0 and 1,000,000,000" },
        { status: 400 },
      );
    }

    const allSplits = await calculateRevenueSplit(
      planType,
      planId,
      amountParsed.data,
    );
    const splits = canSeeAll
      ? allSplits
      : allSplits.filter(
          (s) => s.consultantProfileId === session.user.consultantProfileId,
        );
    return NextResponse.json({ data: splits });
  } catch (error) {
    Sentry.captureException(
      error instanceof Error ? error : new Error(String(error)),
      { tags: { subsystem: "collaborations" } },
    );
    console.error("Error calculating revenue split:", error);
    return NextResponse.json(
      { error: "Failed to calculate revenue split" },
      { status: 500 },
    );
  }
}
