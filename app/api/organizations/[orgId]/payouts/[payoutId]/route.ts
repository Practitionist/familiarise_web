/**
 * GET   /api/organizations/[orgId]/payouts/[payoutId]
 * PATCH /api/organizations/[orgId]/payouts/[payoutId]
 *
 * GET returns a single payout with its attached earnings. PATCH is narrow:
 * it permits only manual admin transitions that don't require bank-side
 * interaction. Real state transitions (PENDING or APPROVED → PROCESSING →
 * COMPLETED) come from the payout cron that talks to the gateway.
 *
 * Allowed manual transitions are the shared PAYOUT_ALLOWED_FROM map's
 * (#1846 SM-B12), applied through transitionOrgPayout:
 *   PENDING  → APPROVED   (explicit manager sign-off; the cron still pays it)
 *   PENDING  → CANCELLED  (releases the BATCHED earnings back to READY)
 * An APPROVED payout cannot be cancelled: after sign-off it can only fail or
 * be reversed. A FAILED payout is terminal: its earnings were released when
 * it failed.
 *
 * #1851 decision 4 — approval takes two people when the org has two: the
 * member who created a batch cannot approve it while another ACTIVE
 * `payouts.approve` holder exists. A one-person org self-approves by typing
 * its slug (`confirmSelfApproval`), and the audit row says so.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma, { type Tx } from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import {
  hasOrgPermission,
  rolesWithOrgPermission,
} from "@/lib/auth/org-permissions";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";
import {
  PAYOUT_ALLOWED_FROM,
  transitionOrgPayout,
} from "@/lib/enterprise/transitions";

const PatchStatusSchema = z.enum(["APPROVED", "CANCELLED"]);

const PatchBodySchema = z
  .object({
    status: PatchStatusSchema.optional(),
    notes: z.string().max(2000).optional(),
    // #1851 decision 4 — the org slug, typed, when the only payout approver
    // approves their own batch.
    confirmSelfApproval: z.string().max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "PATCH body must contain at least one field",
  });

type SelfApproval = "not-self" | "self-allowed" | "second-approver-required";

/**
 * #1851 decision 4. The creator is the actor on the batch's PAYOUT_INITIATED
 * row (OrganizationPayout has no creator column); a batch the cron built has
 * no human creator, so anyone holding the key may approve it.
 */
async function classifySelfApproval(
  tx: Pick<Tx, "orgAuditLog" | "membership">,
  input: { orgId: string; payoutId: string; actorMembershipId: string },
): Promise<SelfApproval> {
  const initiated = await tx.orgAuditLog.findFirst({
    where: {
      organizationId: input.orgId,
      category: "PAYOUT",
      action: AUDIT_ACTIONS.PAYOUT.PAYOUT_INITIATED,
      details: { path: ["payoutId"], equals: input.payoutId },
    },
    select: { actorMembershipId: true },
  });
  if (initiated?.actorMembershipId !== input.actorMembershipId) {
    return "not-self";
  }
  const approvers = await tx.membership.count({
    where: {
      organizationId: input.orgId,
      status: "ACTIVE",
      role: { in: rolesWithOrgPermission("payouts.approve") },
    },
  });
  return approvers >= 2 ? "second-approver-required" : "self-allowed";
}

