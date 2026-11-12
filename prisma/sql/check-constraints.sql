-- #676 A1–A4 — data-integrity CHECK constraints for booking/payment tables.
--
-- Prisma 7 has no @@check in PSL, so these ride the same sidecar pattern as
-- ledger-triggers.sql: idempotent statements split on `-- SPLIT`, applied via
-- `npm run db:constraints` after every push/reset (NOT against the shared dev
-- DB mid-cycle — the pre-MVP reset applies them to a clean schema).
--
-- Payment amounts use >= 0, not > 0: credit-covered checkouts and
-- org-sponsored bookings legitimately write amount = 0 (free_/org_ synthetic
-- payment intents in lib/payments/checkout/orchestrate.ts).
--
-- Staged for the #1729 reset (#1771 row 7): ALTER TABLE "OrganizationPayoutAccount"
-- DROP COLUMN "accountNumberEncrypted"; it is no longer written, as bank data is reference-only.

ALTER TABLE "AppointmentOccurrence" DROP CONSTRAINT IF EXISTS "occurrence_time_order";
-- SPLIT
ALTER TABLE "AppointmentOccurrence" ADD CONSTRAINT "occurrence_time_order" CHECK ("endsAt" > "startsAt");
-- SPLIT
-- #1554 — `ordinal` is the call's position in its purchase and a replacement
-- written after a reschedule inherits it, so the unique holds over LIVE rows
-- only; the RESCHEDULED / CANCELLED row keeps its number for history.
-- #1569 — a VOIDED row is a miss like a host cancel, so its make-up reuses the ordinal.
DROP INDEX IF EXISTS "appointment_occurrence_live_ordinal_key";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_occurrence_live_ordinal_key"
  ON "AppointmentOccurrence" ("appointmentId", "ordinal")
  WHERE "completionStatus" NOT IN ('RESCHEDULED', 'CANCELLED', 'VOIDED') AND "deletedAt" IS NULL;
-- SPLIT
-- #1554 / #1550 — a rating is about one call (appointmentOccurrenceId set) or
-- the whole appointment (NULL). One row per person per level: NULLS NOT
-- DISTINCT (PG 15) makes two whole-appointment rows collide.
DROP INDEX IF EXISTS "appointment_feedback_level_key";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_feedback_level_key"
  ON "AppointmentFeedback" ("appointmentId", "appointmentOccurrenceId", "userId") NULLS NOT DISTINCT;
-- SPLIT
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_amounts_nonnegative";
-- SPLIT
ALTER TABLE "Payment" ADD CONSTRAINT "payment_amounts_nonnegative"
  CHECK ("amount" >= 0 AND "originalAmount" >= 0 AND "taxAmount" >= 0);
-- SPLIT
-- #1582 A-P0-02 — a funding leg is non-negative unless it is a *_REVERSAL
-- sibling (INVOICE_ACCRUAL_REVERSAL / OVERAGE_INVOICE_ACCRUAL_REVERSAL), the
-- one shape that nets a refund through a negative row.
ALTER TABLE "PaymentLeg" DROP CONSTRAINT IF EXISTS "payment_leg_nonreversal_nonnegative";
-- SPLIT
ALTER TABLE "PaymentLeg" ADD CONSTRAINT "payment_leg_nonreversal_nonnegative"
  CHECK ("source"::text LIKE '%\_REVERSAL' OR "amountPaise" >= 0);
-- SPLIT
ALTER TABLE "ConsultationPlan" DROP CONSTRAINT IF EXISTS "consultation_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "ConsultationPlan" ADD CONSTRAINT "consultation_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT IF EXISTS "subscription_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "subscription_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_price_nonnegative";
-- SPLIT
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_price_nonnegative" CHECK ("price" >= 0);
-- SPLIT
ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_max_participants_min";
-- SPLIT
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_max_participants_min" CHECK ("maxParticipants" >= 1);
-- SPLIT
ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_max_participants_min";
-- SPLIT
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_max_participants_min" CHECK ("maxParticipants" >= 1);
-- SPLIT
-- Per-instance capacity override. NULL means "inherit the plan's value", so
-- the guard has to admit NULL while still rejecting a zero or negative cap.
ALTER TABLE "Webinar" DROP CONSTRAINT IF EXISTS "webinar_max_participants_min";
-- SPLIT
ALTER TABLE "Webinar" ADD CONSTRAINT "webinar_max_participants_min" CHECK ("maxParticipants" IS NULL OR "maxParticipants" >= 1);
-- SPLIT
ALTER TABLE "Class" DROP CONSTRAINT IF EXISTS "class_max_participants_min";
-- SPLIT
ALTER TABLE "Class" ADD CONSTRAINT "class_max_participants_min" CHECK ("maxParticipants" IS NULL OR "maxParticipants" >= 1);

-- SPLIT
-- #440 / #2010 — DB-level single-active-session overlap backstop across all 5
-- offering types (Consultation, Subscription, Webinar, Class, Trial). Since
-- #1554 unified seat rosters into AppointmentParticipant, group events create
-- one AppointmentOccurrence per session and denormalize the host's
-- consultantProfileId onto every occurrence. Two CONFIRMED, live occurrences
-- for the same consultant may never overlap in time; tstzrange is '[)' so
-- back-to-back occurrences don't conflict.
-- #1694 / #2010 — tombstones (deletedAt IS NOT NULL) and replaced/cancelled
-- sessions (completionStatus IN ('CANCELLED', 'RESCHEDULED'), e.g. class
-- session cancellations that omit deletedAt so they stay countable as misses)
-- are exempt so a make-up or re-booked slot can take the vacated time.
CREATE EXTENSION IF NOT EXISTS btree_gist;
-- SPLIT
ALTER TABLE "AppointmentOccurrence" DROP CONSTRAINT IF EXISTS "occurrence_no_confirmed_overlap";
-- SPLIT
ALTER TABLE "AppointmentOccurrence" ADD CONSTRAINT "occurrence_no_confirmed_overlap"
  EXCLUDE USING gist (
    "consultantProfileId" WITH =,
    tstzrange("startsAt", "endsAt") WITH &&
  )
  WHERE ("consultantProfileId" IS NOT NULL AND NOT "isTentative" AND "deletedAt" IS NULL AND "completionStatus" NOT IN ('CANCELLED', 'RESCHEDULED'));

-- SPLIT
-- #2010 — every confirmed, live occurrence must carry its host
-- consultantProfileId so occurrence_no_confirmed_overlap cannot be bypassed
-- by a NULL consultantProfileId across any offering type.
ALTER TABLE "AppointmentOccurrence"
  DROP CONSTRAINT IF EXISTS "occurrence_confirmed_requires_consultant_chk",
  ADD CONSTRAINT "occurrence_confirmed_requires_consultant_chk"
    CHECK (
      "isTentative"
      OR "deletedAt" IS NOT NULL
      OR "consultantProfileId" IS NOT NULL
      OR "completionStatus" IN ('CANCELLED', 'RESCHEDULED')
    ) NOT VALID;
-- SPLIT
ALTER TABLE "AppointmentOccurrence"
  VALIDATE CONSTRAINT "occurrence_confirmed_requires_consultant_chk";

-- SPLIT
-- #747 / #685 — DB-enforced "at most one pending invite per (org, email)".
-- Prisma's `partialIndexes` is still preview at 7.7.0 (drift bugs
-- prisma/prisma#29263 / #29415), so the partial unique index ships via this
-- sidecar instead; the Serializable tx in invitations/route.ts stays as the
-- first line. lower(email): the accept flow compares case-insensitively and
-- the POST handler normalizes, so the index must not admit a mixed-case
-- duplicate from any other writer. Applied to a clean schema (pre-MVP reset)
-- — CREATE fails loudly if duplicate pending invites already exist, which is
-- the correct outcome.
DROP INDEX IF EXISTS "invitations_org_email_pending_key";
-- SPLIT
CREATE UNIQUE INDEX "invitations_org_email_pending_key"
  ON "invitations" ("organizationId", lower("email"))
  WHERE "status" = 'PENDING';

-- SPLIT
-- #676 PM-17 — extend the payment_amounts_nonnegative pattern to every other
-- money-bearing table. Every paise column is non-negative (>= 0, matching
-- Payment). We deliberately do NOT use > 0: zero is legitimate across the
-- board — fully-refunded or credit/org-sponsored rows, LICENSE-funded
-- bookings (amount = 0), and refund/earnings reversal counter-entries that
-- net a row back to zero. NULLable columns (e.g. tdsAmountPaise, netAmount)
-- are exempted automatically: a CHECK passes when its operand is NULL.
ALTER TABLE "Refund" DROP CONSTRAINT IF EXISTS "refund_amount_nonnegative";
-- SPLIT
ALTER TABLE "Refund" ADD CONSTRAINT "refund_amount_nonnegative" CHECK ("amountPaise" >= 0);
-- SPLIT
ALTER TABLE "Dispute" DROP CONSTRAINT IF EXISTS "dispute_amount_nonnegative";
-- SPLIT
ALTER TABLE "Dispute" ADD CONSTRAINT "dispute_amount_nonnegative" CHECK ("amountPaise" >= 0);
-- SPLIT
ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_amounts_nonnegative"
  CHECK ("amount" >= 0 AND "tdsDeducted" >= 0 AND "clawbackAmountPaise" >= 0 AND ("netAmount" IS NULL OR "netAmount" >= 0));
-- SPLIT
ALTER TABLE "OrganizationPayout" DROP CONSTRAINT IF EXISTS "org_payout_amounts_nonnegative";
-- SPLIT
ALTER TABLE "OrganizationPayout" ADD CONSTRAINT "org_payout_amounts_nonnegative"
  CHECK (
    "amountPaise" >= 0
    AND "grossRevenuePaise" >= 0
    AND "platformFeePaise" >= 0
    AND "refundsPaise" >= 0
    AND "netPayoutPaise" >= 0
    AND "clawbackAmountPaise" >= 0
    AND ("tdsAmountPaise" IS NULL OR "tdsAmountPaise" >= 0)
  );
-- SPLIT
ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_amounts_nonnegative"
  CHECK (
    "grossAmount" >= 0
    AND "platformFeePaise" >= 0
    AND "consultantSharePaise" >= 0
    AND "refundedShareAmount" >= 0
  );
-- SPLIT
ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_amounts_nonnegative";
-- SPLIT
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_amounts_nonnegative"
  CHECK (
    "grossAmountPaise" >= 0
    AND "platformFeePaise" >= 0
    AND "orgSharePaise" >= 0
    AND "consultantSharePaise" >= 0
    AND "refundedAmountPaise" >= 0
  );

-- SPLIT
-- #676 PM-18 — the 3-way split must never distribute more than it took in:
-- platform fee + org share + consultant share <= gross. earnings-service.ts
-- computes orgShare as the residual (gross - platformFee - consultantShare,
-- clamped to >= 0), so equality is the norm and this catches a future writer
-- that mis-derives the split. Applied to OrganizationEarnings only: the
-- ConsultantEarnings COLLABORATOR rows deliberately carry grossAmount = 0
-- while consultantSharePaise > 0 (the booking gross lives once on the OWNER
-- row), so the same invariant does not hold there and must not be enforced.
ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_split_within_gross";
-- SPLIT
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_split_within_gross"
  CHECK ("platformFeePaise" + "orgSharePaise" + "consultantSharePaise" <= "grossAmountPaise");

