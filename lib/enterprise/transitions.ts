import type { Tx } from "@/lib/prisma";
/**
 * Central guarded status transitions for every enterprise lifecycle enum —
 * the generalization of `lib/payments/billing/overage-transitions.ts`, which
 * stays the reference implementation for OverageChargeStatus (its richer
 * recovery edges are owned by the settlement call sites; see #812).
 *
 * The doctrine (docs/enterprise/70-design-decisions/13-postgres-native-concurrency.md):
 * the allowed-from set is baked into the UPDATE's WHERE clause, so an illegal
 * transition — terminal-state re-entry, a concurrent admin action landing
 * first, a stale tab — matches zero rows instead of corrupting state. The
 * WHERE clause is the state machine; app-level pre-checks are only friendly
 * error text. Postgres re-evaluates the predicate under the row lock, so two
 * racing transitions serialize and exactly one wins.
 *
 * Maps are keyed by TARGET state (same orientation as overage-transitions):
 * `ALLOWED_FROM[to]` lists the only states the row may currently be in.
 * Deliberately dependency-light (Prisma types only) so routes and jobs can
 * import it without dragging in heavy graphs.
 */
import type {
  AssignmentStatus,
  ContractStatus,
  MemberStatus,
  OrgAuditCategory,
  OrgInvoiceStatus,
  OrgPayoutAccountStatus,
  OrgStatus,
  PayoutStatus,
  PoStatus,
  Prisma,
  ProgramStatus,
} from "@prisma/client";

export interface IllegalTransitionContext {
  entityId?: string | null;
  from?: string | null;
}

export class IllegalTransitionError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "ILLEGAL_TRANSITION" as const;
  readonly entityId?: string;
  readonly from?: string;
  constructor(
    readonly entity: string,
    readonly to: string,
    context?: IllegalTransitionContext,
  ) {
    const fromClause =
      context?.from !== undefined ? ` (from ${context.from ?? "MISSING"})` : "";
    super(
      `${entity} cannot transition to ${to}${fromClause}: row missing, out of scope, or not in an allowed from-state`,
    );
    this.name = "IllegalTransitionError";
    if (context?.entityId) this.entityId = context.entityId;
    if (context?.from) this.from = context.from;
  }
}

/** In-tx OrgAuditLog row, written only after the CAS succeeds. */
interface AuditSpec {
  organizationId: string;
  actorMembershipId: string | null;
  /** The member the row is about, so it shows on their timeline. */
  targetMembershipId?: string | null;
  category: OrgAuditCategory;
  action: string;
  description: string;
  details?: Prisma.InputJsonValue;
}

interface TransitionArgs<S extends string, D> {
  /** id plus tenancy scope (e.g. organizationId) — the CAS guard is appended to this. */
  where: { id: string } & Record<string, unknown>;
  to: S;
  /** Extra columns stamped in the same UPDATE. */
  data?: D;
  audit?: AuditSpec;
}

// Shared post-CAS tail: throw on zero rows, then (and only then) audit.
// Cascades are NOT a hook — callers sequence them after the call in the same
// tx, which also lets cascade counts land in the audit details.
async function finalize(
  tx: Pick<Tx, "orgAuditLog">,
  entity: string,
  to: string,
  count: number,
  audit?: AuditSpec,
  entityId?: string,
): Promise<void> {
  if (count === 0) {
    throw new IllegalTransitionError(
      entity,
      to,
      entityId ? { entityId } : undefined,
    );
  }
  if (audit) await tx.orgAuditLog.create({ data: audit });
}

//////////////////////////////////////////////////// Organization ////////////////////////////////////////////////////

// REJECT is a sub-state stamp (verificationReason/-RejectedAt), not a status
// move — the org stays PENDING_VERIFICATION through the resubmit loop (#779 §A).
export const ORG_ALLOWED_FROM: Record<OrgStatus, OrgStatus[]> = {
  PENDING_VERIFICATION: [], // entry state only
  ACTIVE: ["PENDING_VERIFICATION", "SUSPENDED"],
  SUSPENDED: ["ACTIVE"],
  DEACTIVATED: ["PENDING_VERIFICATION", "ACTIVE", "SUSPENDED"],
};

export async function transitionOrganization(
  tx: Pick<Tx, "organization" | "orgAuditLog">,
  args: TransitionArgs<
    OrgStatus,
    Omit<Prisma.OrganizationUncheckedUpdateManyInput, "status" | "version">
  >,
): Promise<void> {
  const res = await tx.organization.updateMany({
    where: { ...args.where, status: { in: ORG_ALLOWED_FROM[args.to] } },
    data: { status: args.to, ...args.data },
  });
  await finalize(
    tx,
    "Organization",
    args.to,
    res.count,
    args.audit,
    args.where.id,
  );
}

