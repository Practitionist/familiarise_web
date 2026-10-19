import type { MemberRole, UserRole } from "@prisma/client";

/**
 * SCOPE × CAPABILITY.
 *
 * The two axes are orthogonal and the rule is one line:
 *
 *   an actor may perform a CAPABILITY on a case only if the matrix grants
 *   them that capability for the case's SCOPE, and the scope permits that
 *   tier to act on it. Scope never grants capability; capability never
 *   overrides scope.
 *
 * Why a scope axis rather than a role-per-case-type matrix: a refund
 * request can be raised by a consumer, by an org admin on behalf of a
 * member, or by a consultant against a no-show, and the same case type can
 * be about an org OR about an individual. A matrix keyed on (role × case
 * type) explodes; a matrix keyed on (scope × capability) does not, because
 * the scope is a property of the ROW, not of the user.
 *
 * The rule that carries the design: MONEY ACTS ARE PLATFORM-ONLY AT EVERY
 * SCOPE. An organisation's own money sits in the PLATFORM's escrow (the
 * ledger splits CASH against CONSULTANT_PAYABLE), so an org admin is not the
 * holder of the funds it would be releasing. An org may decide its own
 * service quality, respond as the counterparty, and REQUEST a refund; it
 * may never EXECUTE one. `refunds.manage` is a `BackofficeSurface` and is
 * therefore structurally unreachable by any `Membership.role` — the
 * separation falls out of the existing two-matrix design rather than being
 * a special case bolted on.
 */

export type CaseScope =
  /** One person's case, no organisation involved. */
  | "individual"
  /** An organisation's own service quality: no money, no counterparty. */
  | "org"
  /** The platform's escrow or the ledger is at stake. */
  | "platform-money"
  /** Two organisations are counterparties. */
  | "counterparty-org";

/**
 * What an actor is trying to do. `execute` is the only one that moves money
 * or state irreversibly, and it is the one the platform keeps.
 */
export type CaseCapability =
  /** See the case. */
  | "read"
  /** Take it, gather context, comment internally. */
  | "investigate"
  /** Propose or record a resolution. */
  | "decide"
  /** Commit money or an irreversible state. */
  | "execute";

export interface CaseActor {
  userId: string;
  /** The platform role (`UserRole`). */
  role: UserRole;
  /** The organisation role, when the actor is an organisation member. */
  orgRole?: MemberRole | null;
  /** The organisation the actor is acting within. */
  organizationId?: string | null;
}

/**
 * Which scope a dispute sits in, from the payment's two organisation links.
 *
 * The order matters. Two organisations on the same payment are counterparties
 * and a third party must decide; an organisation on ONE side means the
 * platform is holding the money, and the platform's own escrow is what is at
 * stake; neither means it is a personal payment, and the platform's escrow
 * holds it.
 */
export function disputeScope(payment: {
  organizationId: string | null;
  hostOrganizationId: string | null;
}): CaseScope {
  const buyer = payment.organizationId;
  const host = payment.hostOrganizationId;
  if (buyer && host && buyer !== host) return "counterparty-org";
  if (buyer || host) return "platform-money";
  return "platform-money";
}

/** The scope a case (not a dispute) sits in, from the case's own links. */
export function supportCaseScope(supportCase: {
  organizationId: string | null;
}): CaseScope {
  return supportCase.organizationId ? "org" : "individual";
}

const PLATFORM_STAFF: ReadonlySet<UserRole> = new Set(["STAFF", "ADMIN"]);
const PLATFORM_ADMIN: ReadonlySet<UserRole> = new Set(["ADMIN"]);

const ORG_GOVERNANCE: ReadonlySet<MemberRole> = new Set([
  "OWNER",
  "MAINTAINER",
]);

/**
 * What each tier may do at each scope.
 *
 * `R` read · `I` investigate · `D` decide (record a resolution) ·
 * `X` execute (commit money or an irreversible state).
 *
 * Two things this table is NOT:
 *   - it is not the permission matrix. WHICH ACT an operator may perform is
 *     `BACKOFFICE_PERMISSIONS` (or `ORG_PERMISSIONS`), checked at the route.
 *     This table answers the orthogonal question: given the case is about
 *     THIS, may a person at your level act on it AT ALL.
 *   - it is not a substitute for the row filter. WHICH CASES a person may
 *     see is a `where` clause; this table says what they may do with the
 *     ones they can see.
 *
 * The rule the table encodes: `execute` — money, or an irreversible state —
 * is PLATFORM-ONLY AT EVERY SCOPE. An organisation may decide its own
 * service quality, respond as the counterparty, and request a refund; it may
 * never release a rupee.
 */