-- SPLIT
-- #676 PM-22 — financial-year strings are always "YYYY-YY" (e.g. 2026-27).
-- Both writers persist the FY to avoid Apr-Mar boundary drift; this rejects a
-- malformed value at write time. ConsultantPayout.tdsFinancialYear is nullable
-- (payouts without a TDS deduction), so NULL is admitted.
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_financial_year_format";
-- SPLIT
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_financial_year_format"
  CHECK ("financialYear" ~ '^[0-9]{4}-[0-9]{2}$');
-- SPLIT
ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_tds_fy_format";
-- SPLIT
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_tds_fy_format"
  CHECK ("tdsFinancialYear" IS NULL OR "tdsFinancialYear" ~ '^[0-9]{4}-[0-9]{2}$');

-- SPLIT
-- #784 — a Collaborator references exactly one plan: a webinar XOR a class.
-- The app-level backstop is assertCollaboratorPlanXor in
-- lib/collaborators/service.ts; this DB CHECK is the last line. Exactly one of
-- the two FKs is non-NULL <=> exactly one IS NULL, which `<>` expresses.
ALTER TABLE "Collaborator" DROP CONSTRAINT IF EXISTS "collaborator_plan_xor";
-- SPLIT
ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_plan_xor"
  CHECK (
    ("collaboratorType" = 'WEBINAR' AND "webinarPlanId" IS NOT NULL AND "classPlanId" IS NULL)
    OR ("collaboratorType" = 'CLASS' AND "classPlanId" IS NOT NULL AND "webinarPlanId" IS NULL)
  );

-- SPLIT
-- ============================================================================
-- Money invariants that were documented but unenforced (2026-07-28 audit).
--
-- Each of these was already asserted somewhere — in a schema doc-comment, in an
-- ADR, or in an application guard — with nothing stopping a future writer, a
-- raw SQL fix, or a seed script from violating it. Every one was verified to
-- have zero violating rows on the live database before being added; a
-- constraint that cannot be applied is worse than none, because
-- check-db-sidecars then reports a permanent failure people learn to ignore.
-- ============================================================================

-- SPLIT
-- The wallet's only overdraft guard is an ORM conditional updateMany
-- (`where: { walletBalance: { gte: amount } }` in lib/api/organizations/wallet.ts).
-- That is correct but it is the ONLY line of defence: any other writer, or a
-- decrement that skips the guard, can drive an org's prepaid balance negative —
-- money the platform would then owe out of its own pocket. NULL is admitted
-- (accounts on non-WALLET funding never initialise it).
ALTER TABLE "BillingAccount" DROP CONSTRAINT IF EXISTS "billing_account_wallet_nonnegative";
-- SPLIT
ALTER TABLE "BillingAccount" ADD CONSTRAINT "billing_account_wallet_nonnegative"
  CHECK ("walletBalance" IS NULL OR "walletBalance" >= 0);

-- SPLIT
-- A purchase order can never have more left on it than it was worth.
ALTER TABLE "PurchaseOrder" DROP CONSTRAINT IF EXISTS "purchase_order_amounts_coherent";
-- SPLIT
ALTER TABLE "PurchaseOrder" ADD CONSTRAINT "purchase_order_amounts_coherent"
  CHECK (
    "totalAmountPaise" >= 0
    AND "remainingAmountPaise" >= 0
    AND "remainingAmountPaise" <= "totalAmountPaise"
  );

-- SPLIT
-- ReferralCredit.remainingAmount is a STORED derived column, and it is the one
-- the user sees and spends. Drift means a buyer is shown — and can consume —
-- a balance the ledger does not agree with. reverseCreditsForPayment nets
-- against it on every refund, so a wrong value compounds.
ALTER TABLE "ReferralCredit" DROP CONSTRAINT IF EXISTS "referral_credit_balance_consistent";
-- SPLIT
ALTER TABLE "ReferralCredit" ADD CONSTRAINT "referral_credit_balance_consistent"
  CHECK (
    "amount" >= 0
    AND "usedAmount" >= 0
    AND "remainingAmount" >= 0
    AND "remainingAmount" = "amount" - "usedAmount"
  );

-- SPLIT
ALTER TABLE "ReferralCreditUsage" DROP CONSTRAINT IF EXISTS "referral_credit_usage_nonnegative";
-- SPLIT
ALTER TABLE "ReferralCreditUsage" ADD CONSTRAINT "referral_credit_usage_nonnegative"
  CHECK ("amount" >= 0 AND "originalAmount" >= 0 AND "restoredAmount" >= 0);

-- SPLIT
-- marginalPaise is what the payer is charged: base + surcharge + the surcharge's
-- GST, which is never negative, so it can never fall below base + surcharge.
ALTER TABLE "OverageEvent" DROP CONSTRAINT IF EXISTS "overage_marginal_is_base_plus_surcharge";
-- SPLIT
ALTER TABLE "OverageEvent" ADD CONSTRAINT "overage_marginal_is_base_plus_surcharge"
  CHECK (
    "basePaise" >= 0
    AND "surchargePaise" >= 0
    AND "marginalPaise" >= "basePaise" + "surchargePaise"
  );

-- SPLIT
-- ADR 02's central claim is that `platformBps + orgBps + consultantBps = 10000`
-- is "an integer equality that the system can assert and that always holds".
-- It was asserted nowhere. earnings-service clamps a bad card at runtime, which
-- silently redistributes a booking's money rather than refusing it.
ALTER TABLE "RateCard" DROP CONSTRAINT IF EXISTS "rate_card_bps_sum_is_whole";
-- SPLIT
ALTER TABLE "RateCard" ADD CONSTRAINT "rate_card_bps_sum_is_whole"
  CHECK (
    "platformBps" >= 0 AND "orgBps" >= 0 AND "consultantBps" >= 0
    AND "platformBps" + "orgBps" + "consultantBps" = 10000
  );

-- SPLIT
-- A collaborator's share is a fraction of the whole, so it lives in [0, 10000].
-- The cross-row "shares on one plan sum to <= 10000" invariant cannot be a
-- CHECK; it is asserted by the ledger reconciler instead.
ALTER TABLE "Collaborator" DROP CONSTRAINT IF EXISTS "collaborator_share_bps_in_range";
-- SPLIT
ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_share_bps_in_range"
  CHECK (1 <= "revenueShareBps" AND "revenueShareBps" <= 9000);
