/**
 * #777 §B (locked decision: "edit safe fields, lock money config once in use").
 *
 * Pure predicates that derive whether a program/contract's MONEY config is
 * locked — without a `configLockedAt` column (that explicit field + the
 * "applies-next-cycle" cycle engine are #779 §A/§B, deferred to v4). The rule:
 *   - money config is editable while NOTHING is riding on it (no assignments,
 *     bookings, or overage events) — fixing a typo on a brand-new program is safe;
 *   - it locks read-only the moment it's in use, because a retroactive money edit
 *     would rewrite bookings already settled at the old terms (#779's hazard).
 * Safe identity fields (program name; contract auto-renew) stay editable always.
 */
import prisma from "@/lib/prisma";
import type { ContractStatus } from "@prisma/client";

/** Program money fields that lock once the program is in use. */
export const LOCKED_PROGRAM_FIELDS = [
  "type",
  "coveredPlanTypes",
  "ratePerSeatPaise",
  "coveredEngagementsPerCycle",
  "creditsPerCycle",
  "overageBehavior",
  "overageSurchargeBps",
  "priceCapPerEngagementPaise",
  "maxOveragePerCyclePaise",
] as const;

/** Contract money/term fields that lock once the contract is in use. */
export const LOCKED_CONTRACT_FIELDS = [
  "billingAccountId",
  "effectiveFrom",
  "effectiveTo",
  "paymentTermsDays",
  "rateCardId",
] as const;

export interface ProgramLockSignals {
  assignmentCount: number;
  bookingCount: number;
  overageEventCount: number;
}

/** A program's money config is locked once anything rides on it. */
export function isProgramMoneyConfigLocked(s: ProgramLockSignals): boolean {
  return (
    s.assignmentCount > 0 || s.bookingCount > 0 || s.overageEventCount > 0
  );
}

export interface ContractLockSignals {
  status: ContractStatus;
  invoiceCount: number;
  liveAssignmentCount: number;
}

/**
 * A contract's terms lock once it leaves DRAFT (signed = committed terms) or
 * once any invoice is issued / any program under it has live assignments.
 */
export function isContractTermsLocked(s: ContractLockSignals): boolean {
  return (
    s.status !== "DRAFT" || s.invoiceCount > 0 || s.liveAssignmentCount > 0
  );
}

/** Resolve the in-use signals for one program (bounded count queries). */
export async function getProgramLockState(
  programId: string,
): Promise<{ locked: boolean; signals: ProgramLockSignals }> {
  const [assignmentCount, bookingCount, overageEventCount] = await Promise.all([
    prisma.programAssignment.count({ where: { programId } }),
    prisma.bookingUtilization.count({
      where: { programAssignment: { programId } },
    }),
    prisma.overageEvent.count({
      where: { programAssignment: { programId } },
    }),
  ]);
  const signals = { assignmentCount, bookingCount, overageEventCount };
  return { locked: isProgramMoneyConfigLocked(signals), signals };
}

/** Resolve the in-use signals for one contract. */
export async function getContractLockState(
  contractId: string,
  status: ContractStatus,
): Promise<{ locked: boolean; signals: ContractLockSignals }> {
  const [invoiceCount, liveAssignmentCount] = await Promise.all([
    prisma.organizationInvoice.count({ where: { contractId } }),
    prisma.programAssignment.count({
      where: { program: { contractId }, periodEnd: { gte: new Date() } },
    }),
  ]);
  const signals = { status, invoiceCount, liveAssignmentCount };
  return { locked: isContractTermsLocked(signals), signals };
}
