import * as Sentry from "@sentry/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth-server";
import { isPrivileged } from "@/lib/auth-helpers";
import { hasOrgPermission } from "@/lib/auth/org-permissions";
import { calculateRevenueSplit } from "@/lib/collaborators/service";
import prisma from "@/lib/prisma";
import { z } from "zod";

const amountSchema = z.coerce.number().int().min(0).max(1_000_000_000);

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ planId: string }> },
) {
  try {
    const session = await getSession(true);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { planId } = await params;

    if (!isPrivileged(session.user.role)) {
      const plan = await prisma.classPlan.findUnique({
        where: { id: planId },
        select: { consultantProfileId: true, organizationId: true },
      });
      if (!plan) {
        return NextResponse.json({ error: "Plan not found" }, { status: 404 });
      }
      const consultantProfileId = session.user.consultantProfileId;
      const isOwner =
        Boolean(consultantProfileId) &&
        consultantProfileId === plan.consultantProfileId;

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
        const collab = consultantProfileId
          ? await prisma.collaborator.findFirst({
              where: {
                classPlanId: planId,
                consultantProfileId,
                status: "ACCEPTED",
              },
            })
          : null;
        if (!collab) {
          return NextResponse.json({ error: "Forbidden" }, { status: 403 });
        }
      }
    }

    // #1580 C-P2-7 — bounded: `Number()` accepted NaN, negatives and 1e308,
    // and the split math ran on whatever arrived.
    // `?amount=` coerces to 0, not to the documented default (#1593).
    const rawAmount = req.nextUrl.searchParams.get("amount");
    const amountParsed = amountSchema.safeParse(rawAmount || "10000");
    if (!amountParsed.success) {
      return NextResponse.json(
        { error: "amount must be an integer between 0 and 1,000,000,000" },
        { status: 400 },
      );
    }
    const amount = amountParsed.data;

    const splits = await calculateRevenueSplit("class", planId, amount);
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