-- SPLIT
DO $$
BEGIN
  UPDATE "Collaborator"
  SET "role" = (CASE WHEN "role" = 'CO_INSTRUCTOR' THEN 'CO_HOST' ELSE 'GUEST_SPEAKER' END)::"CollaboratorRole"
  WHERE "collaboratorType" = 'WEBINAR'
    AND "role" NOT IN ('CO_HOST', 'MODERATOR', 'GUEST_SPEAKER', 'TECHNICAL_SUPPORT');

  UPDATE "Collaborator"
  SET "role" = (CASE WHEN "role" = 'CO_HOST' THEN 'CO_INSTRUCTOR' ELSE 'GUEST_LECTURER' END)::"CollaboratorRole"
  WHERE "collaboratorType" = 'CLASS'
    AND "role" NOT IN ('CO_INSTRUCTOR', 'TEACHING_ASSISTANT', 'GUEST_LECTURER', 'CONTENT_CREATOR');

  UPDATE "Collaborator"
  SET "tier" = (CASE WHEN "role" IN ('CO_HOST', 'CO_INSTRUCTOR') THEN 'PRESENTER' ELSE 'CREW' END)::"CollaboratorTier"
  WHERE ("role" IN ('CO_HOST', 'CO_INSTRUCTOR') AND "tier" <> 'PRESENTER')
     OR ("role" NOT IN ('CO_HOST', 'CO_INSTRUCTOR') AND "tier" <> 'CREW');

  ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_role_matches_plan_type"
    CHECK (
      ("collaboratorType" = 'WEBINAR' AND "role" IN ('CO_HOST', 'MODERATOR', 'GUEST_SPEAKER', 'TECHNICAL_SUPPORT'))
      OR ("collaboratorType" = 'CLASS' AND "role" IN ('CO_INSTRUCTOR', 'TEACHING_ASSISTANT', 'GUEST_LECTURER', 'CONTENT_CREATOR'))
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
-- SPLIT
DO $$
BEGIN
  ALTER TABLE "Collaborator" ADD CONSTRAINT "collaborator_tier_matches_role"
    CHECK (
      ("role" IN ('CO_HOST', 'CO_INSTRUCTOR') AND "tier" = 'PRESENTER')
      OR ("role" NOT IN ('CO_HOST', 'CO_INSTRUCTOR') AND "tier" = 'CREW')
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- SPLIT
-- The journal's direction column carries the sign, so an entry amount is
-- strictly positive. postLedgerTxn already rejects <= 0, but the CONSTRAINT
-- TRIGGER that enforces the balance invariant sums these values: a zero or
-- negative entry would let an "unbalanced" transaction sum to zero and pass.
ALTER TABLE "LedgerEntry" DROP CONSTRAINT IF EXISTS "ledger_entry_amount_positive";
-- SPLIT
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "ledger_entry_amount_positive"
  CHECK ("amountPaise" > 0);

-- SPLIT
-- Redemption caps are enforced only in application code today, so a race or a
-- direct write can over-redeem a capped discount.
ALTER TABLE "DiscountCode" DROP CONSTRAINT IF EXISTS "discount_code_uses_within_cap";
-- SPLIT
ALTER TABLE "DiscountCode" ADD CONSTRAINT "discount_code_uses_within_cap"
  CHECK (
    "currentUses" >= 0
    AND ("maxUses" IS NULL OR "currentUses" <= "maxUses")
  );

-- SPLIT
-- #1093 §4 — a partial unique the schema doc-comment always claimed. Verified
-- duplicate-free on the live database before adding (2026-08-13), so it
-- applies cleanly outside a reset.
DROP INDEX IF EXISTS "erasure_request_active_user_key";
-- SPLIT
CREATE UNIQUE INDEX "erasure_request_active_user_key"
  ON "ErasureRequest" ("userId")
  WHERE "status" IN ('PENDING', 'IN_PROGRESS');

-- SPLIT
-- ============================================================================
-- Statutory-document and billing-amount guards (money-hardening pass).
-- These tables had NO DB-level guard at all: every other money model got a
-- CHECK in this file, but the GST documents (invoice / credit note / line
-- items), wallet top-ups, per-earning share bps and seat-config pricing were
-- writable to nonsense by any direct write or future code path that skipped
-- app validation. Amounts use >= 0 where zero is legitimate (free lines,
-- zero-rated); top-ups must be strictly positive (a zero top-up is a bug,
-- not a state).
ALTER TABLE "OrganizationInvoice" DROP CONSTRAINT IF EXISTS "org_invoice_amounts_nonnegative";
-- SPLIT
ALTER TABLE "OrganizationInvoice" ADD CONSTRAINT "org_invoice_amounts_nonnegative"
  CHECK (
    "subtotalPaise" >= 0
    AND "igstPaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0
    AND "totalPaise" >= 0
    AND "subtotalPaise" + "igstPaise" + "cgstPaise" + "sgstPaise" = "totalPaise"
  );
-- SPLIT
ALTER TABLE "InvoiceLineItem" DROP CONSTRAINT IF EXISTS "invoice_line_item_amounts_nonnegative";
-- SPLIT
ALTER TABLE "InvoiceLineItem" ADD CONSTRAINT "invoice_line_item_amounts_nonnegative"
  CHECK ("quantity" > 0 AND "unitPricePaise" >= 0 AND ("taxPaise" IS NULL OR "taxPaise" >= 0));
-- SPLIT
ALTER TABLE "CreditNote" DROP CONSTRAINT IF EXISTS "credit_note_amounts_nonnegative";
-- SPLIT
ALTER TABLE "CreditNote" ADD CONSTRAINT "credit_note_amounts_nonnegative"
  CHECK (
    "subtotalPaise" >= 0
    AND "igstPaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0
    AND "totalPaise" >= 0
    AND "igstPaise" + "cgstPaise" + "sgstPaise" <= "totalPaise"
  );
-- SPLIT
-- #1582 C-P0-01 — exactly one trigger keys an org credit note: a Refund, a
-- Dispute, an OverageEvent reversal, or the platform's void of its invoice.
ALTER TABLE "CreditNote" DROP CONSTRAINT IF EXISTS "credit_note_trigger_xor";
-- SPLIT
ALTER TABLE "CreditNote" ADD CONSTRAINT "credit_note_trigger_xor"
  CHECK (num_nonnulls("refundId", "disputeId", "overageEventId", "voidedInvoiceId") = 1);
-- SPLIT
ALTER TABLE "WalletTopUp" DROP CONSTRAINT IF EXISTS "wallet_topup_amount_positive";
-- SPLIT
ALTER TABLE "WalletTopUp" ADD CONSTRAINT "wallet_topup_amount_positive"
  CHECK ("amountPaise" > 0);
-- SPLIT
-- The RateCard bps sum got rate_card_bps_sum_is_whole; the per-earning
-- snapshot of that split had nothing — a direct write could record a 150%
-- share against an earning.
ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_share_bps_range";
-- SPLIT
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_share_bps_range"
  CHECK ("shareBps" >= 0 AND "shareBps" <= 10000);
-- SPLIT
ALTER TABLE "LicensedSeatConfig" DROP CONSTRAINT IF EXISTS "licensed_seat_config_pricing_sane";
-- SPLIT
ALTER TABLE "LicensedSeatConfig" ADD CONSTRAINT "licensed_seat_config_pricing_sane"
  CHECK (
    "ratePerSeatPaise" >= 0
    AND ("priceCapPerEngagementPaise" IS NULL OR "priceCapPerEngagementPaise" >= 0)
    AND ("maxOveragePerCyclePaise" IS NULL OR "maxOveragePerCyclePaise" >= 0)
    AND ("overageSurchargeBps" IS NULL OR ("overageSurchargeBps" >= 0 AND "overageSurchargeBps" <= 10000))
  );
-- SPLIT
ALTER TABLE "Contract" DROP CONSTRAINT IF EXISTS "contract_payment_terms_nonnegative";
-- SPLIT
ALTER TABLE "Contract" ADD CONSTRAINT "contract_payment_terms_nonnegative"
  CHECK ("paymentTermsDays" >= 0);

-- #1244 review — document review thread versioning. Prisma cannot express a
-- functional/partial unique, so this rides the sidecar like the CHECKs above:
-- one version number per position within a live thread. The root row joins
-- the thread via COALESCE(rootDocumentId, id); tombstoned rows are excluded
-- so the nightly purge can never conflict with itself.
ALTER TABLE "AppointmentDocument" DROP CONSTRAINT IF EXISTS "appointment_doc_thread_version_unique";
-- SPLIT
DROP INDEX IF EXISTS "appointment_doc_thread_version_unique";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_doc_thread_version_unique"
ON "AppointmentDocument" (COALESCE("rootDocumentId", "id"), "versionNo")
WHERE "deletedAt" IS NULL;
-- SPLIT
-- #onboarding-ux — the resumable-onboarding draft blob. The writer already
-- byte-gates at ONBOARDING_DRAFT_MAX_BYTES (utils/onboarding-draft.ts), but
-- that gate lives in application code on a column any future writer can reach
-- directly. `pg_column_size` measures the stored (post-TOAST-compression)
-- width, so a pasted resume that compresses well still gets in — the
-- constraint is a backstop against an unbounded row, not a second copy of the
-- product rule.
ALTER TABLE "onboarding_drafts" DROP CONSTRAINT IF EXISTS "onboarding_draft_payload_size";
-- SPLIT
ALTER TABLE "onboarding_drafts" ADD CONSTRAINT "onboarding_draft_payload_size"
  CHECK (pg_column_size("payload") <= 65536);

-- SPLIT
-- #1405 — one OPEN rate-card window per scope. `bumpRateCard` closes the
-- current card and inserts its replacement in one transaction, but under the
-- default isolation two concurrent OWNER bumps each read "nothing open here"
-- and each insert a row with `effectiveTo = NULL`; `findEffective` then picked
-- between the two open windows non-deterministically, so the same booking
-- could settle on either split. The route is Serializable + retried now; this
-- index is the structural guarantee behind it. Three of the four scope columns
-- are nullable and Postgres treats NULL key columns as distinct, which is
-- exactly the case that must NOT be exempt, so NULL key columns
-- are treated as equal via NULLS NOT DISTINCT (Postgres 15+); an enum-to-text
-- COALESCE expression is not IMMUTABLE and Postgres refuses it in an index.
DROP INDEX IF EXISTS "rate_card_one_open_window";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "rate_card_one_open_window"
  ON "RateCard" ("ownerOrgId", "ownerContractId", "planType", "planId")
  NULLS NOT DISTINCT
  WHERE "effectiveTo" IS NULL;

-- SPLIT
-- #1365 — B2C tax invoices are documents, not postings, so nothing else asserts
-- their arithmetic. A negative head on a statutory document is unfilable.
ALTER TABLE "ConsumerInvoice" DROP CONSTRAINT IF EXISTS "consumer_invoice_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsumerInvoice" ADD CONSTRAINT "consumer_invoice_amounts_nonnegative"
  CHECK ("taxableValuePaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0 AND "igstPaise" >= 0 AND "totalPaise" >= 0);
-- SPLIT
-- A supply is either intra-state (CGST+SGST) or inter-state (IGST); an invoice
-- carrying both heads names two mutually exclusive places of supply at once.
ALTER TABLE "ConsumerInvoice" DROP CONSTRAINT IF EXISTS "consumer_invoice_tax_head_xor";
-- SPLIT
ALTER TABLE "ConsumerInvoice" ADD CONSTRAINT "consumer_invoice_tax_head_xor"
  CHECK ("igstPaise" = 0 OR ("cgstPaise" = 0 AND "sgstPaise" = 0));
-- SPLIT
ALTER TABLE "ConsumerCreditNote" DROP CONSTRAINT IF EXISTS "consumer_credit_note_amounts_nonnegative";
-- SPLIT
ALTER TABLE "ConsumerCreditNote" ADD CONSTRAINT "consumer_credit_note_amounts_nonnegative"
  CHECK ("taxableValuePaise" >= 0 AND "cgstPaise" >= 0 AND "sgstPaise" >= 0 AND "igstPaise" >= 0 AND "totalPaise" >= 0);
-- SPLIT
-- #1582 — the credit note reverses one supply, so it carries the same
-- one-place-of-supply rule as the invoice it reverses (mirrors
-- consumer_invoice_tax_head_xor exactly).
ALTER TABLE "ConsumerCreditNote" DROP CONSTRAINT IF EXISTS "consumer_credit_note_tax_head_xor";
-- SPLIT
ALTER TABLE "ConsumerCreditNote" ADD CONSTRAINT "consumer_credit_note_tax_head_xor"
  CHECK ("igstPaise" = 0 OR ("cgstPaise" = 0 AND "sgstPaise" = 0));

-- SPLIT
-- ============================================================================
-- #1354 — one withholding table, two deductee rails.
--
-- TDSRecord and TdsAdjustment used to be consultant-only, with a NOT NULL
-- `consultantProfileId` doing the structural work. Admitting host
-- organisations meant making that column nullable, which on its own would
-- allow a row belonging to NEITHER rail (both null — an unattributable
-- statutory deduction) or to BOTH (a return line filed twice, against two
-- different PANs). Prisma cannot express a CHECK, so the invariant it used to
-- get free from NOT NULL has to be restated here.
--
-- Precedent: collaborator_plan_xor above, same `<>`-on-IS-NULL shape.
-- ============================================================================

-- SPLIT
-- Exactly one deductee. `(a IS NULL) <> (b IS NULL)` is true only when the two
-- nullness flags differ, which is exactly "one of them is set".
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_deductee_xor";
-- SPLIT
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_deductee_xor"
  CHECK (("consultantProfileId" IS NULL) <> ("organizationId" IS NULL));

-- SPLIT
-- The payout column must match the rail. Both FKs are real, so nothing else
-- stops an org row from citing a ConsultantPayout: the row would then dedupe
-- on the consultant unique (all-NULL, therefore never conflicting) and file
-- its credit under someone else's disbursement.
ALTER TABLE "TDSRecord" DROP CONSTRAINT IF EXISTS "tds_record_payout_rail_matches";
-- SPLIT
ALTER TABLE "TDSRecord" ADD CONSTRAINT "tds_record_payout_rail_matches"
  CHECK (
    ("organizationId" IS NULL AND "orgPayoutId" IS NULL)
    OR ("consultantProfileId" IS NULL AND "payoutId" IS NULL)
  );

-- SPLIT
-- Same XOR on the filing-side adjustment rows, which the return generator
-- exports as revised-statement lines.
ALTER TABLE "TdsAdjustment" DROP CONSTRAINT IF EXISTS "tds_adjustment_deductee_xor";
-- SPLIT
ALTER TABLE "TdsAdjustment" ADD CONSTRAINT "tds_adjustment_deductee_xor"
  CHECK (("consultantProfileId" IS NULL) <> ("organizationId" IS NULL));

-- SPLIT
-- #676 PM-22 shape, now on the org rail too: OrganizationPayout.tdsFinancialYear
-- is what the completion-time TDSRecord files under, so a malformed value there
-- files a whole quarter's org withholding under a year that does not exist.
ALTER TABLE "OrganizationPayout" DROP CONSTRAINT IF EXISTS "org_payout_tds_fy_format";
-- SPLIT
ALTER TABLE "OrganizationPayout" ADD CONSTRAINT "org_payout_tds_fy_format"
  CHECK ("tdsFinancialYear" IS NULL OR "tdsFinancialYear" ~ '^[0-9]{4}-[0-9]{2}$');

-- SPLIT
-- #1367 / #1368 — TdsRate integer-bps and effective-window sanity: rates live
-- in [0, 10000] bps (covering 194O, 393-8(v), 194J, 194C), thresholds are
-- non-negative, and a closed window never ends before it started.
ALTER TABLE "TdsRate" DROP CONSTRAINT IF EXISTS "tds_rate_bps_and_window_sane";
-- SPLIT
ALTER TABLE "TdsRate" ADD CONSTRAINT "tds_rate_bps_and_window_sane"
  CHECK (
    "rateBps" >= 0 AND "rateBps" <= 10000
    AND ("noPanRateBps" IS NULL OR ("noPanRateBps" >= 0 AND "noPanRateBps" <= 10000))
    AND ("thresholdPaise" IS NULL OR "thresholdPaise" >= 0)
    AND ("effectiveTo" IS NULL OR "effectiveTo" >= "effectiveFrom")
  );
-- SPLIT
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'tds_rate_bps_bounds'
  ) THEN
    ALTER TABLE "TdsRate" ADD CONSTRAINT "tds_rate_bps_bounds"
      CHECK (
        "rateBps" >= 0 AND "rateBps" <= 10000
        AND ("noPanRateBps" IS NULL OR ("noPanRateBps" >= 0 AND "noPanRateBps" <= 10000))
      );
  END IF;
END $$;

-- SPLIT
-- #1549 — one review per (consultant, consultee, track, event). ratingUnitId is NULL on
-- every 1:1 row, so the key needs NULLS NOT DISTINCT, which Prisma cannot express; the
-- predicate exempts NULL-track legacy rows and is what keeps `db push` from seeing the
-- index (Prisma ignores partial indexes; a total one with an undeclared tuple would be
-- dropped). Deliberately NOT partial on deletedAt: a removed row keeps occupying its key.
DROP INDEX IF EXISTS "consultant_review_pair_track_event_key";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "consultant_review_pair_track_event_key"
  ON "ConsultantReview" ("consultantProfileId", "consulteeProfileId", "track", "ratingUnitId")
  NULLS NOT DISTINCT
  WHERE "track" IS NOT NULL;

-- SPLIT
-- #1562 — the actor enum is set exactly when the removal timestamp is, on both the
-- review and its reply; the read paths branch on the enum and must never meet a
-- removed row with no actor.
ALTER TABLE "ConsultantReview" DROP CONSTRAINT IF EXISTS "consultant_review_removed_pair";
-- SPLIT
ALTER TABLE "ConsultantReview" ADD CONSTRAINT "consultant_review_removed_pair"
  CHECK (("deletedAt" IS NULL) = ("removedBy" IS NULL));
-- SPLIT
ALTER TABLE "ConsultantReview" DROP CONSTRAINT IF EXISTS "consultant_review_reply_removed_pair";
-- SPLIT
ALTER TABLE "ConsultantReview" ADD CONSTRAINT "consultant_review_reply_removed_pair"
  CHECK (("replyDeletedAt" IS NULL) = ("replyRemovedBy" IS NULL));

-- SPLIT
-- #1562 — ModerationAction is the single audit row for every staff act; reportId is
-- nullable now, so a row must still name what it was about.
ALTER TABLE "ModerationAction" DROP CONSTRAINT IF EXISTS "moderation_action_has_target";
-- SPLIT
ALTER TABLE "ModerationAction" ADD CONSTRAINT "moderation_action_has_target"
  CHECK ("reportId" IS NOT NULL OR "reviewId" IS NOT NULL OR "feedbackId" IS NOT NULL);
-- SPLIT
-- #1562 — a direct act names the content its type is about: a review act carries
-- reviewId, a feedback act carries feedbackId. Report-backed acts are unaffected.
ALTER TABLE "ModerationAction" DROP CONSTRAINT IF EXISTS "moderation_action_target_matches_type";
-- SPLIT
ALTER TABLE "ModerationAction" ADD CONSTRAINT "moderation_action_target_matches_type"
  CHECK (
    ("actionType" NOT IN ('REVIEW_REMOVED', 'REVIEW_REPLY_REMOVED', 'REVIEW_EXCLUDED_FROM_AGGREGATE') OR "reviewId" IS NOT NULL)
    AND ("actionType" <> 'FEEDBACK_EXCLUDED_FROM_AGGREGATE' OR "feedbackId" IS NOT NULL)
  );

-- SPLIT
-- #1549 — a GROUP review is one data point about one EVENT; a GROUP row with no
-- event key can be attributed to nothing, and no fallback is safe.
ALTER TABLE "ConsultantReview" DROP CONSTRAINT IF EXISTS "consultant_review_group_has_event";
-- SPLIT
ALTER TABLE "ConsultantReview" ADD CONSTRAINT "consultant_review_group_has_event"
  CHECK ("track" IS DISTINCT FROM 'GROUP' OR "ratingUnitId" IS NOT NULL);

-- SPLIT
-- #1562 — a REVIEW report acts on a review; without one CONTENT_REMOVED would
-- resolve the report and remove nothing.
ALTER TABLE "ModerationReport" DROP CONSTRAINT IF EXISTS "moderation_report_review_has_review";
-- SPLIT
ALTER TABLE "ModerationReport" ADD CONSTRAINT "moderation_report_review_has_review"
  CHECK ("type" IS DISTINCT FROM 'REVIEW' OR "reviewId" IS NOT NULL);

-- SPLIT
-- #1569 — one earning per (payment, consultant, role, occurrence). A whole-
-- purchase fee carries a NULL occurrence, and NULLS NOT DISTINCT (PG 15) keeps
-- that single row unique too. Replaces the Prisma @@unique on the first three.
-- #1766 — a subscription mints one row per cycle, told apart by cycleOrdinal;
-- every other row carries NULL there and stays a single row.
DROP INDEX IF EXISTS "consultant_earnings_occurrence_key";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "consultant_earnings_occurrence_key"
  ON "ConsultantEarnings" ("paymentId", "consultantProfileId", "role", "appointmentOccurrenceId", "cycleOrdinal") NULLS NOT DISTINCT;
-- SPLIT
-- #1580 — one live PRESENTER per plan. The invite transaction checks this too;
-- the partial uniques make a racing second presenter impossible to commit.
DROP INDEX IF EXISTS "collaborator_one_presenter_webinar";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "collaborator_one_presenter_webinar"
  ON "Collaborator" ("webinarPlanId")
  WHERE "tier" = 'PRESENTER' AND "status" IN ('PENDING', 'ACCEPTED');
-- SPLIT
DROP INDEX IF EXISTS "collaborator_one_presenter_class";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "collaborator_one_presenter_class"
  ON "Collaborator" ("classPlanId")
  WHERE "tier" = 'PRESENTER' AND "status" IN ('PENDING', 'ACCEPTED');
-- SPLIT
-- #1551 — a review revision is an append-only record of what the review said.
-- UPDATE never; DELETE only once the parent review row itself is gone (the
-- cascade), so history cannot be edited under a live review.
DROP TRIGGER IF EXISTS review_revision_immutable ON "ConsultantReviewRevision";
-- SPLIT
CREATE OR REPLACE FUNCTION assert_review_revision_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'ConsultantReviewRevision % is immutable', OLD."id";
  END IF;
  IF EXISTS (SELECT 1 FROM "ConsultantReview" WHERE "id" = OLD."reviewId") THEN
    RAISE EXCEPTION
      'ConsultantReviewRevision % cannot be deleted while review % exists',
      OLD."id", OLD."reviewId";
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;
-- SPLIT
CREATE TRIGGER review_revision_immutable
  BEFORE UPDATE OR DELETE ON "ConsultantReviewRevision"
  FOR EACH ROW
  EXECUTE FUNCTION assert_review_revision_immutable();

-- SPLIT
-- #1854 — UsageLedgerEntry is the append-only ledger the entitlement meters are
-- DERIVED from: `reverseBookingUtilization` computes "how much of this booking
-- has already been reversed" by summing its negative rows, and
-- reconcile-ledgers.ts asserts Σ engagementsConsumed against
-- ProgramAssignment.engagementsUsed nightly. Both are only true while the rows
-- cannot be edited. A DELETE (or an UPDATE) passed silently, and the next
-- reversal re-released a seat the org had already paid back.
--
-- Nothing in the codebase writes anything but `create` / `aggregate` on this
-- table (the forward and reverse paths both APPEND, which is what makes the
-- partial-reversal clamp work), so a raise trigger costs nothing — the same
-- argument, and the same shape, as ledger_entry_immutable in
-- ledger-triggers.sql.
--
-- NOT staged behind the banner below, unlike the CHECKs there: a trigger fires
-- on FUTURE writes and never scans existing rows, so it cannot fail to apply
-- against pre-reset data. Only a constraint that validates what is already in
-- the table needs the reset window.
DROP TRIGGER IF EXISTS usage_ledger_entry_immutable ON "UsageLedgerEntry";
-- SPLIT
CREATE OR REPLACE FUNCTION assert_usage_ledger_entry_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'UsageLedgerEntry % is immutable (% refused)', OLD."id", TG_OP;
END;
$$ LANGUAGE plpgsql;
-- SPLIT
CREATE TRIGGER usage_ledger_entry_immutable
  BEFORE UPDATE OR DELETE ON "UsageLedgerEntry"
  FOR EACH ROW
  EXECUTE FUNCTION assert_usage_ledger_entry_immutable();

-- SPLIT
-- BookingStatusHistory is append-only except retention deletes of rows older than
-- 3 years, which prune-audit-logs performs. A trigger never scans existing rows, so it ships live.
DROP TRIGGER IF EXISTS booking_status_history_immutable ON "BookingStatusHistory";
-- SPLIT
CREATE OR REPLACE FUNCTION assert_booking_status_history_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD."createdAt" < now() - interval '3 years' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'BookingStatusHistory % is immutable (% refused)', OLD."id", TG_OP;
END;
$$ LANGUAGE plpgsql;
-- SPLIT
-- UPDATE OF lists only the audit columns: the three FKs are ON DELETE SET NULL,
-- which Postgres runs as an UPDATE of the FK column and must not be refused.
CREATE TRIGGER booking_status_history_immutable
  BEFORE UPDATE OF "id", "entity", "entityId", "fromStatus", "toStatus", "reason", "createdAt"
  OR DELETE ON "BookingStatusHistory"
  FOR EACH ROW
  EXECUTE FUNCTION assert_booking_status_history_immutable();

-- SPLIT
-- ============================================================================
-- APPLIED AT THE PRE-MVP RESET (#1169 decision 8; #1554 uncommented them).
-- Each of these could fail against pre-reset data, so they shipped commented
-- until the reset gave them a clean schema.

-- 1. #1093 §3 — DEFERRED again at the #1554 reset rehearsal (2026-09-14). The
--    premise "writers mint since #1169 PR 9" is false: the seed (8b), the
--    overage side charge (lib/payments/billing/overage-settlement.ts) and the
--    approval payment (lib/payments/operations/approval-payment.ts) never write
--    Payment.clientIdempotencyKey, checkout writes `?? null`, and the Zod key
--    is optional. A sidecar NOT NULL also disagrees with the nullable Prisma
--    column, so the next `db push` would drop it. Do it as schema (`String
--    @unique`) once every writer mints a key — its own money PR.
--    ALTER TABLE "Payment" ALTER COLUMN "clientIdempotencyKey" SET NOT NULL;
--    ALTER TABLE "OrganizationPayout" ALTER COLUMN "idempotencyKey" SET NOT NULL;
-- 2. #1093 §5 — overlapping ACTIVE program assignments double-bill a seat; the
--    (programId, membershipId, periodStart) unique cannot see different starts:
ALTER TABLE "ProgramAssignment" DROP CONSTRAINT IF EXISTS "program_assignment_no_active_overlap";
-- SPLIT
ALTER TABLE "ProgramAssignment" ADD CONSTRAINT "program_assignment_no_active_overlap"
  EXCLUDE USING gist (
    "programId" WITH =,
    "membershipId" WITH =,
    tstzrange("periodStart", "periodEnd") WITH &&
  ) WHERE ("status" = 'ACTIVE');
-- SPLIT
-- 3. #1169 PR 1 residue — the denormalized session totals feed
--    calculateRequiredSlots as authoritative; incoherent values make plans
--    impossible to allocate ("Could only find N of M"):
ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT IF EXISTS "subscription_plan_total_sessions_min";
-- SPLIT
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "subscription_plan_total_sessions_min"
  CHECK ("totalSessions" >= 1);
-- SPLIT
ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_total_sessions_min";
-- SPLIT
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_total_sessions_min"
  CHECK ("totalSessions" >= 1);
-- SPLIT
-- 4. #1499 — "at most one ACTIVE cancellation policy per scope" and "one row per
--    (scope, version)". Postgres treats NULLs as distinct in a plain unique, so
--    the platform row (organizationId IS NULL) escapes the Prisma @@unique;
--    NULLS NOT DISTINCT closes that.
DROP INDEX IF EXISTS "cancellation_policy_one_active_per_scope";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "cancellation_policy_one_active_per_scope"
  ON "CancellationPolicy" ("organizationId") NULLS NOT DISTINCT
  WHERE "status" = 'ACTIVE';
-- SPLIT
DROP INDEX IF EXISTS "cancellation_policy_scope_version";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "cancellation_policy_scope_version"
  ON "CancellationPolicy" ("organizationId", "version") NULLS NOT DISTINCT;
-- 5. #1766 — STAGED for the next reset window (comment only; the column is
--    nullable so pre-#1766 rows keep resolving through plan.totalSessions).
--    Once every Subscription row carries its purchase-time entitlement:
--    ALTER TABLE "Subscription" ALTER COLUMN "sessionsTotal" SET NOT NULL;
--    ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_sessions_total_min"
--      CHECK ("sessionsTotal" >= 1);
-- ============================================================================

-- SPLIT
-- #1861 C1 — an Appointment's single parent FK must match its own
-- appointmentType; every writer already sets exactly one, so this is a
-- backstop against a future writer (or a direct write) mismatching the two.
-- TRIAL rows are parentless by design — the placeholder minted at request
-- time (app/api/trials/route.ts:429) and the free-trial appointment created
-- on accept (app/api/trials/[trialId]/route.ts:1276) both carry no parent
-- until conversion. ELSE FALSE means a new AppointmentsType enum value fails
-- this CHECK loudly instead of silently admitting an unmatched row; extend
-- the CASE here when one is added.
-- One live row (id starting `dfgfrgdfvsdv`) violates this; the owner deletes
-- it before running `db:sidecars`.
ALTER TABLE "Appointment" DROP CONSTRAINT IF EXISTS "appointment_parent_matches_type";
-- SPLIT
ALTER TABLE "Appointment" ADD CONSTRAINT "appointment_parent_matches_type"
  CHECK (CASE "appointmentType"
    WHEN 'CONSULTATION' THEN "consultationId" IS NOT NULL AND num_nonnulls("subscriptionId","webinarId","classId") = 0
    WHEN 'SUBSCRIPTION' THEN "subscriptionId" IS NOT NULL AND num_nonnulls("consultationId","webinarId","classId") = 0
    WHEN 'WEBINAR'      THEN "webinarId" IS NOT NULL      AND num_nonnulls("consultationId","subscriptionId","classId") = 0
    WHEN 'CLASS'        THEN "classId" IS NOT NULL        AND num_nonnulls("consultationId","subscriptionId","webinarId") = 0
    WHEN 'TRIAL'        THEN num_nonnulls("consultationId","subscriptionId","webinarId","classId") = 0
    ELSE FALSE END);
-- SPLIT
-- An SSO providerId is the slug in /api/auth/sso/callback/{providerId} and
-- shares a namespace with Account.providerId. A provider named after a
-- social or credential id would shadow that sign-in method and make
-- enforceSSO's "has an account with this provider" check trivially true.
-- The create route now generates ids itself (`oidc-<hex>`) and still
-- refuses these, so this is the backstop for any other writer. Keep the list
-- equal to RESERVED_PROVIDER_IDS in lib/sso/provider-schemas.ts;
-- __tests__/sso/provider-schemas.test.ts pins the two together.
ALTER TABLE "ssoProvider" DROP CONSTRAINT IF EXISTS "sso_provider_id_not_reserved";
-- SPLIT
ALTER TABLE "ssoProvider" ADD CONSTRAINT "sso_provider_id_not_reserved"
  CHECK (lower(btrim("providerId")) NOT IN ('credential', 'facebook', 'github', 'google', 'sso'));
-- SPLIT
-- D18 — the app reaches Postgres only as the owner role, through Prisma.
-- Supabase grants its PostgREST roles (anon, authenticated) full access to
-- public by default, and the anon key ships in the browser bundle, so without
-- this every table (sessions, accounts, verifications) is readable over the
-- Data API. Revoke, and stop future tables created by this role from being
-- granted. Skipped where the roles do not exist (local and CI Postgres).
-- Re-apply after every `prisma db push` (npm run db:sidecars).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon, authenticated;
  END IF;
END $$;
-- SPLIT
-- #1926 — Enforce at most one RUNNING SystemJobExecution row per jobName at a time
-- so concurrent callers (cron-tick.mts vs GitHub Actions) cannot both acquire the
-- same cron lock in the check-then-insert window. First sweep any pre-existing
-- older duplicate RUNNING rows so index creation is guaranteed to succeed.
WITH ranked_running AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "jobName"
      ORDER BY "startedAt" DESC, "id" DESC
    ) AS rn
  FROM "SystemJobExecution"
  WHERE "status" = 'RUNNING'
)
UPDATE "SystemJobExecution"
SET
  "status" = 'FAILED',
  "endedAt" = COALESCE("endedAt", NOW()),
  "errorLog" = COALESCE("errorLog", 'deduplicated stale RUNNING row before unique index')
WHERE "id" IN (SELECT "id" FROM ranked_running WHERE rn > 1);
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "SystemJobExecution_running_jobName_key"
  ON "SystemJobExecution" ("jobName")
  WHERE "status" = 'RUNNING';

-- SPLIT
-- A fee waiver is consumed by CAS on sessionsRemaining > 0; it never goes negative.
ALTER TABLE "ConsultantFeeWaiver" DROP CONSTRAINT IF EXISTS "consultant_fee_waiver_sessions_nonnegative";
-- SPLIT
ALTER TABLE "ConsultantFeeWaiver" ADD CONSTRAINT "consultant_fee_waiver_sessions_nonnegative"
  CHECK ("sessionsRemaining" >= 0);

-- SPLIT
-- A referral waiver names its referral; a founding waiver has none.
ALTER TABLE "ConsultantFeeWaiver" DROP CONSTRAINT IF EXISTS "consultant_fee_waiver_referral_matches_reason";
-- SPLIT
ALTER TABLE "ConsultantFeeWaiver" ADD CONSTRAINT "consultant_fee_waiver_referral_matches_reason"
  CHECK (("reason" = 'FOUNDING_EXPERT') = ("referralId" IS NULL));
-- SPLIT
-- One founding waiver per consultant; the admin grant maps the violation to a 409.
CREATE UNIQUE INDEX IF NOT EXISTS "consultant_fee_waiver_one_founding_key"
  ON "ConsultantFeeWaiver" ("consultantProfileId")
  WHERE "reason" = 'FOUNDING_EXPERT';

-- SPLIT
-- Take rates are basis points of the gross; own-link never exceeds marketplace, and the
-- proposer approves their own schedule only once it has stood 24 hours (sole-admin rule).
ALTER TABLE "PlatformFeeSchedule" DROP CONSTRAINT IF EXISTS "platform_fee_schedule_valid";
-- SPLIT
ALTER TABLE "PlatformFeeSchedule" ADD CONSTRAINT "platform_fee_schedule_valid"
  CHECK (
    "marketplaceBps" BETWEEN 0 AND 10000
    AND "ownLinkBps" BETWEEN 0 AND "marketplaceBps"
    AND (
      "checkerUserId" IS NULL
      OR "checkerUserId" <> "makerUserId"
      OR "approvedAt" >= "createdAt" + interval '24 hours'
    )
    AND (("checkerUserId" IS NULL) = ("approvedAt" IS NULL))
  );

-- SPLIT
ALTER TABLE "ReferralProgramConfig" DROP CONSTRAINT IF EXISTS "referral_program_config_ranges";
-- SPLIT
ALTER TABLE "ReferralProgramConfig" ADD CONSTRAINT "referral_program_config_ranges"
  CHECK (
    "discountBps" BETWEEN 0 AND 10000
    AND "redemptionCapBps" BETWEEN 0 AND 10000
    AND "monthlyBudgetPaise" >= 0
    AND "currentMonthSpentPaise" >= 0
    AND "referrerRewardPaise" >= 0
    AND "discountMaxPaise" >= 0
    AND "minOrderPaise" >= 0
    AND "perReferrerYearlyCapPaise" >= 0
    AND "creditExpiryDays" > 0
    AND "qualifyWindowDays" > 0
    AND "perCodeLifetimeCap" >= 0
    AND "weeklyVestCap" >= 0
    AND "expertYearlyReferralCap" >= 0
    AND "expertWaiverSessions" >= 0
    AND "expertWaiverDays" > 0
    AND "expertReferralBudgetPaise" >= 0
    AND "foundingWaiverSessions" >= 0
    AND "foundingWaiverDays" > 0
    AND "foundingExpertCap" >= 0
    AND ("holdSameIpReferrals" IS NULL OR "holdSameIpReferrals" >= 2)
    AND ("holdSameDeviceReferrals" IS NULL OR "holdSameDeviceReferrals" >= 2)
    AND ("holdWindowDays" IS NULL OR "holdWindowDays" > 0)
  );

-- SPLIT
-- Allowed keys mirror lib/stream/video-quality.ts.
ALTER TABLE "PlatformVideoConfig" DROP CONSTRAINT IF EXISTS "platform_video_config_values";
-- SPLIT
ALTER TABLE "PlatformVideoConfig" ADD CONSTRAINT "platform_video_config_values"
  CHECK (
    "callTargetResolution" IN ('480p', '720p', '1080p')
    AND "recordingQuality" IN ('720p', '1080p')
    AND "screenshareTargetResolution" IN ('720p', '1080p')
  );

-- SPLIT
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_platform_fee_bps_range";
-- SPLIT
ALTER TABLE "Payment" ADD CONSTRAINT "payment_platform_fee_bps_range"
  CHECK ("platformFeeBps" IS NULL OR "platformFeeBps" BETWEEN 0 AND 10000);

-- SPLIT
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_welcome_discount_positive";
-- SPLIT
ALTER TABLE "Payment" ADD CONSTRAINT "payment_welcome_discount_positive"
  CHECK ("welcomeDiscountPaise" IS NULL OR "welcomeDiscountPaise" > 0);

-- SPLIT
-- At most one live welcome-discounted order per buyer; a second checkout must finish or abandon the first.
CREATE UNIQUE INDEX IF NOT EXISTS "Payment_live_welcome_discount_user_key"
  ON "Payment" ("userId")
  WHERE "welcomeDiscountPaise" IS NOT NULL
    AND "referralReleasedAt" IS NULL
    AND "paymentStatus" IN ('PENDING', 'SUCCEEDED')
    AND "deletedAt" IS NULL;

-- SPLIT
-- Multiple organizations may register an unverified claim for the same domain,
-- but at most one organization can hold a verified claim on a domain at a time.
DROP INDEX IF EXISTS "org_domain_claims_verified_domain_key";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "org_domain_claims_verified_domain_key"
  ON "org_domain_claims" ("domain")
  WHERE "verifiedAt" IS NOT NULL;

-- SPLIT
-- At most one ACTIVE contract per BillingAccount so active billing-term lookups
-- never face ambiguous active contracts.
DROP INDEX IF EXISTS "contract_one_active_per_billing_account_idx";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "contract_one_active_per_billing_account_idx"
  ON "Contract" ("billingAccountId")
  WHERE "status" = 'ACTIVE';

-- SPLIT
-- One OrganizationEarnings split row per (payment, organization, consultant,
-- role, subscription cycle tranche). NULLS NOT DISTINCT ensures single-session
-- and legacy rows with NULL consultantProfileId or cycleOrdinal still collide.
DROP INDEX IF EXISTS "organization_earnings_split_key";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "organization_earnings_split_key"
  ON "OrganizationEarnings" ("paymentId", "organizationId", "consultantProfileId", "role", "cycleOrdinal")
  NULLS NOT DISTINCT;

-- SPLIT
-- CreditPoolConfig pricing and budget bounds (parity with licensed_seat_config_pricing_sane).
ALTER TABLE "CreditPoolConfig" DROP CONSTRAINT IF EXISTS "credit_pool_config_pricing_sane";
-- SPLIT
ALTER TABLE "CreditPoolConfig" ADD CONSTRAINT "credit_pool_config_pricing_sane"
  CHECK (
    "creditBudgetPerCycle" > 0
    AND ("overageSurchargeBps" IS NULL OR ("overageSurchargeBps" >= 0 AND "overageSurchargeBps" <= 10000))
    AND ("maxOveragePerCyclePaise" IS NULL OR "maxOveragePerCyclePaise" > 0)
    AND ("priceCapPerEngagementPaise" IS NULL OR "priceCapPerEngagementPaise" > 0)
  );


-- SPLIT
-- Org recording-retention cap: NULL follows the platform schedule; a set cap stays inside the PATCH route's 7..3650 range.
ALTER TABLE "organizations" DROP CONSTRAINT IF EXISTS "org_stream_recording_retention_days_range";
-- SPLIT
ALTER TABLE "organizations" ADD CONSTRAINT "org_stream_recording_retention_days_range"
  CHECK ("streamRecordingRetentionDays" IS NULL OR "streamRecordingRetentionDays" BETWEEN 7 AND 3650);

-- SPLIT
-- Enforce mutual exclusivity between `processed` and `error` and require `processedAt` iff `processed`.
DO $$
BEGIN
  UPDATE "WebhookEvent"
  SET "processed" = false, "processedAt" = NULL
  WHERE "processed" AND "error" IS NOT NULL;

  UPDATE "WebhookEvent"
  SET "processedAt" = CASE WHEN "processed" THEN COALESCE("processedAt", "receivedAt") ELSE NULL END
  WHERE ("processed" IS TRUE) IS DISTINCT FROM ("processedAt" IS NOT NULL);

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_event_processed_error_exclusive'
  ) THEN
    ALTER TABLE "WebhookEvent" ADD CONSTRAINT "webhook_event_processed_error_exclusive"
      CHECK (NOT ("processed" AND "error" IS NOT NULL));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'webhook_event_processed_timestamp_consistent'
  ) THEN
    ALTER TABLE "WebhookEvent" ADD CONSTRAINT "webhook_event_processed_timestamp_consistent"
      CHECK (("processed" IS TRUE) IS NOT DISTINCT FROM ("processedAt" IS NOT NULL));
  END IF;

  WITH ranked_recordings AS (
    SELECT
      "id",
      ROW_NUMBER() OVER (
        PARTITION BY "streamRecordingId"
        ORDER BY
          ("status" = 'READY') DESC,
          "updatedAt" DESC NULLS LAST,
          "createdAt" DESC NULLS LAST,
          "id" DESC
      ) AS rn
    FROM "Recording"
    WHERE "streamRecordingId" IS NOT NULL
  )
  UPDATE "Recording"
  SET "streamRecordingId" = NULL
  WHERE "id" IN (SELECT "id" FROM ranked_recordings WHERE rn > 1);