//////////////////////////////////////////////////// Contract ////////////////////////////////////////////////////

// AMENDMENT/RENEWAL create successor rows (supersession chain) — terminal
// contracts are never mutated, so EXPIRED/TERMINATED have no outgoing edges.
export const CONTRACT_ALLOWED_FROM: Record<ContractStatus, ContractStatus[]> = {
  DRAFT: [],
  ACTIVE: ["DRAFT"],
  EXPIRED: ["ACTIVE"],
  TERMINATED: ["ACTIVE"],
};

export async function transitionContract(
  tx: Pick<Tx, "contract" | "orgAuditLog">,
  args: TransitionArgs<
    ContractStatus,
    Omit<Prisma.ContractUncheckedUpdateManyInput, "status">
  >,
): Promise<void> {
  const res = await tx.contract.updateMany({
    where: { ...args.where, status: { in: CONTRACT_ALLOWED_FROM[args.to] } },
    data: { status: args.to, ...args.data },
  });
  await finalize(tx, "Contract", args.to, res.count, args.audit, args.where.id);
}

//////////////////////////////////////////////////// Program ////////////////////////////////////////////////////

// Programs are created ACTIVE (no DRAFT). Cancelling must cascade
// assignments → CANCELLED in the same tx — sequence it after this call.
export const PROGRAM_ALLOWED_FROM: Record<ProgramStatus, ProgramStatus[]> = {
  ACTIVE: ["PAUSED"],
  PAUSED: ["ACTIVE"],
  EXPIRED: ["ACTIVE", "PAUSED"],
  CANCELLED: ["ACTIVE", "PAUSED"],
};

export async function transitionProgram(
  tx: Pick<Tx, "program" | "orgAuditLog">,
  args: TransitionArgs<
    ProgramStatus,
    Omit<Prisma.ProgramUncheckedUpdateManyInput, "status">
  >,
): Promise<void> {
  const res = await tx.program.updateMany({
    where: { ...args.where, status: { in: PROGRAM_ALLOWED_FROM[args.to] } },
    data: { status: args.to, ...args.data },
  });
  await finalize(tx, "Program", args.to, res.count, args.audit, args.where.id);
}

//////////////////////////////////////////////////// ProgramAssignment ////////////////////////////////////////////////////

// ROLLED only from ACTIVE — the cycle engine skips PAUSED assignments.
export const ASSIGNMENT_ALLOWED_FROM: Record<
  AssignmentStatus,
  AssignmentStatus[]
> = {
  ACTIVE: ["PAUSED"],
  ROLLED: ["ACTIVE"],
  PAUSED: ["ACTIVE"],
  CLOSED: ["ACTIVE", "PAUSED"],
  CANCELLED: ["ACTIVE", "PAUSED"],
};

//////////////////////////////////////////////////// Membership ////////////////////////////////////////////////////

// ERASED is the DPDP §12 tombstone — reachable from everything, including
// REMOVED. REMOVED leaves only to ERASED, or to ACTIVE when the person
// accepts a new invitation (#1846).
export const MEMBER_ALLOWED_FROM: Record<MemberStatus, MemberStatus[]> = {
  PENDING: [],
  ACTIVE: ["PENDING", "SUSPENDED", "REMOVED"],
  SUSPENDED: ["PENDING", "ACTIVE"],
  REMOVED: ["PENDING", "ACTIVE", "SUSPENDED"],
  ERASED: ["PENDING", "ACTIVE", "SUSPENDED", "REMOVED"],
};

export async function transitionMembership(
  tx: Pick<Tx, "membership" | "orgAuditLog">,
  args: TransitionArgs<
    MemberStatus,
    Omit<Prisma.MembershipUncheckedUpdateManyInput, "status">
  >,
): Promise<void> {
  const res = await tx.membership.updateMany({
    where: { ...args.where, status: { in: MEMBER_ALLOWED_FROM[args.to] } },
    data: { status: args.to, ...args.data },
  });
  await finalize(
    tx,
    "Membership",
    args.to,
    res.count,
    args.audit,
    args.where.id,
  );
}

//////////////////////////////////////////////////// OrganizationInvoice ////////////////////////////////////////////////////

// VOID is pre-payment cancellation of an issued invoice; REFUNDED is
// post-payment (see the OrgInvoiceStatus enum docstring). CANCELLED only
// kills DRAFTs that were never issued.
export const INVOICE_ALLOWED_FROM: Record<
  OrgInvoiceStatus,
  OrgInvoiceStatus[]
