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
 * docs/enterprise/30-programs-and-lifecycle/03-expert-lifecycle.md) and the dead `OrgAuditAction`
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
    // #1851 decision 2 — an operator acted on a member's org-funded booking
    // ("Acting for <Org>"). MEMBER, not a new category: the booking is the
    // member's record, and a category is an enum change.
    APPOINTMENT_CANCELLED_FOR_ORG: "APPOINTMENT_CANCELLED_FOR_ORG",
    APPOINTMENT_RESCHEDULE_REQUESTED_FOR_ORG:
      "APPOINTMENT_RESCHEDULE_REQUESTED_FOR_ORG",
    APPOINTMENT_ALLOCATED_FOR_ORG: "APPOINTMENT_ALLOCATED_FOR_ORG",
  },
  CONTRACT: {
    CONTRACT_CREATED: "CONTRACT_CREATED",
    CONTRACT_SIGNED: "CONTRACT_SIGNED",
    CONTRACT_TERMINATED: "CONTRACT_TERMINATED",
    CONTRACT_EXPIRED: "CONTRACT_EXPIRED",
    // #779 — amend/renew/supersede + auto-renew cron.
    CONTRACT_SUPERSEDED: "CONTRACT_SUPERSEDED",
    CONTRACT_AUTO_RENEWED: "CONTRACT_AUTO_RENEWED",
  },
  PROGRAM: {
    PROGRAM_CREATED: "PROGRAM_CREATED",
    PROGRAM_PAUSED: "PROGRAM_PAUSED",
    // Lifecycle actions for the remaining ProgramStatus edges — the PATCH
    // route previously fell back to PROGRAM_CREATED for resume/cancel/expire,
    // which corrupted the timeline signal.
    PROGRAM_RESUMED: "PROGRAM_RESUMED",
    PROGRAM_CANCELLED: "PROGRAM_CANCELLED",
    PROGRAM_EXPIRED: "PROGRAM_EXPIRED",
    // #779 — cycle engine rolled an assignment to its next period.
    PROGRAM_ASSIGNMENT_ROLLED: "PROGRAM_ASSIGNMENT_ROLLED",
    // #777 §B — archive/unarchive (soft-hide; financial history preserved).
    PROGRAM_ARCHIVED: "PROGRAM_ARCHIVED",
    // DELETE /api/organizations/[orgId]/programs/[programId] previously
    // reused PROGRAM_PAUSED which conflated delete with the pause/resume
    // status transition for audit consumers. Distinct action gives the
    // audit-log reader a clean signal for permanent removal.
    PROGRAM_DELETED: "PROGRAM_DELETED",
    PROGRAM_ASSIGNED: "PROGRAM_ASSIGNED",
    PROGRAM_ASSIGNMENT_UPDATED: "PROGRAM_ASSIGNMENT_UPDATED",
    PROGRAM_UNASSIGNED: "PROGRAM_UNASSIGNED",
    // #1846 SM-C14 — one row per seat a terminated or expired contract closed.
    ASSIGNMENT_CLOSED_BY_CONTRACT: "ASSIGNMENT_CLOSED_BY_CONTRACT",
    RATE_CARD_BUMPED: "RATE_CARD_BUMPED",
    PROGRAM_SUPERSEDED: "PROGRAM_SUPERSEDED",
  },
  WALLET: {
    WALLET_TOPUP: "WALLET_TOPUP",
    WALLET_TOPUP_CONFIRMED: "WALLET_TOPUP_CONFIRMED",
    WALLET_REFUND: "WALLET_REFUND",
    WALLET_DEBIT_FAILED: "WALLET_DEBIT_FAILED",
  },
  INVOICE: {
    PURCHASE_ORDER_CREATED: "PURCHASE_ORDER_CREATED",
    // PO lifecycle — the PATCH route previously wrote no audit row at all.
    PURCHASE_ORDER_CLOSED: "PURCHASE_ORDER_CLOSED",
    PURCHASE_ORDER_CANCELLED: "PURCHASE_ORDER_CANCELLED",
    // #1851 decision 7 — BILLING_ADMIN keeps full billing control, audited:
    // PO amounts and dates, PO hard delete, the funding-source switch, other
    // billing-account money settings, and invoice due date / PDF edits.
    PURCHASE_ORDER_UPDATED: "PURCHASE_ORDER_UPDATED",
    PURCHASE_ORDER_DELETED: "PURCHASE_ORDER_DELETED",
    FUNDING_SOURCE_CHANGED: "FUNDING_SOURCE_CHANGED",
    BILLING_ACCOUNT_UPDATED: "BILLING_ACCOUNT_UPDATED",
    INVOICE_UPDATED: "INVOICE_UPDATED",
    // #1851 — the reimbursements CSV self-audits like the invoice register.
    REIMBURSEMENTS_EXPORTED: "REIMBURSEMENTS_EXPORTED",
    INVOICE_GENERATED: "INVOICE_GENERATED",
    INVOICE_ISSUED: "INVOICE_ISSUED",
    // #1230 wave-4 — the CSV export self-audits like the audit-log exporter.
    INVOICE_EXPORTED: "INVOICE_EXPORTED",
    // #779 — dunning cron flipped ISSUED → OVERDUE.
    INVOICE_OVERDUE: "INVOICE_OVERDUE",
    // #812 — dunning Stage 3 stamped dunningSuspendedAt; the org's sponsored
    // bookings are gated until the invoice is paid (config-gated cascade).
    INVOICE_DUNNING_SUSPENDED: "INVOICE_DUNNING_SUSPENDED",
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
    // #1230 wave-4 — the CSV export self-audits like the audit-log exporter.
    PAYOUT_EXPORTED: "PAYOUT_EXPORTED",
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
    // #1584 P1-AU01 — payout-account create/update and a manual status
    // override used to hide behind SETTINGS_CHANGED and PAYOUT_INITIATED.
    PAYOUT_ACCOUNT_CREATED: "PAYOUT_ACCOUNT_CREATED",
    PAYOUT_ACCOUNT_UPDATED: "PAYOUT_ACCOUNT_UPDATED",
    PAYOUT_STATUS_OVERRIDDEN: "PAYOUT_STATUS_OVERRIDDEN",
    // #1851 decision 5 — where an EXPERT's org share is paid changed.
    PAYOUT_RECIPIENT_CHANGED: "PAYOUT_RECIPIENT_CHANGED",
  },
  SETTINGS: {
    SETTINGS_CHANGED: "SETTINGS_CHANGED",
    // #781 §B — org with financial history is soft-deleted (DEACTIVATED +
    // deletedAt + contact-PII scrub), never hard-deleted.
    ORG_SOFT_DELETED: "ORG_SOFT_DELETED",
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
    // #1499 — emitted by PUT /api/organizations/[orgId]/cancellation-policy. A
    // published version is immutable, so the audit row plus the version number is
    // the whole change history: `details` carries the ladder that was published.
    CANCELLATION_POLICY_PUBLISHED: "CANCELLATION_POLICY_PUBLISHED",
  },
  CONSENT: {
    CONSENT_GRANTED: "CONSENT_GRANTED",
    CONSENT_WITHDRAWN: "CONSENT_WITHDRAWN",
    // An operator's record that a member asked to withdraw; only the member
    // withdraws (#1527 decision 5). Their Account › Data consent reads it.
    CONSENT_WITHDRAWAL_REQUESTED: "CONSENT_WITHDRAWAL_REQUESTED",
    DATA_BREACH_REPORTED: "DATA_BREACH_REPORTED",
  },
  CATALOG: {
    // Emitted from POST /api/organizations/[orgId]/catalog when an OWNER
    // adds an OrganizationPlan to the sponsored catalog.
    CATALOG_PLAN_CREATED: "CATALOG_PLAN_CREATED",
    // Emitted from DELETE /api/organizations/[orgId]/catalog, which ARCHIVES
    // (sets `archivedAt`) rather than deleting — the plan FK chain cascades to
    // Appointment and Payment, so a real delete would destroy settled money
    // records. Kept as a single audit row per call, with the affected planIds
    // surfaced via `details`.
    CATALOG_PLAN_DEACTIVATED: "CATALOG_PLAN_DEACTIVATED",
    // The inverse: an archived plan put back on sale.
    CATALOG_PLAN_RESTORED: "CATALOG_PLAN_RESTORED",
    // #1851 decision 8 — an org operator changed a material on an ORG-owned
    // plan. The row targets the delivering expert's membership.
    PLAN_MATERIAL_ADDED: "PLAN_MATERIAL_ADDED",
    PLAN_MATERIAL_UPDATED: "PLAN_MATERIAL_UPDATED",
    PLAN_MATERIAL_REMOVED: "PLAN_MATERIAL_REMOVED",
  },
  SYSTEM: {
    VERIFIED: "VERIFIED",
    SUSPENDED: "SUSPENDED",
    REACTIVATED: "REACTIVATED",
    DEACTIVATED: "DEACTIVATED",
    // #779 §A — PENDING_VERIFICATION resubmit loop. REJECTED is the admin
    // bouncing the org back with a reason; RESUBMITTED is the OWNER/MAINTAINER
    // re-submitting after fixing. Org stays PENDING_VERIFICATION throughout.
    VERIFICATION_REJECTED: "VERIFICATION_REJECTED",
    VERIFICATION_RESUBMITTED: "VERIFICATION_RESUBMITTED",
    // Emitted by DELETE /api/organizations/[orgId] when an OWNER tears
    // an org down. Kept inside SYSTEM so the audit row outlives the
    // org itself (soft-deleted targetMembershipId) and is still
    // auditable post-deletion.
    ORG_DELETED: "ORG_DELETED",
    // PR #655 Batch 6 — audit retention cron emits one summary row per
    // org per run carrying { deleted7y, deleted2y, cutoff7y, cutoff2y }
    // in `details`. Pinned under SYSTEM because the operator is the
    // platform, not a human member.
    AUDIT_PRUNED: "AUDIT_PRUNED",
    // Emitted by the Stream recording retention cron when it tombstones
    // a recording older than the org's `streamRecordingRetentionDays`.
    STREAM_RECORDING_DELETED: "STREAM_RECORDING_DELETED",
    // #1270 — emitted whenever a platform operator (ADMIN or STAFF) reads a
    // recording they have no participation in. The operator path used to be
    // less accountable than the tenant path: deleting and exporting recordings
    // wrote a row, reaching in and watching one wrote nothing. `details.played`
    // distinguishes metadata-only (STAFF) from playback (ADMIN).
    STREAM_RECORDING_ACCESSED: "STREAM_RECORDING_ACCESSED",
    // Emitted from GET /api/organizations/[orgId]/stream/calls when a
    // MANAGER+ exports the call/recording metadata (compliance pull).
    STREAM_CALLS_EXPORTED: "STREAM_CALLS_EXPORTED",
    // The chat half of the same compliance pair. Shipped without an audit
    // row while its sibling had one, so pulling the roster of who messages
    // whom inside an org left no trace.
    STREAM_CHANNELS_EXPORTED: "STREAM_CHANNELS_EXPORTED",
    // Emitted by PATCH org settings when the retention window changes;
    // SYSTEM bucket because it's a platform-policy mutation, not a
    // member action.
    STREAM_RETENTION_CHANGED: "STREAM_RETENTION_CHANGED",
    // PR #655 Batch 5 — DPDP §12 user erasure lifecycle. Pinned under
    // SYSTEM (the actor is the user-or-admin acting on a regulatory
    // surface), distinct from CONSENT bucket which records GRANT/WITHDRAW.
    USER_ERASURE_REQUESTED: "USER_ERASURE_REQUESTED",
    USER_ERASURE_PROCESSED: "USER_ERASURE_PROCESSED",
    USER_ERASURE_REJECTED: "USER_ERASURE_REJECTED",
    USER_ERASURE_SLA_WARNING: "USER_ERASURE_SLA_WARNING",
    // PR #655 Batch 6.5 — DPDP §11 right-to-access export bundle
    // lifecycle. Logged per state so an operator can reconstruct
    // "who pulled what bundle when" without grepping worker logs.
    DATA_EXPORT_REQUESTED: "DATA_EXPORT_REQUESTED",
    DATA_EXPORT_GENERATED: "DATA_EXPORT_GENERATED",
    DATA_EXPORT_FAILED: "DATA_EXPORT_FAILED",
    DATA_EXPORT_DOWNLOADED: "DATA_EXPORT_DOWNLOADED",
  },
  // PR #655 Batch 3 — outbound webhook subsystem audit trail. One
  // category for both endpoint configuration (CRUD) and delivery
  // results (SUCCEEDED / FAILED / REDELIVERED). The delivery rows
  // emit one summary per final state, not per attempt, to keep the
  // audit log readable when an endpoint fails 5 times before
  // resolving.
  WEBHOOK: {
    WEBHOOK_ENDPOINT_CREATED: "WEBHOOK_ENDPOINT_CREATED",
    WEBHOOK_ENDPOINT_UPDATED: "WEBHOOK_ENDPOINT_UPDATED",
    WEBHOOK_ENDPOINT_DELETED: "WEBHOOK_ENDPOINT_DELETED",
    WEBHOOK_SECRET_ROTATED: "WEBHOOK_SECRET_ROTATED",
    WEBHOOK_ENDPOINT_PAUSED: "WEBHOOK_ENDPOINT_PAUSED",
    WEBHOOK_ENDPOINT_RESUMED: "WEBHOOK_ENDPOINT_RESUMED",
    WEBHOOK_DELIVERY_SUCCEEDED: "WEBHOOK_DELIVERY_SUCCEEDED",
    WEBHOOK_DELIVERY_FAILED: "WEBHOOK_DELIVERY_FAILED",
    WEBHOOK_DELIVERY_REDELIVERED: "WEBHOOK_DELIVERY_REDELIVERED",
  },
} as const satisfies Record<OrgAuditCategory, Record<string, string>>;

export type AuditCategory = keyof typeof AUDIT_ACTIONS;