END $$;

-- SPLIT
CREATE INDEX IF NOT EXISTS "WebhookEvent_unprocessed_provider_receivedAt_idx"
  ON "WebhookEvent" ("provider", "receivedAt")
  WHERE NOT "processed";

-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "Recording_streamRecordingId_unique_idx"
  ON "Recording" ("streamRecordingId")
  WHERE "streamRecordingId" IS NOT NULL;

-- SPLIT
-- Open cases deduplicate within their ownership, organization, subject and submitting party.
DROP INDEX IF EXISTS "support_case_open_scope_key";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "support_case_open_scope_key"
  ON "SupportCase" ("ownershipScope", "organizationId", "scopeKey", "requesterUserId", "submitterUserId", "category")
  NULLS NOT DISTINCT
  WHERE "closedAt" IS NULL AND "deletedAt" IS NULL;

-- SPLIT
-- At most one primary subject row per SupportCase.
DROP INDEX IF EXISTS "support_case_subject_primary_key";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "support_case_subject_primary_key"
  ON "SupportCaseSubject" ("caseId")
  WHERE "isPrimary" = true;

-- SPLIT
-- A SupportCase must carry at least a category or a flowKey, an occurrence requires an appointment,
-- problem links remain strictly one level deep, and CSAT scores stay between 1 and 5.
ALTER TABLE "SupportCase" DROP CONSTRAINT IF EXISTS "support_case_scope_and_shape_chk";
-- SPLIT
ALTER TABLE "SupportCase" ADD CONSTRAINT "support_case_scope_and_shape_chk"
  CHECK (
    ("category" IS NOT NULL OR "flowKey" IS NOT NULL)
    AND ("appointmentOccurrenceId" IS NULL OR "appointmentId" IS NOT NULL)
    AND ("problemCaseId" IS NULL OR "caseKind" = 'INCIDENT')
    AND ("csatRating" IS NULL OR ("csatRating" BETWEEN 1 AND 5))
  );

