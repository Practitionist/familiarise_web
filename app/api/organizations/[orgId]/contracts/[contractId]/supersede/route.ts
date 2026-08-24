/**
 * POST /api/organizations/[orgId]/contracts/[contractId]/supersede
 *
 * #779 §A — contracts are immutable once in use (terms lock at signing); the
 * only way to change them is to SUPERSEDE: mint a successor with the new terms,
 * re-point the programs, and retire the old row with the chain recorded.
 *   AMENDMENT — mid-term change: successor starts now, old → TERMINATED.
 *   RENEWAL   — term rollover:   successor starts at old effectiveTo (same
 *               duration by default), old → EXPIRED. Mirrors the auto-renew
 *               cron (jobs/contracts/auto-renew-contracts.ts) for the manual path.
 * Invoices keep their old contractId — the money trail stays on the term that
 * billed them. The `supersededByContractId @unique` is the double-run backstop.
 */

import * as Sentry from "@sentry/nextjs";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { requireOrgAccess } from "@/lib/auth-helpers";
import { AUDIT_ACTIONS } from "@/lib/enterprise/audit-actions";

const BodySchema = z.object({
  reason: z.enum(["AMENDMENT", "RENEWAL"]),
  // New terms — anything omitted carries over from the old contract.
  effectiveFrom: z.coerce.date().optional(),
  effectiveTo: z.coerce.date().nullable().optional(),
  paymentTermsDays: z.coerce.number().int().min(1).max(120).optional(),
  autoRenew: z.coerce.boolean().optional(),
  rateCardId: z.string().min(1).nullable().optional(),
});

export async function POST(
  req: NextRequest,
  {
    params,
  }: {
    params: Promise<{ orgId: string; contractId: string }>;
  },
) {
  const { orgId, contractId } = await params;
  const access = await requireOrgAccess(orgId, {
    permission: "contracts.manage",
    canSponsor: true,
  });
  if (access.error) return access.error;

  const raw = await req.json().catch(() => null);
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid body", detail: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const body = parsed.data;

  try {
    const result = await prisma.$transaction(async (tx) => {
      const old = await tx.contract.findFirst({
        where: { id: contractId, organizationId: orgId },
      });
      if (!old) {
        throw Object.assign(new Error("Contract not found"), {
          httpStatus: 404,
        });
      }
      if (old.status !== "ACTIVE") {
        throw Object.assign(
          new Error("Only an ACTIVE contract can be superseded"),
          { httpStatus: 409, code: "CONTRACT_NOT_ACTIVE" },
        );
      }
      if (old.supersededByContractId) {
        throw Object.assign(new Error("Contract already superseded"), {
          httpStatus: 409,
          code: "CONTRACT_ALREADY_SUPERSEDED",
        });
      }

      const now = new Date();
      // RENEWAL chains off the old term's end; AMENDMENT cuts over now.
      const effectiveFrom =
        body.effectiveFrom ??
        (body.reason === "RENEWAL" ? (old.effectiveTo ?? now) : now);
      // RENEWAL default = same duration as the old term; AMENDMENT keeps the
      // old end date (the term length isn't changing, only the terms).
      const defaultTo =
        body.reason === "RENEWAL"
          ? old.effectiveTo
            ? new Date(
                effectiveFrom.getTime() +
                  (old.effectiveTo.getTime() - old.effectiveFrom.getTime()),
              )
            : null
          : old.effectiveTo;
      const effectiveTo =
        body.effectiveTo !== undefined ? body.effectiveTo : defaultTo;

      const successor = await tx.contract.create({
        data: {
          organizationId: old.organizationId,
          billingAccountId: old.billingAccountId,
          purchaseOrderId: old.purchaseOrderId,
          status: "ACTIVE",
          // The supersede action is the signing event for the new terms.
          signedAt: now,
          effectiveFrom,
          effectiveTo,
          paymentTermsDays: body.paymentTermsDays ?? old.paymentTermsDays,
          autoRenew: body.autoRenew ?? old.autoRenew,
          rateCardId:
            body.rateCardId !== undefined ? body.rateCardId : old.rateCardId,
        },
      });

      // #1132 follow-up — claim the old contract via CAS BEFORE re-pointing
      // programs. Two concurrent supersedes both passed the read-checks above
      // (READ COMMITTED) and minted duplicate ACTIVE successors with a
      // last-writer-wins supersession chain. Only one claim can win; the
      // loser throws and its transaction rolls back the successor it created
      // moments earlier.
      const claimedOld = await tx.contract.updateMany({
        where: {
          id: old.id,
          status: "ACTIVE",
          supersededByContractId: null,
        },
        data: {
          // AMENDMENT replaces a live term → TERMINATED; RENEWAL closes a
          // completed term → EXPIRED.
          status: body.reason === "AMENDMENT" ? "TERMINATED" : "EXPIRED",
          supersededByContractId: successor.id,
          supersededAt: now,
          supersessionReason: body.reason,
        },
      });
      if (claimedOld.count === 0) {
        throw Object.assign(
          new Error("Contract already superseded by a concurrent request"),
          { httpStatus: 409, code: "CONTRACT_ALREADY_SUPERSEDED" },
        );
      }

      // Re-point programs so entitlements continue under the new terms — and
      // so the cycle engine (which requires an ACTIVE contract) keeps rolling
      // their assignments. Invoices stay on the old contract.
      await tx.program.updateMany({
        where: { contractId: old.id },
        data: { contractId: successor.id },
      });

      await tx.orgAuditLog.create({
        data: {
          organizationId: orgId,
          actorMembershipId: access.member.id,
          category: "CONTRACT",
          action: AUDIT_ACTIONS.CONTRACT.CONTRACT_SUPERSEDED,
          description: `Contract ${old.id} superseded by ${successor.id} (${body.reason})`,
          details: {
            contractId: old.id,
            successorContractId: successor.id,
            reason: body.reason,
            effectiveFrom: effectiveFrom.toISOString(),
            effectiveTo: effectiveTo?.toISOString() ?? null,
          },
        },
      });

      return successor;
    });

    return NextResponse.json(
      { contract: result, supersededContractId: contractId },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof Error && "httpStatus" in err) {
      const status = typeof err.httpStatus === "number" ? err.httpStatus : 500;
      const code = "code" in err ? err.code : undefined;
      return NextResponse.json(
        { error: err.message, ...(code ? { code } : {}) },
        { status },
      );
    }
    Sentry.captureException(err instanceof Error ? err : new Error(String(err)), { tags: { subsystem: "enterprise" } });
    throw err;
  }
}