> = {
  DRAFT: [],
  ISSUED: ["DRAFT"],
  PAID: ["ISSUED", "OVERDUE"],
  OVERDUE: ["ISSUED"],
  VOID: ["ISSUED", "OVERDUE"],
  CANCELLED: ["DRAFT"],
  REFUNDED: ["PAID"],
};

export async function transitionOrgInvoice(
  tx: Pick<Tx, "organizationInvoice" | "orgAuditLog">,
  args: TransitionArgs<
    OrgInvoiceStatus,
    Omit<Prisma.OrganizationInvoiceUncheckedUpdateManyInput, "status">
  >,
): Promise<void> {
  const res = await tx.organizationInvoice.updateMany({
    where: { ...args.where, status: { in: INVOICE_ALLOWED_FROM[args.to] } },
    data: { status: args.to, ...args.data },
  });
  await finalize(
    tx,
    "OrganizationInvoice",
    args.to,
    res.count,
    args.audit,
    args.where.id,
  );
}

//////////////////////////////////////////////////// PurchaseOrder ////////////////////////////////////////////////////

export const PO_ALLOWED_FROM: Record<PoStatus, PoStatus[]> = {
  ACTIVE: [],
  CLOSED: ["ACTIVE"],
  CANCELLED: ["ACTIVE"],
};

export async function transitionPurchaseOrder(
  tx: Pick<Tx, "purchaseOrder" | "orgAuditLog">,
  args: TransitionArgs<
    PoStatus,
    Omit<Prisma.PurchaseOrderUncheckedUpdateManyInput, "status">
  >,
): Promise<void> {
  const res = await tx.purchaseOrder.updateMany({
    where: { ...args.where, status: { in: PO_ALLOWED_FROM[args.to] } },
    data: { status: args.to, ...args.data },
  });
  await finalize(
    tx,
    "PurchaseOrder",
    args.to,
    res.count,
    args.audit,
    args.where.id,
  );
}

//////////////////////////////////////////////////// OrganizationPayoutAccount ////////////////////////////////////////////////////

// Bank-detail changes reset to PENDING_VERIFICATION from any state (the
// payout-account PUT re-verifies new credentials), so nothing is terminal.
export const ORG_PAYOUT_ACCOUNT_ALLOWED_FROM: Record<
  OrgPayoutAccountStatus,
  OrgPayoutAccountStatus[]
> = {
  PENDING_VERIFICATION: ["VERIFIED", "FAILED_VERIFICATION", "SUSPENDED"],
  VERIFIED: ["PENDING_VERIFICATION", "SUSPENDED"],
  FAILED_VERIFICATION: ["PENDING_VERIFICATION"],
  SUSPENDED: ["VERIFIED"],
};

export async function transitionOrgPayoutAccount(
  tx: Pick<Tx, "organizationPayoutAccount" | "orgAuditLog">,
  args: TransitionArgs<
    OrgPayoutAccountStatus,
    Omit<
      Prisma.OrganizationPayoutAccountUncheckedUpdateManyInput,
      "status" | "version"
    >
  >,
): Promise<void> {
  const res = await tx.organizationPayoutAccount.updateMany({
    where: {
      ...args.where,
      status: { in: ORG_PAYOUT_ACCOUNT_ALLOWED_FROM[args.to] },
    },
    data: { status: args.to, ...args.data },
  });
  await finalize(
    tx,
    "OrganizationPayoutAccount",
    args.to,
    res.count,
    args.audit,
    args.where.id,
  );
}

//////////////////////////////////////////////////// OrganizationPayout ////////////////////////////////////////////////////

// REVERSED only from COMPLETED — bank returned funds after settlement (#812);
// the ledger reversal + earning re-open are sequenced by the payout service.
export const PAYOUT_ALLOWED_FROM: Record<PayoutStatus, PayoutStatus[]> = {
  PENDING: [],
  APPROVED: ["PENDING"],
  PROCESSING: ["APPROVED"],
  COMPLETED: ["PROCESSING"],
  FAILED: ["PROCESSING"],
  CANCELLED: ["PENDING"],
  REVERSED: ["COMPLETED"],
};

export async function transitionOrgPayout(
  tx: Pick<Tx, "organizationPayout" | "orgAuditLog">,
  args: TransitionArgs<
    PayoutStatus,
    Omit<Prisma.OrganizationPayoutUncheckedUpdateManyInput, "status">
  >,
): Promise<void> {
  const res = await tx.organizationPayout.updateMany({
    where: { ...args.where, status: { in: PAYOUT_ALLOWED_FROM[args.to] } },
    data: { status: args.to, ...args.data },
  });
  await finalize(
    tx,
    "OrganizationPayout",
    args.to,
    res.count,
    args.audit,
    args.where.id,
  );
}