-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "AppointmentDocument_active_storagePath_key"
  ON "AppointmentDocument" ("storagePath")
  WHERE "deletedAt" IS NULL;

-- SPLIT
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'AppointmentDocument_fileSize_positive_check') THEN
    ALTER TABLE "AppointmentDocument"
      ADD CONSTRAINT "AppointmentDocument_fileSize_positive_check"
      CHECK ("fileSize" > 0 AND "versionNo" >= 1);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'PlanMaterial_single_plan_fk_check') THEN
    ALTER TABLE "PlanMaterial"
      ADD CONSTRAINT "PlanMaterial_single_plan_fk_check"
      CHECK (num_nonnulls("consultationPlanId", "subscriptionPlanId", "webinarPlanId", "classPlanId") = 1 AND "fileSize" > 0);
  END IF;
END $$;

-- SPLIT
-- Recording storage and marketplace listing invariants:
-- Active PLATFORM rows require a storagePath; AVAILABLE rows require PLATFORM
-- storage + storagePath; PUBLISHED listings require PLATFORM storage, storagePath,
-- positive listPricePaise, and explicit consent attestation.
ALTER TABLE "Recording" DROP CONSTRAINT IF EXISTS "Recording_storage_and_publish_check";
-- SPLIT
ALTER TABLE "Recording" ADD CONSTRAINT "Recording_storage_and_publish_check"
  CHECK (
    (
      "storageType" = 'PLATFORM'
      AND ("status" = 'EXPIRED' OR "storagePath" IS NOT NULL)
      AND (
        "listingStatus" <> 'PUBLISHED'
        OR (
          "storagePath" IS NOT NULL
          AND "listPricePaise" IS NOT NULL
          AND "listPricePaise" > 0
          AND "consentAttestedAt" IS NOT NULL
          AND "consentAttestedById" IS NOT NULL
        )
      )
    )
    OR (
      "storageType" <> 'PLATFORM'
      AND "status" <> 'AVAILABLE'
      AND "listingStatus" <> 'PUBLISHED'
    )
  ) NOT VALID;
