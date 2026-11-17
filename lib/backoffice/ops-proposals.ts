/**
 * Second-admin approval (F10): a money door moving more than ₹25,000 while two or
 * more ADMINs are active is held as a PROPOSED row until a different ADMIN approves
 * it; the approval replays the stored body through the same door as the approver.
 */

import type { OpsActionProposalStatus, Prisma } from "@prisma/client";

import prisma, { type Tx } from "@/lib/prisma";
import type { ProposalPage } from "./money-list-schemas";
import { OpsRefusal } from "./ops-refusal-error";
import { resolveTargets, targetKey } from "./target-refs";

export const SECOND_APPROVAL_THRESHOLD_PAISE = 2_500_000;
export const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;

/** Active ADMINs, counted as the fee-schedule approval counts them. */
export function countActiveAdmins(db: Pick<Tx, "user">): Promise<number> {
  return db.user.count({ where: { role: "ADMIN", banned: false } });
}

/** True when the amount needs a second ADMIN; a NaN amount fails closed. */
export async function requiresSecondApprover(
  db: Pick<Tx, "user">,
  amountPaise: number,
): Promise<boolean> {
  if (amountPaise <= SECOND_APPROVAL_THRESHOLD_PAISE) return false;
  return (await countActiveAdmins(db)) >= 2;
}

export interface OpenProposalInput {
  action: string;
  route: string;
  target: { kind: string; id: string };
  amountPaise: number;
  requestBody: Prisma.InputJsonValue;
  routeParams: Record<string, string>;
  proposedById: string;
  reason: string;
  now: Date;
}

/** Opens the one PROPOSED row for this (action, target); the sidecar index refuses a second. */
export async function openProposal(
  tx: Tx,
  input: OpenProposalInput,
): Promise<{ id: string; expiresAt: Date }> {
  const key = {
    action: input.action,
    targetKind: input.target.kind,
    targetId: input.target.id,
  };
  // An expired PROPOSED row would otherwise hold the one open slot forever.
  await tx.opsActionProposal.updateMany({
    where: { ...key, status: "PROPOSED", expiresAt: { lte: input.now } },
    data: { status: "EXPIRED" },
  });
  return tx.opsActionProposal.create({
    data: {
      ...key,
      surface: input.route,
      amountPaise: Number.isFinite(input.amountPaise)
        ? BigInt(Math.trunc(input.amountPaise))
        : null,
      requestBody: input.requestBody,
      routeParams: input.routeParams,
      proposedById: input.proposedById,
      reason: input.reason,
      expiresAt: new Date(input.now.getTime() + PROPOSAL_TTL_MS),
    },
    select: { id: true, expiresAt: true },
  });
}

export const PROPOSAL_SELECT = {
  id: true,
  action: true,
  surface: true,
  targetKind: true,
  targetId: true,
  requestBody: true,
  routeParams: true,
  proposedById: true,
  status: true,
  expiresAt: true,
} as const;

export type ClaimedProposal = Prisma.OpsActionProposalGetPayload<{
  select: typeof PROPOSAL_SELECT;
}>;

/**
 * CASes a live PROPOSED row to APPROVED or REJECTED. Only a different ADMIN may
 * approve; the proposer may withdraw (reject) their own.
 */
export async function decideProposal(
  tx: Tx,
  input: {
    id: string;
    deciderId: string;
    decision: "APPROVED" | "REJECTED";
    reason: string;
    now: Date;
  },
): Promise<ClaimedProposal> {
  const row = await tx.opsActionProposal.findUnique({
    where: { id: input.id },
    select: PROPOSAL_SELECT,
  });
  if (!row) {
    throw new OpsRefusal("NOT_FOUND", "Proposal not found.", 404);
  }
  if (row.status !== "PROPOSED") {
    throw new OpsRefusal(
      "PROPOSAL_DECIDED",
      `This proposal is already ${row.status.toLowerCase()}.`,
    );
  }
  if (row.expiresAt <= input.now) {
    throw new OpsRefusal(
      "PROPOSAL_EXPIRED",
      "This proposal expired after 24 hours; propose the action again.",
    );
  }
  const approving = input.decision === "APPROVED";
  if (approving && row.proposedById === input.deciderId) {
    throw new OpsRefusal(
      "SAME_ADMIN",
      "A different admin must approve an action you proposed.",
      403,
    );
  }
  const claimed = await tx.opsActionProposal.updateMany({
    where: {
      id: row.id,
      status: "PROPOSED",
      expiresAt: { gt: input.now },
      // A deleted proposer (NULL) is never the decider; `not` alone would skip NULL.
      ...(approving && {
        OR: [
          { proposedById: null },
          { proposedById: { not: input.deciderId } },
        ],
      }),
    },
    data: {
      status: input.decision,
      decidedById: input.deciderId,
      decidedAt: input.now,
      decisionReason: input.reason,
    },
  });
  if (claimed.count !== 1) {
    throw new OpsRefusal(
      "PROPOSAL_DECIDED",
      "Another admin decided this proposal first.",
    );
  }
  return { ...row, status: input.decision };
}

