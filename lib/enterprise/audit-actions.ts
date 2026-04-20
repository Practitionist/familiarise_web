/**
 * Well-known OrgAuditLog.action strings grouped by category.
 *
 * The DB stores `action` as a free-form `String` so new events can be
 * emitted without a migration. This file is the IDE-facing source of
 * truth: callers import a constant to get autocomplete + typo safety
 * without the schema having to enumerate every possible event.
 *
 * Adding a new event: just add a string literal here. Anything unknown
 * at write time still persists — this collection is a convention, not a
 * constraint.
 *
 * NB: `CONSULTANT_APPLIED / CONSULTANT_APPROVED / CONSULTANT_REJECTED`
 * and their EXPERT_* aliases were purged in the Arch-4 terminology
 * migration. Do not re-add; EXPERT membership is invite-driven (see
 * docs/enterprise/06-expert-lifecycle.md) and the dead `OrgAuditAction`
 * enum was dropped from the Prisma schema at the same time.
 */

import type { OrgAuditCategory } from "@prisma/client";

export const AUDIT_ACTIONS = {
  MEMBER: {
    MEMBER_ADDED: "MEMBER_ADDED",
    MEMBER_REACTIVATED: "MEMBER_REACTIVATED",
    MEMBER_REMOVED: "MEMBER_REMOVED",
    ROLE_CHANGE: "ROLE_CHANGE",
    STATUS_CHANGE: "STATUS_CHANGE",
    INVITE_SENT: "INVITE_SENT",
    INVITE_RESENT: "INVITE_RESENT",
    INVITE_ACCEPTED: "INVITE_ACCEPTED",
    INVITE_REVOKED: "INVITE_REVOKED",
  },
  CONTRACT: {
    CONTRACT_CREATED: "CONTRACT_CREATED",
    CONTRACT_SIGNED: "CONTRACT_SIGNED",
    CONTRACT_TERMINATED: "CONTRACT_TERMINATED",
    CONTRACT_EXPIRED: "CONTRACT_EXPIRED",
  },
  PROGRAM: {
    PROGRAM_CREATED: "PROGRAM_CREATED",
    PROGRAM_PAUSED: "PROGRAM_PAUSED",
    PROGRAM_ASSIGNED: "PROGRAM_ASSIGNED",
    PROGRAM_ASSIGNMENT_UPDATED: "PROGRAM_ASSIGNMENT_UPDATED",
    PROGRAM_UNASSIGNED: "PROGRAM_UNASSIGNED",
    RATE_CARD_BUMPED: "RATE_CARD_BUMPED",
  },
  WALLET: {
    WALLET_TOPUP: "WALLET_TOPUP",
    WALLET_TOPUP_CONFIRMED: "WALLET_TOPUP_CONFIRMED",
    WALLET_REFUND: "WALLET_REFUND",
    WALLET_DEBIT_FAILED: "WALLET_DEBIT_FAILED",
  },
  INVOICE: {
    PURCHASE_ORDER_CREATED: "PURCHASE_ORDER_CREATED",
    INVOICE_GENERATED: "INVOICE_GENERATED",
    INVOICE_ISSUED: "INVOICE_ISSUED",
    INVOICE_PAYMENT_INITIATED: "INVOICE_PAYMENT_INITIATED",
    INVOICE_PAID: "INVOICE_PAID",
    INVOICE_CANCELLED: "INVOICE_CANCELLED",
    INVOICE_VOIDED: "INVOICE_VOIDED",
    INVOICE_REFUNDED: "INVOICE_REFUNDED",
    REFUND_DENIED: "REFUND_DENIED",
  },
  PAYOUT: {
    PAYOUT_INITIATED: "PAYOUT_INITIATED",
    PAYOUT_PROCESSED: "PAYOUT_PROCESSED",
    PAYOUT_CANCELLED: "PAYOUT_CANCELLED",
    PAYOUT_FAILED: "PAYOUT_FAILED",
    EARNINGS_HELD: "EARNINGS_HELD",
    EARNINGS_RELEASED: "EARNINGS_RELEASED",
  },
  SETTINGS: {
    SETTINGS_CHANGED: "SETTINGS_CHANGED",
    SSO_ENABLED: "SSO_ENABLED",
    SSO_DISABLED: "SSO_DISABLED",
    DOMAIN_CLAIMED: "DOMAIN_CLAIMED",
    DOMAIN_RELEASED: "DOMAIN_RELEASED",
  },
  CONSENT: {
    CONSENT_GRANTED: "CONSENT_GRANTED",
    CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN",
    DATA_BREACH_REPORTED: "DATA_BREACH_REPORTED",
  },
  CATALOG: {
    // Emitted from POST /api/organizations/[orgId]/catalog when an OWNER
    // adds an OrganizationPlan to the sponsored catalog.
    CATALOG_PLAN_CREATED: "CATALOG_PLAN_CREATED",
    // Emitted from DELETE /api/organizations/[orgId]/catalog bulk
    // deactivate (isActive=false). Kept as a single audit row per call,
    // with the affected planIds surfaced via `details`.
    CATALOG_PLAN_DEACTIVATED: "CATALOG_PLAN_DEACTIVATED",
  },
  SYSTEM: {
    VERIFIED: "VERIFIED",
    SUSPENDED: "SUSPENDED",
    REACTIVATED: "REACTIVATED",
    DEACTIVATED: "DEACTIVATED",
    HRIS_SYNC_STARTED: "HRIS_SYNC_STARTED",
    HRIS_SYNC_COMPLETED: "HRIS_SYNC_COMPLETED",
    // Logged from the HRIS sync pipeline when a provider call throws or
    // returns a non-success response. Keeps the failure visible on the
    // org audit log so MANAGERs can see "we tried, here's why it didn't
    // land" without having to SSH into worker logs.
    HRIS_SYNC_FAILED: "HRIS_SYNC_FAILED",
    // Emitted by DELETE /api/organizations/[orgId] when an OWNER tears
    // an org down. Kept inside SYSTEM so the audit row outlives the
    // org itself (soft-deleted targetMembershipId) and is still
    // auditable post-deletion.
    ORG_DELETED: "ORG_DELETED",
  },
} as const satisfies Record<OrgAuditCategory, Record<string, string>>;

export type AuditCategory = keyof typeof AUDIT_ACTIONS;
export type AuditAction<C extends AuditCategory> =
  (typeof AUDIT_ACTIONS)[C][keyof (typeof AUDIT_ACTIONS)[C]];