-- SPLIT
ALTER TABLE "Recording" VALIDATE CONSTRAINT "Recording_storage_and_publish_check";

-- SPLIT
-- Partial indexes backing active outbox relay scans and the 7-day SENT body scrub sweep.
CREATE INDEX IF NOT EXISTS "FailedEmail_active_outbox_idx"
  ON "FailedEmail" ("nextRetryAt" ASC NULLS FIRST)
  WHERE "status" IN ('PENDING', 'RETRY');
-- SPLIT
CREATE INDEX IF NOT EXISTS "FailedEmail_sent_unscrubbed_updatedAt_idx"
  ON "FailedEmail" ("updatedAt")
  WHERE "status" = 'SENT' AND ("htmlBody" <> '' OR "textBody" IS NOT NULL);
-- SPLIT
CREATE INDEX IF NOT EXISTS "FailedEmailBatch_active_outbox_idx"
  ON "FailedEmailBatch" ("nextRetryAt" ASC NULLS FIRST)
  WHERE "status" IN ('PENDING', 'RETRY');
-- SPLIT
CREATE INDEX IF NOT EXISTS "NotificationOutbox_active_outbox_idx"
  ON "NotificationOutbox" ("nextRetryAt" ASC NULLS FIRST, "notBefore")
  WHERE "status" IN ('PENDING', 'RETRY');

-- SPLIT
-- A stamped refund-owed amount is positive; NULL means the full remaining balance.
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_refund_owed_paise_positive";
-- SPLIT
ALTER TABLE "Payment" ADD CONSTRAINT "payment_refund_owed_paise_positive"
  CHECK ("refundOwedPaise" IS NULL OR "refundOwedPaise" > 0);

-- SPLIT
-- 194-O: one threshold catch-up per expert per financial year among live payouts; a
-- catch-up belongs to the payout's own TDS year, and a credit back is never negative.
ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_tds_threshold_sane";
-- SPLIT
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_tds_threshold_sane"
  CHECK (
    "tdsCreditPaise" >= 0
    AND ("tdsCatchUpFy" IS NULL OR "tdsCatchUpFy" = "tdsFinancialYear")
  );
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "consultant_payout_one_tds_catch_up_per_fy"
  ON "ConsultantPayout" ("consultantProfileId", "tdsCatchUpFy")
  WHERE "tdsCatchUpFy" IS NOT NULL
    AND "status" IN ('PROCESSING', 'COMPLETED');

-- SPLIT
-- A subscription returns at most two sessions to its plan.
ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "subscription_sessions_returned_range";
-- SPLIT
ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_sessions_returned_range"
  CHECK ("sessionsReturned" BETWEEN 0 AND 2);
-- SPLIT
-- A weeks plan runs 1..52 weeks; null keeps the months length.
ALTER TABLE "SubscriptionPlan" DROP CONSTRAINT IF EXISTS "subscription_plan_weeks_range";
-- SPLIT
ALTER TABLE "SubscriptionPlan" ADD CONSTRAINT "subscription_plan_weeks_range"
  CHECK ("durationInWeeks" IS NULL OR "durationInWeeks" BETWEEN 1 AND 52);
-- SPLIT
-- A support partial refund removes at most the sessions the plan sold.
ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "subscription_sessions_refunded_range";
-- SPLIT
ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_sessions_refunded_range"
  CHECK ("sessionsRefunded" >= 0
    AND ("sessionsTotal" IS NULL OR "sessionsRefunded" <= "sessionsTotal"));
-- SPLIT
-- A session-count remedy removes at least one session.
ALTER TABLE "SupportFinancialRecommendation" DROP CONSTRAINT IF EXISTS "support_recommendation_sessions_removed_min";
-- SPLIT
ALTER TABLE "SupportFinancialRecommendation" ADD CONSTRAINT "support_recommendation_sessions_removed_min"
  CHECK ("sessionsRemoved" IS NULL OR "sessionsRemoved" >= 1);