/** APPROVED → EXECUTED with the replay's audit row; 0 means it was not APPROVED. */
export async function markProposalExecuted(
  db: Pick<Tx, "opsActionProposal">,
  id: string,
  opsActionLogId: string,
): Promise<number> {
  const marked = await db.opsActionProposal.updateMany({
    where: { id, status: "APPROVED" },
    data: { status: "EXECUTED", executedOpsActionLogId: opsActionLogId },
  });
  return marked.count;
}

/** A replay that failed leaves the row APPROVED, carrying the refusal. */
export async function noteProposalFailure(
  id: string,
  reason: string,
  code: string,
): Promise<void> {
  await prisma.opsActionProposal.updateMany({
    where: { id, status: "APPROVED" },
    data: { decisionReason: `${reason} — execution failed: ${code}` },
  });
}

/** The status an operator sees: a PROPOSED row past its expiry reads EXPIRED. */
export function effectiveProposalStatus(
  row: { status: OpsActionProposalStatus; expiresAt: Date },
  now: Date,
): OpsActionProposalStatus {
  return row.status === "PROPOSED" && row.expiresAt <= now
    ? "EXPIRED"
    : row.status;
}

/** The list filter for an effective status, so expiry needs no sweep. */
export function proposalStatusWhere(
  status: OpsActionProposalStatus,
  now: Date,
): Prisma.OpsActionProposalWhereInput {
  if (status === "PROPOSED") {
    return { status: "PROPOSED", expiresAt: { gt: now } };
  }
  if (status === "EXPIRED") {
    return {
      OR: [
        { status: "EXPIRED" },
        { status: "PROPOSED", expiresAt: { lte: now } },
      ],
    };
  }
  return { status };
}

export const PROPOSAL_PAGE_SIZE = 20;

/** One page of proposals in one effective status, newest first, each naming its target. */
export async function listProposals(
  status: OpsActionProposalStatus,
  now: Date,
  page = 1,
): Promise<ProposalPage> {
  const where = proposalStatusWhere(status, now);
  const [rows, total] = await Promise.all([
    prisma.opsActionProposal.findMany({
      relationLoadStrategy: "join",
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      skip: (page - 1) * PROPOSAL_PAGE_SIZE,
      take: PROPOSAL_PAGE_SIZE,
      select: {
        id: true,
        action: true,
        surface: true,
        targetKind: true,
        targetId: true,
        amountPaise: true,
        reason: true,
        status: true,
        decidedAt: true,
        decisionReason: true,
        expiresAt: true,
        createdAt: true,
        proposedBy: { select: { id: true, name: true } },
        decidedBy: { select: { id: true, name: true } },
      },
    }),
    prisma.opsActionProposal.count({ where }),
  ]);
  const targets = await resolveTargets(
    rows.map((r) => ({ kind: r.targetKind, id: r.targetId })),
  );
  return {
    proposals: rows.map((r) => ({
      ...r,
      amountPaise: r.amountPaise === null ? null : Number(r.amountPaise),
      target: targets.get(targetKey(r.targetKind, r.targetId)) ?? null,
      status: effectiveProposalStatus(r, now),
      decidedAt: r.decidedAt?.toISOString() ?? null,
      expiresAt: r.expiresAt.toISOString(),
      createdAt: r.createdAt.toISOString(),
    })),
    total,
    page,
    pageSize: PROPOSAL_PAGE_SIZE,
  };
}
