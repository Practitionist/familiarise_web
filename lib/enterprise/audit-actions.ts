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
    // Emitted by the stale-invitation cleanup cron when a PENDING invite
    // ages past the 14-day window and is auto-expired. Keeps an audit row
    // so MAINTAINERs can see "this invite lapsed" without needing to tail
    // worker logs.
    INVITE_EXPIRED: "INVITE_EXPIRED",
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
    // Emitted by the consolidated-invoice rollup cron when a parent org
    // rolls up its child orgs' unpaid invoices into a single parent
    // invoice. `details.childInvoiceIds` carries the rolled-up rows for
    // audit-trail chain-of-custody.
    INVOICE_ROLLED_UP: "INVOICE_ROLLED_UP",
  },
  PAYOUT: {
    PAYOUT_INITIATED: "PAYOUT_INITIATED",
    PAYOUT_PROCESSED: "PAYOUT_PROCESSED",
    PAYOUT_COMPLETED: "PAYOUT_COMPLETED",
    PAYOUT_CANCELLED: "PAYOUT_CANCELLED",
    PAYOUT_FAILED: "PAYOUT_FAILED",
    EARNINGS_HELD: "EARNINGS_HELD",
    EARNINGS_RELEASED: "EARNINGS_RELEASED",
    /// Emitted by `applyRefundCascade` when a refund hits an
    /// OrganizationEarnings row whose linked OrganizationPayout has
    /// already COMPLETED (the bank transfer left). Increments
    /// `OrganizationPayout.clawbackAmountPaise` and stamps
    /// `clawbackInitiatedAt` (idempotent — only set when null) so an
    /// admin can chase the org for the over-paid amount. Manual
    /// recovery only in v1.
    PAYOUT_CLAWBACK: "PAYOUT_CLAWBACK",
    /// A1+A8: emitted when a `payout.reversed` webhook arrives — the
    /// bank rejected the transfer after we successfully submitted it.
    /// Distinct from PAYOUT_FAILED (gateway-time rejection) and from
    /// PAYOUT_CLAWBACK (post-completion refund). Releases earnings to
    /// READY for the next batch.
    PAYOUT_REVERSED: "PAYOUT_REVERSED",
  },
  SETTINGS: {
    SETTINGS_CHANGED: "SETTINGS_CHANGED",
    SSO_ENABLED: "SSO_ENABLED",
    SSO_DISABLED: "SSO_DISABLED",
    DOMAIN_CLAIMED: "DOMAIN_CLAIMED",
    // Emitted by POST /organizations/[orgId]/domain-claims/[domain]/verify
    // after the DNS TXT record at `_familiarise-verify.<domain>` matches
    // the claim's verificationToken. `verifiedAt` on the row flips from
    // NULL → now(), unlocking domain-based auto-join for SSO.
    DOMAIN_VERIFIED: "DOMAIN_VERIFIED",
    // Emitted by GET /api/organizations/[orgId]/audit/export (the CSV
    // exporter is itself auditable — a compliance review asking "who
    // pulled our audit trail and when?" needs an answer). `details`
    // carries the filter params + row-count as evidence.
    AUDIT_LOG_EXPORTED: "AUDIT_LOG_EXPORTED",
    DOMAIN_RELEASED: "DOMAIN_RELEASED",
    // Emitted by the SSO cert expiry cron at 30-day WARN and 7-day
    // CRITICAL thresholds. `details.daysRemaining` + `details.providerId`
    // carry the context so an OWNER scanning the audit log can tell which
    // provider's cert is about to lapse.
    SSO_CERT_EXPIRING: "SSO_CERT_EXPIRING",
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