-- SPLIT
-- Frozen purchase terms are positive when stamped.
ALTER TABLE "Subscription" DROP CONSTRAINT IF EXISTS "subscription_frozen_terms_positive";
-- SPLIT
ALTER TABLE "Subscription" ADD CONSTRAINT "subscription_frozen_terms_positive"
  CHECK (("sessionsPerWeek" IS NULL OR "sessionsPerWeek" >= 1)
    AND ("sessionMinutes" IS NULL OR "sessionMinutes" >= 1));
-- SPLIT
-- A Regular-time slot is an ISO weekday and a minute of the local day.
ALTER TABLE "RegularTime" DROP CONSTRAINT IF EXISTS "regular_time_ranges";
-- SPLIT
ALTER TABLE "RegularTime" ADD CONSTRAINT "regular_time_ranges"
  CHECK ("weekday" BETWEEN 1 AND 7 AND "localStartMinutes" BETWEEN 0 AND 1439);
-- SPLIT
-- One live row per plan slot; superseded rows keep their validUntil as history.
DROP INDEX IF EXISTS "regular_time_one_live_slot";
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "regular_time_one_live_slot"
  ON "RegularTime" ("subscriptionId", "weekday", "localStartMinutes")
  WHERE "validUntil" IS NULL;
-- SPLIT
-- An open plan-end choice has no decision; every other status has one.
ALTER TABLE "PlanEndChoice" DROP CONSTRAINT IF EXISTS "plan_end_choice_shape";
-- SPLIT
ALTER TABLE "PlanEndChoice" ADD CONSTRAINT "plan_end_choice_shape"
  CHECK (("status" = 'OFFERED' AND "decidedAt" IS NULL)
    OR ("status" <> 'OFFERED' AND "decidedAt" IS NOT NULL));
-- SPLIT
-- An extension adds 1..4 weeks and remembers the plan end it replaced.
ALTER TABLE "PlanEndChoice" DROP CONSTRAINT IF EXISTS "plan_end_choice_extended";
-- SPLIT
ALTER TABLE "PlanEndChoice" ADD CONSTRAINT "plan_end_choice_extended"
  CHECK ("status" NOT IN ('EXTENDED', 'EXPERT_DECLINED')
    OR ("extraWeeksOffered" IS NOT NULL
      AND "extraWeeksOffered" BETWEEN 1 AND 4
      AND "previousPlanEndsAt" IS NOT NULL));
-- SPLIT
-- A declared platform incident is a real window.
ALTER TABLE "PlatformIncident" DROP CONSTRAINT IF EXISTS "platform_incident_time_order";
-- SPLIT
ALTER TABLE "PlatformIncident" ADD CONSTRAINT "platform_incident_time_order"
  CHECK ("endsAt" > "startsAt");
-- SPLIT
-- One OverageEvent per metered batch: the batch key is the over-cap batch's
-- UsageLedgerEntry id. Rows written before the key keep NULL.
ALTER TABLE "OverageEvent" ADD COLUMN IF NOT EXISTS "batchKey" TEXT;
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "OverageEvent_bookingUtilizationId_batchKey_key"
  ON "OverageEvent" ("bookingUtilizationId", "batchKey");
-- SPLIT
DROP INDEX IF EXISTS "OverageEvent_bookingUtilizationId_key";
-- SPLIT
-- An EarningsHold freezes exactly one earning, consultant or organisation.
ALTER TABLE "EarningsHold" DROP CONSTRAINT IF EXISTS "earnings_hold_one_earning";
-- SPLIT
ALTER TABLE "EarningsHold" ADD CONSTRAINT "earnings_hold_one_earning"
  CHECK (num_nonnulls("consultantEarningsId", "organizationEarningsId") = 1);
-- SPLIT
-- One active hold per (earning, reason, source); a released hold keeps its row.
CREATE UNIQUE INDEX IF NOT EXISTS "earnings_hold_active_consultant_key"
  ON "EarningsHold" ("consultantEarningsId", "reason", "sourceRef")
  WHERE "releasedAt" IS NULL AND "consultantEarningsId" IS NOT NULL;
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "earnings_hold_active_org_key"
  ON "EarningsHold" ("organizationEarningsId", "reason", "sourceRef")
  WHERE "releasedAt" IS NULL AND "organizationEarningsId" IS NOT NULL;
-- SPLIT
-- I-4: a BATCHED earning always names the payout that batched it.
ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_batched_has_payout";
-- SPLIT
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_batched_has_payout"
  CHECK ("status" <> 'BATCHED' OR "payoutId" IS NOT NULL);
-- SPLIT
ALTER TABLE "OrganizationEarnings" DROP CONSTRAINT IF EXISTS "org_earnings_batched_has_payout";
-- SPLIT
ALTER TABLE "OrganizationEarnings" ADD CONSTRAINT "org_earnings_batched_has_payout"
  CHECK ("status" <> 'BATCHED' OR "orgPayoutId" IS NOT NULL);
-- SPLIT
-- Settlement is INR-only: every ledger account and money row carries INR.
ALTER TABLE "LedgerAccount" DROP CONSTRAINT IF EXISTS "ledger_account_currency_inr";
-- SPLIT
ALTER TABLE "LedgerAccount" ADD CONSTRAINT "ledger_account_currency_inr" CHECK ("currency" = 'INR');
-- SPLIT
ALTER TABLE "Payment" DROP CONSTRAINT IF EXISTS "payment_currency_inr";
-- SPLIT
ALTER TABLE "Payment" ADD CONSTRAINT "payment_currency_inr" CHECK ("currency" = 'INR');
-- SPLIT
ALTER TABLE "Refund" DROP CONSTRAINT IF EXISTS "refund_currency_inr";
-- SPLIT
ALTER TABLE "Refund" ADD CONSTRAINT "refund_currency_inr" CHECK ("currency" = 'INR');
-- SPLIT
ALTER TABLE "Dispute" DROP CONSTRAINT IF EXISTS "dispute_currency_inr";
-- SPLIT
ALTER TABLE "Dispute" ADD CONSTRAINT "dispute_currency_inr" CHECK ("currency" = 'INR');
-- SPLIT
ALTER TABLE "ConsultantEarnings" DROP CONSTRAINT IF EXISTS "consultant_earnings_currency_inr";
-- SPLIT
ALTER TABLE "ConsultantEarnings" ADD CONSTRAINT "consultant_earnings_currency_inr" CHECK ("currency" = 'INR');
-- SPLIT
ALTER TABLE "ConsultantPayout" DROP CONSTRAINT IF EXISTS "consultant_payout_currency_inr";
-- SPLIT
ALTER TABLE "ConsultantPayout" ADD CONSTRAINT "consultant_payout_currency_inr" CHECK ("currency" = 'INR');
-- SPLIT
-- One open second-approval proposal per (action, target); decided rows keep theirs.
CREATE UNIQUE INDEX IF NOT EXISTS "ops_action_proposal_one_open_key"
  ON "ops_action_proposals" ("action", "targetKind", "targetId")
  WHERE "status" = 'PROPOSED';
-- SPLIT
CREATE UNIQUE INDEX IF NOT EXISTS "moderation_report_reporter_open_content_key"
  ON "ModerationReport" ("reportedById", "targetUserId", "type", "reviewId", "streamMessageId")
  NULLS NOT DISTINCT
  WHERE "status" IN ('PENDING', 'UNDER_REVIEW', 'ESCALATED');

-- SPLIT
ALTER TABLE "SupportCase" DROP CONSTRAINT IF EXISTS "support_case_ownership_and_appeal_shape";
-- SPLIT
ALTER TABLE "SupportCase" ADD CONSTRAINT "support_case_ownership_and_appeal_shape"
  CHECK (("ownershipScope" = 'PERSONAL' OR "organizationId" IS NOT NULL)
    AND num_nonnulls("appealOfDecisionId", "appealOfModerationActionId") <= 1);

-- SPLIT
ALTER TABLE "SupportCaseAttachment" DROP CONSTRAINT IF EXISTS "support_case_attachment_shape";
-- SPLIT
ALTER TABLE "SupportCaseAttachment" ADD CONSTRAINT "support_case_attachment_shape"
  CHECK (num_nonnulls("messageId", "evidenceRequestId") <= 1 AND "fileSize" >= 0);

-- SPLIT
ALTER TABLE "SupportFinancialRecommendation" DROP CONSTRAINT IF EXISTS "support_recommendation_shape";
-- SPLIT
ALTER TABLE "SupportFinancialRecommendation" ADD CONSTRAINT "support_recommendation_shape"
  CHECK ("amountPaise" >= 0 AND (("decidedAt" IS NULL AND "approved" IS NULL AND "decidedById" IS NULL)
    OR ("decidedAt" IS NOT NULL AND "approved" IS NOT NULL AND "decidedById" IS NOT NULL))
    AND (("voidedAt" IS NULL AND "voidedById" IS NULL)
      OR ("voidedAt" IS NOT NULL AND "voidedById" IS NOT NULL AND "decidedAt" IS NOT NULL AND NOT "approved")));

-- SPLIT
-- One undecided support refund recommendation per payment.
CREATE UNIQUE INDEX IF NOT EXISTS "support_recommendation_one_open_per_payment"
  ON "SupportFinancialRecommendation" ("paymentId") WHERE "decidedAt" IS NULL;

-- SPLIT
CREATE OR REPLACE FUNCTION assert_support_decision_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Case decisions are immutable; append a new decision instead';
END;
$$ LANGUAGE plpgsql;
-- SPLIT
DROP TRIGGER IF EXISTS support_case_decision_immutable ON "SupportCaseDecision";
-- SPLIT
CREATE TRIGGER support_case_decision_immutable
  BEFORE UPDATE OR DELETE ON "SupportCaseDecision"
  FOR EACH ROW EXECUTE FUNCTION assert_support_decision_immutable();

-- SPLIT
-- One original decision per case; every later decision supersedes exactly one other.
CREATE UNIQUE INDEX IF NOT EXISTS "support_decision_one_original_per_case"
  ON "SupportCaseDecision" ("caseId") WHERE "supersedesDecisionId" IS NULL;

-- SPLIT
-- Keeps the post-closure evidence purge scan cheap as closed cases accumulate.
CREATE INDEX IF NOT EXISTS "support_case_closed_at_idx"
  ON "SupportCase" ("closedAt") WHERE "closedAt" IS NOT NULL;

-- SPLIT
ALTER TABLE "SupportCaseChatAccess" DROP CONSTRAINT IF EXISTS "support_chat_access_shape";
-- SPLIT
-- An ended grant names why; only an intervention touches Stream membership; OPEN_CASE never justifies an intervention.
ALTER TABLE "SupportCaseChatAccess" ADD CONSTRAINT "support_chat_access_shape"
  CHECK (("endedAt" IS NULL) = ("endReason" IS NULL)
    AND "expiresAt" > "createdAt"
    AND cardinality("scopeUserIds") >= 1
    AND ("kind" = 'INTERVENE' OR ("streamJoinedAt" IS NULL AND "streamLeftAt" IS NULL))
    AND ("streamLeftAt" IS NULL OR ("streamJoinedAt" IS NOT NULL AND "streamLeftAt" >= "streamJoinedAt"))
    AND ("reviewNoticeAt" IS NULL OR "endedAt" IS NOT NULL)
    AND ("kind" = 'READ' OR "basis" <> 'OPEN_CASE'));