const SCOPE_MATRIX: Record<
  CaseScope,
  {
    platformStaff: ReadonlySet<CaseCapability>;
    platformAdmin: ReadonlySet<CaseCapability>;
    orgAdmin: ReadonlySet<CaseCapability>;
    orgMember: ReadonlySet<CaseCapability>;
  }
> = {
  // An organisation's own service quality. Its admins may decide it, and
  // nobody outside can — the platform has no standing to rule on how an org
  // treats its own people.
  org: {
    platformStaff: new Set(["read", "investigate", "decide"]),
    platformAdmin: new Set(["read", "investigate", "decide", "execute"]),
    orgAdmin: new Set(["read", "investigate", "decide"]),
    orgMember: new Set(["read"]),
  },
  // One person's case. There is no second party with standing, so the
  // platform decides — and an organisation has no standing on an unrelated
  // individual's case at all.
  individual: {
    platformStaff: new Set(["read", "investigate", "decide"]),
    platformAdmin: new Set(["read", "investigate", "decide", "execute"]),
    orgAdmin: new Set(),
    orgMember: new Set(),
  },
  // The platform's escrow is at stake. Organisations may READ — they are
  // entitled to see what happened to their money — and nothing more. The
  // platform's MONEY VERDICT on such a case is the `disputes.decide`
  // surface, which is ADMIN only.
  "platform-money": {
    platformStaff: new Set(["read", "investigate", "decide"]),
    platformAdmin: new Set(["read", "investigate", "decide", "execute"]),
    orgAdmin: new Set(["read"]),
    orgMember: new Set(),
  },
  // Two organisations are counterparties. Neither may decide; a third party
  // must. This is the anti-pattern guard: the party that benefits from the
  // outcome must never be the one that decides it.
  "counterparty-org": {
    platformStaff: new Set(["read", "investigate", "decide"]),
    platformAdmin: new Set(["read", "investigate", "decide", "execute"]),
    orgAdmin: new Set(["read"]),
    orgMember: new Set(),
  },
};

/**
 * May this actor perform this capability on a case in this scope?
 *
 * The scope permits a TIER to act; the matrix says what that tier may do.
 * A platform operator's own permissions (`BACKOFFICE_PERMISSIONS`) are
 * checked separately at the route — this function answers the orthogonal
 * question, "given the case is about THIS, may a person at your level act
 * on it at all?".
 */
export function canActOnCase(
  actor: CaseActor,
  scope: CaseScope,
  capability: CaseCapability,
): boolean {
  // The lookup is by the ACTOR's effective scope, not the case's: an
  // organisation member's scope is their own organisation's, so a case at
  // another scope resolves to a row that refuses them.
  const row = SCOPE_MATRIX[actorScope(actor, scope)];

  if (PLATFORM_ADMIN.has(actor.role)) {
    return row.platformAdmin.has(capability);
  }
  if (PLATFORM_STAFF.has(actor.role)) {
    return row.platformStaff.has(capability);
  }

  // An organisation member. Their scope is their OWN organisation's, and
  // only within it.
  if (actor.orgRole && actor.organizationId) {
    if (ORG_GOVERNANCE.has(actor.orgRole)) {
      return row.orgAdmin.has(capability);
    }
    return row.orgMember.has(capability);
  }
  return false;
}

/**
 * The scope of a case as it concerns a SPECIFIC actor: an organisation
 * member's own organisation is their scope, and a platform operator's scope
 * is always the platform's.
 */
export function actorScope(
  actor: CaseActor,
  caseScope: CaseScope,
): CaseScope {
  // A platform operator acts at the platform's authority, so their scope IS
  // the case's scope. The matrix's platform rows differ per scope, and
  // collapsing them would strip the staff tier's ability to resolve a case
  // that is not about money.
  if (PLATFORM_STAFF.has(actor.role)) return caseScope;
  if (actor.orgRole && actor.organizationId) {
    // An organisation member acts within their own organisation's scope. A
    // case at a different scope (another org, or platform money) is outside
    // it, and the matrix refuses them.
    return caseScope === "org" ? "org" : caseScope;
  }
  return caseScope;
}