export async function GET(
  _req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; payoutId: string }>;
  },
) {
  const { orgId, payoutId } = await params;
  const access = await requireOrgAccess(orgId, { permission: "payouts.read" });
  if (access.error) return access.error;

  const payout = await prisma.organizationPayout.findFirst({
    where: { id: payoutId, organizationId: orgId },
    include: {
      earnings: {
        select: {
          id: true,
          paymentId: true,
          grossAmountPaise: true,
          orgSharePaise: true,
          platformFeePaise: true,
          consultantSharePaise: true,
          refundedAmountPaise: true,
          currency: true,
          status: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      },
    },
  });
  if (!payout) {
    return NextResponse.json({ error: "Payout not found" }, { status: 404 });
  }
  return NextResponse.json({ payout });
}

export async function PATCH(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; payoutId: string }>;
  },
) {
  const { orgId, payoutId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "payouts.manage",
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = PatchBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.organizationPayout.findFirst({
        where: { id: payoutId, organizationId: orgId },
      });
      if (!current) {
        throw Object.assign(new Error("Payout not found"), { httpStatus: 404 });
      }

      // Friendly refusal from the read; the CAS inside transitionOrgPayout is
      // what actually enforces the map, so a concurrent move still loses.
      if (
        body.status &&
        !PAYOUT_ALLOWED_FROM[body.status].includes(current.status)
      ) {
        throw Object.assign(
          new Error(
            `Cannot transition payout from ${current.status} to ${body.status} manually`,
          ),
          { httpStatus: 409 },
        );
      }

      // #1851 decision 4 — the second pair of eyes.
      let selfApproved = false;
      if (body.status === "APPROVED") {
        if (!hasOrgPermission(access.member.role, "payouts.approve")) {
          throw Object.assign(new Error("Your role cannot approve payouts."), {
            httpStatus: 403,
            code: "PAYOUT_APPROVE_FORBIDDEN",
          });
        }
        const selfApproval = await classifySelfApproval(tx, {
          orgId,
          payoutId,
          actorMembershipId: access.member.id,
        });
        if (selfApproval === "second-approver-required") {
          throw Object.assign(
            new Error(
              "You created this payout batch, so another Owner or Billing admin has to approve it.",
            ),
            { httpStatus: 403, code: "PAYOUT_SECOND_APPROVER_REQUIRED" },
          );
        }
        if (selfApproval === "self-allowed") {
          if (body.confirmSelfApproval !== access.org.slug) {
            throw Object.assign(
              new Error(
                "You are the only person who can approve payouts here. Type the organization's slug to approve your own batch.",
              ),
              {
                httpStatus: 409,
                code: "PAYOUT_SELF_APPROVAL_CONFIRM_REQUIRED",
              },
            );
          }
          selfApproved = true;
        }
      }

      if (body.status) {
        await transitionOrgPayout(tx, {
          where: { id: payoutId, organizationId: orgId },
          to: body.status,
          audit: {
            organizationId: orgId,
            actorMembershipId: access.member.id,
            category: "PAYOUT",
            // #1584 P1-AU01 — a manual move is an override, not an initiation.
            action:
              body.status === "CANCELLED"
                ? AUDIT_ACTIONS.PAYOUT.PAYOUT_CANCELLED
                : AUDIT_ACTIONS.PAYOUT.PAYOUT_STATUS_OVERRIDDEN,
            description: `Payout ${payoutId}: ${current.status} → ${body.status}`,
            details: {
              payoutId,
              from: current.status,
              to: body.status,
              notes: body.notes ?? null,
              ...(selfApproved && { selfApproved: true }),
            },
          },
        });
      }

      // CANCELLED releases the payout's earnings back to READY so a later run
      // can pick them up. #1846 SM-B12 — only BATCHED rows: the release used
      // to match every earning on the payout, so one the refund cascade had
      // already moved to REFUNDED came back as READY and was paid out again.
      if (body.status === "CANCELLED") {
        await tx.organizationEarnings.updateMany({
          where: { orgPayoutId: payoutId, status: "BATCHED" },
          data: { status: "READY", orgPayoutId: null },
        });
      }

      const next = await tx.organizationPayout.findUniqueOrThrow({
        where: { id: payoutId },
      });
      return next;
    });

    return NextResponse.json({ payout: updated });
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      const code =
        "code" in err && typeof err.code === "string" ? err.code : undefined;
      return NextResponse.json(
        { error: err.message, ...(code && { code }) },
        { status },
      );
    }
    Sentry.captureException(
      err instanceof Error ? err : new Error(String(err)),
      { tags: { subsystem: "organizations" } },
    );
    throw err;
  }
}