-- SPLIT
-- One Familiarise Support seat per channel across all cases.
CREATE UNIQUE INDEX IF NOT EXISTS "support_chat_one_live_intervention_per_channel"
  ON "SupportCaseChatAccess" ("channelType", "channelId") WHERE "kind" = 'INTERVENE' AND "endedAt" IS NULL;

-- SPLIT
-- One live read grant per operator per case.
CREATE UNIQUE INDEX IF NOT EXISTS "support_chat_one_live_read_per_operator"
  ON "SupportCaseChatAccess" ("caseId", "grantedById") WHERE "kind" = 'READ' AND "endedAt" IS NULL;

-- SPLIT
-- Keeps the SLA-sweep expiry, Stream-leave and review-notice scans cheap.
CREATE INDEX IF NOT EXISTS "support_chat_access_live_expiry_idx"
  ON "SupportCaseChatAccess" ("expiresAt") WHERE "endedAt" IS NULL;
-- SPLIT
CREATE INDEX IF NOT EXISTS "support_chat_access_pending_leave_idx"
  ON "SupportCaseChatAccess" ("endedAt")
  WHERE "kind" = 'INTERVENE' AND "streamJoinedAt" IS NOT NULL AND "streamLeftAt" IS NULL;
-- SPLIT
CREATE INDEX IF NOT EXISTS "support_chat_access_pending_notice_idx"
  ON "SupportCaseChatAccess" ("caseId") WHERE "endedAt" IS NOT NULL AND "reviewNoticeAt" IS NULL;

-- SPLIT
-- The access log is append-only: only the end, Stream and notice stamps may be set, once each.
CREATE OR REPLACE FUNCTION assert_support_chat_access_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Chat access grants are an access log and cannot be deleted'; END IF;
  IF (NEW."caseId", NEW."kind", NEW."basis", NEW."grantedById", NEW."opsActionId", NEW."channelType", NEW."channelId",
      NEW."scopeUserIds", NEW."windowStart", NEW."organizationIds", NEW."withholdNotice", NEW."expiresAt", NEW."createdAt")
     IS DISTINCT FROM
     (OLD."caseId", OLD."kind", OLD."basis", OLD."grantedById", OLD."opsActionId", OLD."channelType", OLD."channelId",
      OLD."scopeUserIds", OLD."windowStart", OLD."organizationIds", OLD."withholdNotice", OLD."expiresAt", OLD."createdAt")
     OR (OLD."endedAt" IS NOT NULL AND (NEW."endedAt", NEW."endedById", NEW."endReason")
       IS DISTINCT FROM (OLD."endedAt", OLD."endedById", OLD."endReason"))
     OR (OLD."streamJoinedAt" IS NOT NULL AND NEW."streamJoinedAt" IS DISTINCT FROM OLD."streamJoinedAt")
     OR (OLD."streamLeftAt" IS NOT NULL AND NEW."streamLeftAt" IS DISTINCT FROM OLD."streamLeftAt")
     OR (OLD."reviewNoticeAt" IS NOT NULL AND NEW."reviewNoticeAt" IS DISTINCT FROM OLD."reviewNoticeAt") THEN
    RAISE EXCEPTION 'Chat access grants only gain end, Stream and notice stamps';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
-- SPLIT
DROP TRIGGER IF EXISTS support_chat_access_append_only ON "SupportCaseChatAccess";
-- SPLIT
CREATE TRIGGER support_chat_access_append_only
  BEFORE UPDATE OR DELETE ON "SupportCaseChatAccess"
  FOR EACH ROW EXECUTE FUNCTION assert_support_chat_access_append_only();

-- SPLIT
-- An erasure retry reads its user from the request; every other revocation kind names the user itself.
ALTER TABLE "StreamRevocationRetry" DROP CONSTRAINT IF EXISTS "stream_revocation_retry_owner";
-- SPLIT
ALTER TABLE "StreamRevocationRetry" ADD CONSTRAINT "stream_revocation_retry_owner"
  CHECK (("kind" = 'ERASURE_REVOKE') = ("erasureRequestId" IS NOT NULL)
    AND ("erasureRequestId" IS NOT NULL OR "userId" IS NOT NULL)
    AND ("kind" = 'DM_REMOVE') = ("counterpartUserId" IS NOT NULL));
-- SPLIT
-- One open retry per revocation target; a settled row frees the key for the next revocation.
CREATE UNIQUE INDEX IF NOT EXISTS "stream_revocation_retry_open_key"
  ON "StreamRevocationRetry" ("kind", "planId", "userId")
  WHERE "erasureRequestId" IS NULL AND "status" <> 'SUCCEEDED';
-- SPLIT
-- Meeting.endedReason holds only MEETING_END_REASONS (lib/meetings/end-reasons.ts); NOT VALID skips the scan, so VALIDATE separately.
-- Before VALIDATE, confirm SELECT DISTINCT "endedReason" FROM "Meeting" returns only these values or NULL.
ALTER TABLE "Meeting"
  DROP CONSTRAINT IF EXISTS "meeting_ended_reason_known",
  ADD CONSTRAINT "meeting_ended_reason_known"
    CHECK (
      "endedReason" IS NULL
      OR "endedReason" IN (
        'call_ended', 'maintenance', 'org_deactivated', 'org_deleted',
        'session_timeout', 'ended_early', 'stream_ended',
        'reconciled', 'reconciled_no_end', 'stream_not_found', 'stream_not_configured'
      )
    ) NOT VALID;
-- SPLIT
ALTER TABLE "Meeting" VALIDATE CONSTRAINT "meeting_ended_reason_known";
-- SPLIT
-- One open admin run request per job; a settled request frees the job for the next one.
CREATE UNIQUE INDEX IF NOT EXISTS "admin_run_request_one_open_key"
  ON "AdminRunRequest" ("job")
  WHERE "status" IN ('REQUESTED', 'CLAIMED');
-- SPLIT
-- A claimed request carries its claim time and a settled one its finish time.
ALTER TABLE "AdminRunRequest" DROP CONSTRAINT IF EXISTS "admin_run_request_state";
-- SPLIT
ALTER TABLE "AdminRunRequest" ADD CONSTRAINT "admin_run_request_state"
  CHECK ("attempts" >= 0
    AND ("status" <> 'CLAIMED' OR "claimedAt" IS NOT NULL)
    AND ("status" NOT IN ('DONE', 'FAILED') OR "finishedAt" IS NOT NULL));
-- SPLIT
-- One live entitlement per buyer and product; failed and refunded attempts stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS "digital_product_purchase_succeeded_key"
  ON "DigitalProductPurchase" ("productId", "buyerId")
  WHERE "status" = 'SUCCEEDED';
-- SPLIT
-- Free, or at least Razorpay's ₹1 order floor (DIGITAL_PRODUCT_MIN_PAID_PRICE_PAISE).
ALTER TABLE "DigitalProduct" DROP CONSTRAINT IF EXISTS "digital_product_price_nonnegative";
-- SPLIT
ALTER TABLE "DigitalProduct" DROP CONSTRAINT IF EXISTS "digital_product_price_free_or_min_paid";
-- SPLIT
ALTER TABLE "DigitalProduct" ADD CONSTRAINT "digital_product_price_free_or_min_paid"
  CHECK ("pricePaise" = 0 OR "pricePaise" >= 100);
-- SPLIT
-- A free claim has no gateway order and a paid purchase always has one.
ALTER TABLE "DigitalProductPurchase" DROP CONSTRAINT IF EXISTS "digital_product_purchase_free_has_no_order";
-- SPLIT
ALTER TABLE "DigitalProductPurchase" ADD CONSTRAINT "digital_product_purchase_free_has_no_order"
  CHECK ("amountPaise" >= 0 AND ("amountPaise" = 0) = ("gatewayOrderId" IS NULL));
-- SPLIT
-- 250 MB per file (DIGITAL_PRODUCT_MAX_FILE_BYTES in lib/digital-products/constants.ts).
ALTER TABLE "DigitalProductAsset" DROP CONSTRAINT IF EXISTS "digital_product_asset_size_cap";
-- SPLIT
ALTER TABLE "DigitalProductAsset" ADD CONSTRAINT "digital_product_asset_size_cap"
  CHECK ("sizeBytes" >= 0 AND "sizeBytes" <= 262144000);
-- SPLIT
-- At most one current version per file lineage; verification retires the old one first.
CREATE UNIQUE INDEX IF NOT EXISTS "digital_product_asset_one_verified_per_lineage"
  ON "DigitalProductAsset" ("lineageId")
  WHERE "status" = 'VERIFIED';
-- SPLIT
-- Notify-me rows exist only for group events; NOTIFIED and BOOKED carry their timestamps.
ALTER TABLE "AppointmentWaitlist" DROP CONSTRAINT IF EXISTS "appointment_waitlist_plan_kind_chk";
-- SPLIT
ALTER TABLE "AppointmentWaitlist" ADD CONSTRAINT "appointment_waitlist_plan_kind_chk"
  CHECK ("planKind" IN ('WEBINAR', 'CLASS'));
-- SPLIT
ALTER TABLE "AppointmentWaitlist" DROP CONSTRAINT IF EXISTS "appointment_waitlist_notified_at_chk";
-- SPLIT
ALTER TABLE "AppointmentWaitlist" ADD CONSTRAINT "appointment_waitlist_notified_at_chk"
  CHECK ("status" <> 'NOTIFIED' OR "notifiedAt" IS NOT NULL);
-- SPLIT
ALTER TABLE "AppointmentWaitlist" DROP CONSTRAINT IF EXISTS "appointment_waitlist_booked_at_chk";
-- SPLIT
ALTER TABLE "AppointmentWaitlist" ADD CONSTRAINT "appointment_waitlist_booked_at_chk"
  CHECK ("status" <> 'BOOKED' OR "bookedAt" IS NOT NULL);
-- SPLIT
-- NULL means the 200-seat ceiling; the upper bound is enforced in Zod like maxParticipants.
ALTER TABLE "WebinarPlan" DROP CONSTRAINT IF EXISTS "webinar_plan_waitlist_max_min";
-- SPLIT
ALTER TABLE "WebinarPlan" ADD CONSTRAINT "webinar_plan_waitlist_max_min"
  CHECK ("waitlistMax" IS NULL OR "waitlistMax" >= 1);
-- SPLIT
ALTER TABLE "ClassPlan" DROP CONSTRAINT IF EXISTS "class_plan_waitlist_max_min";
-- SPLIT
ALTER TABLE "ClassPlan" ADD CONSTRAINT "class_plan_waitlist_max_min"
  CHECK ("waitlistMax" IS NULL OR "waitlistMax" >= 1);
-- SPLIT
-- The price a 1:1 or a trial was agreed at is never negative.
ALTER TABLE "Consultation" DROP CONSTRAINT IF EXISTS "consultation_agreed_price_valid";
-- SPLIT
ALTER TABLE "Consultation" ADD CONSTRAINT "consultation_agreed_price_valid"
  CHECK ("agreedPricePaise" IS NULL OR "agreedPricePaise" >= 0);
-- SPLIT
ALTER TABLE "Trial" DROP CONSTRAINT IF EXISTS "trial_agreed_price_valid";
-- SPLIT
ALTER TABLE "Trial" ADD CONSTRAINT "trial_agreed_price_valid"
  CHECK ("agreedPricePaise" IS NULL OR "agreedPricePaise" >= 0);
