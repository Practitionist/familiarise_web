/**
 * The domain map for `docs/prisma/00-schema-map.md`.
 *
 * Each domain lists the models it owns, the anchor models it draws for
 * context, and the prose that introduces it. Coverage is asserted by
 * `build-schema-map.ts` — every model in the schema must be claimed exactly
 * once, so a new model cannot be added to the schema without landing here.
 */

export interface Domain {
  id: string;
  title: string;
  /** Models owned by this domain. */
  models: string[];
  /** Models drawn only so cross-domain foreign keys are visible. */
  anchors?: string[];
  /** Prose shown under the heading, before the diagram. */
  intro: string;
  /** Invariant notes shown after the diagram. */
  notes?: string[];
}

export const domains: Domain[] = [
  {
    id: "identity",
    title: "Identity & Authentication",
    models: [
      "User",
      "Account",
      "Session",
      "Verification",
      "TwoFactor",
      "Passkey",
      "SsoProvider",
      "CookiePreference",
      "NotificationPreference",
      "OnboardingDraft",
    ],
    intro:
      "`User` is the single identity root. Every profile in the app hangs off it, and every money, booking and support row resolves to a person through it. The BetterAuth tables (`Account`, `Session`, `Verification`, `TwoFactor`, `Passkey`) own credentials; `SsoProvider` binds an external OIDC issuer to one organisation so an enterprise can assert its own domain. `OnboardingDraft` is a resumable server-side draft of the onboarding wizard, one row per user, deleted the moment onboarding completes.",
    notes: [
      "**Erasure is selective, not destructive.** When `User.erasedAt` is set, the PII fields are scrubbed to pseudonymous values and every active `Membership` is flipped to `MemberStatus.ERASED`. Financial rows — invoices, payouts, ledger entries — are intentionally retained, because IT Act record-keeping obligations outrank the erasure request. A `pseudonymousId` (SHA-256 of the user id plus a salt) lets historical audit rows still point at a deterministic actor without exposing the person.",
      "**`twoFactorEnabled` is mandatory for staff.** `lib/auth.ts` limits a `STAFF` or `ADMIN` session to credential plus TOTP sign-in; until the flag is set, the API and page guards only let that user reach `/auth/two-factor/setup`.",
      "**`OnboardingDraft.payload` is a JSONB blob, and the database enforces nothing about it.** A structural Zod schema at the write boundary (`utils/onboarding-draft.ts`) strips unknown keys, a `__v` generation marker quarantines a payload written by an older wizard, and `onboarding_draft_payload_size` in `prisma/sql/check-constraints.sql` caps the byte size. The trade is deliberate: the payload shape mirrors the wizard UI, so normalising it would couple database migrations to form tweaks.",
    ],
  },
  {
    id: "profiles",
    title: "Role Profiles",
    models: [
      "ConsultantProfile",
      "ConsulteeProfile",
      "StaffProfile",
      "AdminProfile",
      "OrgWorkspaceProfile",
      "OrgKybVerification",
    ],
    anchors: ["User"],
    intro:
      "One `User` can hold several profile types at once, and the pairs are not exclusive: a consultant can also buy as a consultee, and a staff member can still be a consultee. `User.role` is the coarse label the guards read; the profile tables carry the domain state. `OrgWorkspaceProfile` is the operator-side seat inside an organisation, and `OrgKybVerification` is the organisation's know-your-business file.",
    notes: [
      "**`ConsultantProfile` is the revenue root.** Earnings, payouts, tax records, plan authorship and availability all key off `consultantProfileId`, never off `User.id` directly. That is why the earnings ledger and the org side can be joined on one identifier without a profile lookup.",
      "**`OrgKybVerification` is a gate, not a record of intent.** The organisation's status moves to `OrgStatus` values that the funding-rail permutation engine reads before it will accept a `LICENSE` or `INVOICE` rail.",
    ],
  },
  {
    id: "background",
    title: "Professional Background & Verification",
    models: [
      "WorkExperience",
      "Certification",
      "Education",
      "Achievement",
      "ConsultantProfileVerification",
      "ProfileVerificationDocument",
    ],
    anchors: ["User", "ConsultantProfile"],
    intro:
      "Work history, certifications and education are consolidated at `User` level rather than per profile, so one person does not carry the same CV twice when they hold both a consultant and a consultee profile. `Achievement` is consultant-only because it hangs off `ConsultantProfile`. Verification is a two-level structure: a `ConsultantProfileVerification` submission and the `ProfileVerificationDocument` files that support it.",
    notes: [
      "**Verification is a reviewed state machine, not a boolean.** `ProfileVerificationStatus` moves through submission, staff review, and either approval or rejection with a reason; the documents are the evidence. `verificationDocumentsUploaded` is the owner column, and a rejection must be re-submitted rather than edited in place.",
    ],
  },
  {
    id: "taxonomy",
    title: "Consultant Taxonomy",
    models: ["Domain", "SubDomain", "Tag", "Topic"],
    anchors: ["ConsultantProfile"],
    intro:
      "How expertise is classified. `Domain` is the top level, `SubDomain` and `Tag` hang off it, and `Topic` is a separate flat vocabulary used to tag plans. `ConsultantProfile` carries one primary `Domain` plus a set of `SubDomain` and `Tag` memberships.",
    notes: [
      "**A plan's `Topic` set and a consultant's `Domain` set are separate vocabularies on purpose.** The marketplace filter needs a flat topic, while a consultant's expertise is hierarchical. Collapsing them would force a taxonomy change to become a data migration.",
    ],
  },
  {
    id: "plans",
    title: "Service Plans & Curriculum",
    models: [
      "ConsultationPlan",
      "SubscriptionPlan",
      "WebinarPlan",
      "ClassPlan",
      "PlanMaterial",
      "PlanFaq",
      "SubscriptionContent",
      "ClassContent",
    ],
    anchors: ["ConsultantProfile", "Organization"],
    intro:
      "Four product shapes — a one-to-one consultation, a recurring subscription, a webinar, and a cohort class. All four carry the same buyer-facing content shape (`subtitle`, `targetAudience`, `whatsIncluded`, `imageUrl`, `slug`, a `PlanLevel`, and a polymorphic `PlanFaq` child list) and all four may be owned by a `ConsultantProfile` alone or co-owned by an `Organization`. `PlanMaterial` is the shared attachment list; it is polymorphic across the four plan types with exactly one foreign key set.",
    notes: [
      "**`archivedAt` withdraws a plan from sale without deleting the terms past bookings still resolve against.** A booking references the plan row; deleting the plan would orphan the booking's price, policy and cancellation tier.",
      "**`PlanMaterial` and `PlanFaq` are polymorphic, and the database enforces the XOR.** `PlanMaterial_single_plan_fk_check` in `prisma/sql/check-constraints.sql` refuses a row that points at zero plan types or more than one.",
      "**`SubscriptionContent` and `ClassContent` are deliberately not one table.** A class module is a unit of syllabus delivered to a cohort; a subscription session is one appointment in a one-to-one engagement, and the two products are free to diverge. See ADR 24 in `docs/enterprise/70-design-decisions/`.",
    ],
  },
  {
    id: "collaborators",
    title: "Collaborators & Revenue Splits",
    models: ["Collaborator"],
    anchors: [
      "ConsultantProfile",
      "ConsultationPlan",
      "SubscriptionPlan",
      "WebinarPlan",
      "ClassPlan",
    ],
    intro:
      "One `Collaborator` row per co-host, teaching assistant or guest speaker on a plan, with a revenue share in basis points. The row is polymorphic across the plan types and the collaborator tiers are role-specific.",
    notes: [
      "**Four database constraints police this one table.** `collaborator_plan_xor` refuses zero or multiple plan foreign keys; `collaborator_role_matches_plan_type` refuses a webinar-only role on a class plan; `collaborator_tier_matches_role` refuses a role that outranks its tier; `collaborator_share_bps_in_range` keeps the split inside 0–10,000 bps. Two partial uniques — `collaborator_one_presenter_webinar` and `collaborator_one_presenter_class` — guarantee exactly one presenter per event type.",
    ],
  },
  {
    id: "availability",
    title: "Availability, Waitlist & Backup Windows",
    models: [
      "AvailabilityWindowWeekly",
      "AvailabilityWindowCustom",
      "WindowBackupInterest",
      "Waitlist",
    ],
    anchors: ["ConsultantProfile", "User"],
    intro:
      "Published availability is what makes a slot bookable. `AvailabilityWindowWeekly` is a recurring window stored in integer minutes since midnight UTC; `AvailabilityWindowCustom` is a one-off window. `Waitlist` queues a user for a plan that is full, and `WindowBackupInterest` records the user who asked to be told when a busy window frees up.",
    notes: [
      "**The 30-minute atom is the fundamental booking unit.** `startTimeUtc` and `endTimeUtc` are integers 0–1439, never timestamps, so a weekly window composes into identical 30-minute slots regardless of the consultant's timezone offset — the offset is a separate column.",
      "**A published window is a set of candidate slots, not a booking.** Slot reservation and the tentative-hold lifecycle live in the booking subsystem; the booking skill's doctrine on weekly versus custom rows and the union coverage rule is the authority there.",
    ],
  },
  {
    id: "bookings-1to1",
    title: "One-to-One Bookings",
    models: ["Consultation", "Subscription", "Trial", "ActivityLog"],
    anchors: [
      "User",
      "ConsultantProfile",
      "ConsulteeProfile",
      "ConsultationPlan",
      "SubscriptionPlan",
      "Organization",
      "Payment",
    ],
    intro:
      "The request-to-approval-to-payment chain for one-to-one services. `Consultation` and `Subscription` are the bookings; `Trial` is a time-boxed free or discounted first session that can convert into a `Subscription`. `ActivityLog` is the generic per-user activity feed.",
    notes: [
      "**Every booking row is a request first and a payment second.** `pendingPaymentUrl` is written before money moves, and the booking only becomes confirmed when the payment confirmation pipeline says so.",
      "**A trial that converts leaves a pointer, it does not mutate.** `Trial.convertedToSubscriptionId` is the one-way link, so the trial's own history stays intact for the refund and tax trail.",
    ],
  },
  {
    id: "bookings-group",
    title: "Group Bookings — Webinar & Class",
    models: ["Webinar", "Class"],
    anchors: [
      "User",
      "ConsultantProfile",
      "WebinarPlan",
      "ClassPlan",
      "Organization",
      "Appointment",
    ],
    intro:
      "A webinar is one session with many registrants; a class is a cohort that runs over many sessions. In both cases the registrants share a single `Appointment` row, which is what makes a group event cheap to fan out and hard to over-book: capacity is checked against the appointment's participants, not against a per-registrant row.",
    notes: [
      "**`maxParticipants` is a per-instance override.** A null on `Webinar` or `Class` inherits the plan's value; the per-instance value is what the capacity check reads.",
    ],
  },
  {
    id: "appointment",
    title: "Appointment — The Pivot Model",
    models: [
      "Appointment",
      "AppointmentParticipant",
      "AppointmentOccurrence",
      "BookingStatusHistory",
    ],
    anchors: [
      "User",
      "ConsultantProfile",
      "Consultation",
      "Subscription",
      "Webinar",
      "Class",
      "Trial",
      "Organization",
    ],
    intro:
      "`Appointment` is the pivot that every booking type resolves to. A one-to-one consultation has exactly one; a subscription has one per session; a webinar has one shared by all registrants; a class has one per session; a trial has one. `AppointmentOccurrence` is a concrete time slot inside it, `AppointmentParticipant` is the per-person seat row, and `BookingStatusHistory` is the append-only record of every status transition.",
    notes: [
      "**`BookingStatusHistory` is immutable and enforced as such.** `booking_status_history_immutable` in `prisma/sql/check-constraints.sql` refuses an update or delete, so the transition history is a ledger rather than a log.",
      "**An occurrence may be tentative.** A tentative occurrence holds its time but is not a confirmed booking, which is why `occurrence_no_confirmed_overlap` deliberately ignores tentative rows — the app-enforced slot lock covers that window instead.",
    ],
  },
  {
    id: "cancellation",
    title: "Cancellation Policy & Reschedule",
    models: [
      "CancellationPolicy",
      "CancellationPolicyTier",
      "RescheduleRequest",
      "RescheduleProposedTime",
    ],
    anchors: [
      "User",
      "ConsultantProfile",
      "Appointment",
      "Consultation",
      "Subscription",
    ],
    intro:
      "The refund-shape side of a booking. `CancellationPolicy` is a published, versioned document owned by the consultant; `CancellationPolicyTier` is the percentage ladder inside it. `RescheduleRequest` is the ask, and `RescheduleProposedTime` holds the candidate windows the consultant offers back.",
    notes: [
      "**A booking snapshots the policy version it was sold under.** The policy is versioned rather than edited, so a policy change never retroactively re-dates an existing booking's refund tier.",
      "**`cancellation_policy_one_active_per_scope` is a partial unique.** Exactly one active policy may exist per scope, enforced by the database rather than by a read-then-write in application code.",
    ],
  },
  {
    id: "session",
    title: "Session Infrastructure, Attendance & Recordings",
    models: [
      "Meeting",
      "MeetingAttendance",
      "MeetingPresence",
      "Recording",
      "RecordingConsent",
      "RecordingPurchase",
    ],
    anchors: ["AppointmentOccurrence", "Appointment", "Organization", "User"],
    intro:
      "The Stream.io video layer and the recording store. `Meeting` is the live call for one occurrence. `MeetingAttendance` and `MeetingPresence` are two different attendance records — one is the settled record, one is the live signal. `Recording` is the media asset; `RecordingConsent` is the publish-time redistribution attestation; `RecordingPurchase` is a replay purchase.",
    notes: [
      "**Dual storage.** `STREAM_S3` is temporary (the free tier's two-week window); `SUPABASE` is permanent on the premium path. The `RecordingStatus` lifecycle runs `RECORDING` → `PROCESSING` → `READY` → `TRANSFERRING` → `AVAILABLE`, and `Recording_storage_and_publish_check` refuses a row that claims a permanent path without having transferred to it.",
      "**Recording retention is bounded by the organisation.** `org_stream_recording_retention_days_range` on `organizations` keeps the per-organisation retention window inside the range the platform can honour.",
    ],
  },
  {
    id: "documents",
    title: "Session Documents",
    models: ["AppointmentDocument"],
    anchors: ["Appointment", "User"],
    intro:
      "Files exchanged inside a booking — briefs, follow-ups, receipts. `AppointmentDocument` is versioned within a thread: `rootDocumentId` anchors the thread and `responseToDocumentId` chains the replies.",
    notes: [
      "**Deletion is a soft-delete with a named deleter.** `deletedAt` plus `documentsDeleted` on `User` keep the audit trail; `appointment_doc_thread_version_unique` keeps a version number unique inside one thread.",
    ],
  },
  {
    id: "payments",
    title: "Payments, Refunds & Disputes",
    models: [
      "Payment",
      "PaymentLeg",
      "Refund",
      "Dispute",
      "IdempotencyRecord",
      "WebhookEvent",
      "DiscountCode",
    ],
    anchors: ["User", "Appointment", "Organization", "BillingAccount"],
    intro:
      "Money enters through `Payment` and is funded by one or more `PaymentLeg` rows. A `Refund` reverses it, a `Dispute` is the gateway's chargeback, `IdempotencyRecord` makes a write replay-safe, `WebhookEvent` deduplicates gateway callbacks, and `DiscountCode` carries the promotional reduction.",
    notes: [
      "**All money columns are `BigInt` paise.** Settlement is INR only, and `payment_currency_inr`, `refund_currency_inr` and `dispute_currency_inr` refuse any other currency at the database level.",
      "**The legs must sum to the payment.** `payment_legs_sum_to_amount` is a constraint trigger that refuses a `Payment` whose legs do not add up, and `payment_amount_vs_legs` keeps the header amount consistent with them. `payment_refunds_within_amount` refuses refunds beyond the captured amount.",
      "**`Payment.paymentStatus = SUCCEEDED` is written by exactly one pipeline** — the payment confirmation handler. Every other status transition is a conditional update that names the expected prior status in its `WHERE` clause.",
    ],
  },
  {
    id: "pricing",
    title: "Platform Pricing & Fee Policy",
    models: [
      "PlatformPricingConfig",
      "PlatformFeeSchedule",
      "ConsultantFeeWaiver",
    ],
    anchors: ["ConsultantProfile"],
    intro:
      "The platform's own pricing knobs. `PlatformPricingConfig` holds global floors such as the minimum trial price; `PlatformFeeSchedule` is the effective fee table with a validity window; `ConsultantFeeWaiver` is a per-consultant concession.",
    notes: [
      "**Fee policy is versioned by validity window, not edited.** `platform_fee_schedule_valid` refuses a schedule whose window or basis points are nonsense, and the pricing code reads the schedule effective on the booking date, not the newest one.",
    ],
  },
  {
    id: "earnings",
    title: "Consultant Earnings & Payouts",
    models: [
      "ConsultantEarnings",
      "EarningsHold",
      "ConsultantPayout",
      "PayoutAccount",
    ],
    anchors: ["User", "ConsultantProfile", "Payment", "Refund"],
    intro:
      "The lifecycle from a captured payment to money in a bank account. `ConsultantEarnings` is the per-occurrence earning row; `EarningsHold` is a reason-scoped block on it; `ConsultantPayout` is a batch that settles a set of earnings; `PayoutAccount` is a verified destination.",
    notes: [
      "**A hold is scoped by reason and by owner.** `earnings_hold_one_earning` keeps at most one active hold per earning, and the two partial uniques — `earnings_hold_active_consultant_key` and `earnings_hold_active_org_key` — stop a second consultant-side or organisation-side hold from stacking on the same earning. A service complaint alone does not freeze earnings; a gateway chargeback does, and it keeps its own lifecycle.",
      "**`consultant_earnings_occurrence_key` is a partial unique** that stops the same occurrence being paid out twice, and `consultant_earnings_batched_has_payout` refuses a row in a batched state with no payout attached.",
      "**The payout destination is snapshotted at mint.** A bank-change cooling-off window (`payoutsAllowedAfter`) and a payee-initiated freeze (`payoutsFrozenAt`) both live on the account, and a payout records the account it was minted against, so processing sends to exactly the destination that was approved.",
    ],
  },
  {
    id: "tax",
    title: "Tax — TDS, GST & Adjustments",
    models: ["ConsultantTaxInfo", "TDSRecord", "TdsRate", "TdsAdjustment"],
    anchors: ["ConsultantProfile", "ConsultantPayout", "Refund"],
    intro:
      "Withholding tax at the source. `ConsultantTaxInfo` is the consultant's PAN, GSTIN, residency and MSME standing. `TdsRate` is the rate table with its validity window. `TDSRecord` is the per-payout withholding, and `TdsAdjustment` reverses previously withheld tax when a refund lands.",
    notes: [
      "**The rate is looked up by date, not stored on the consultant.** `tds_rate_bps_and_window_sane` and `tds_rate_bps_bounds` keep the rate table honest, and `tds_record_financial_year_format` keeps the FY stamp in the `2026-27` shape the Form 26Q filing expects.",
      "**A TDS row points at exactly one of a consultant or an organisation** (`tds_record_deductee_xor`), because the deductee is the entity the withholding is reported against, and the two are not interchangeable.",
    ],
  },
  {
    id: "consumer-billing",
    title: "Consumer Invoicing & Credit Notes",
    models: [
      "ConsumerInvoice",
      "ConsumerCreditNote",
      "PlatformInvoiceCounter",
      "PlatformCreditNoteCounter",
    ],
    anchors: ["User", "Payment", "Refund"],
    intro:
      "The B2C side of tax invoicing. `ConsumerInvoice` is the tax invoice issued to a buyer; `ConsumerCreditNote` cancels or reduces it. `PlatformInvoiceCounter` and `PlatformCreditNoteCounter` are the per-year sequence allocators behind the document numbers.",
    notes: [
      "**A tax invoice carries exactly one tax head.** `consumer_invoice_tax_head_xor` refuses a row with both IGST and CGST/SGST, and `consumer_credit_note_tax_head_xor` does the same for the note — a partially-populated GST split is not a legal document.",
      "**The counters are the serialisation point.** Each is allocated with an insert-on-conflict update, so two concurrent invoices cannot read the same next sequence.",
    ],
  },
  {
    id: "referrals",
    title: "Referrals & Credit Pools",
    models: [
      "ReferralCode",
      "Referral",
      "ReferralCredit",
      "ReferralCreditUsage",
      "ReferralProgramConfig",
    ],
    anchors: ["User", "Payment"],
    intro:
      "Acquisition by referral. `ReferralCode` is a user's code, `Referral` is one tracked referral, `ReferralCredit` is a credit balance that can be spent, `ReferralCreditUsage` is the spend against a payment, and `ReferralProgramConfig` is the rules the programme runs on.",
    notes: [
      "**Credit is a balance with a ledger behind it.** `referral_credit_balance_consistent` keeps the remaining amount equal to the issued amount minus the uses, and `referral_credit_usage_nonnegative` refuses a negative spend.",
      "**A referral credit is applied as a payment leg, not as a discount.** That is why the funding-leg sum identity still holds when a credit is spent.",
    ],
  },
  {
    id: "experts",
    title: "Expert–Customer Relationships",
    models: ["ExpertCustomerRelationship"],
    anchors: ["User", "ConsultantProfile", "Organization"],
    intro:
      "The durable record that a user has bought from an expert, with the source that owns the relationship. It is what a consultant's client list and an organisation's spend history are both read from, without re-deriving either from payments.",
    notes: [
      '**The relationship is a projection, not the money record.** `Payment` remains the source of truth for what was paid; this table answers "who has bought from whom" without a join across the payment tables.',
    ],
  },
  {
    id: "enterprise-core",
    title: "Enterprise Core — Organisation & Membership",
    models: [
      "Organization",
      "Membership",
      "Invitation",
      "OrganizationTaxInfo",
      "OrganizationMsmeInfo",
      "OrganizationSSOSettings",
      "OrgDomainClaim",
      "OrgAuditLog",
      "OrgBrandingProfile",
    ],
    anchors: ["User", "ConsultantProfile", "ConsulteeProfile"],
    intro:
      "An `Organization` can sponsor employees (`canSponsor`), host consultants (`canHost`), or both. `Membership` is the only membership table in the system: it joins a `User` to an `Organization` with a role, a status and a payout recipient. `Invitation` covers both the organisation-scoped and the platform-scoped operator door. `OrganizationTaxInfo` and `OrganizationMsmeInfo` carry the statutory profile; `OrgSSOSettings` and `OrgDomainClaim` carry the identity perimeter; `OrgAuditLog` is the trail; `OrgBrandingProfile` is the white-label surface.",
    notes: [
      "**`Membership` is typed, not a join table.** `MemberRole` and `MemberStatus` decide what the member may do and whether the seat is live; `Membership.status = ERASED` is what an erasure request flips every active row to.",
      "**A verified domain claim is unique per domain.** `org_domain_claims_verified_domain_key` means a domain can be claimed by exactly one organisation, so an SSO assertion can be trusted to identify one tenant.",
      "**The organisation's own tax and MSME data is separate from the consultant's.** An organisation is a `principal supplier` to the platform and files its own GST, so its registration and MSME standing live on `OrganizationTaxInfo` and `OrganizationMsmeInfo`, not on `ConsultantTaxInfo`.",
    ],
  },
  {
    id: "enterprise-billing",
    title: "Enterprise Billing, Programs & Wallets",
    models: [
      "BillingAccount",
      "Contract",
      "BillingSubscription",
      "WalletTopUp",
      "RateCard",
      "Program",
      "ProgramAssignment",
      "ProgramConsultantAllowlist",
      "LicensedSeatConfig",
      "CreditPoolConfig",
      "BookingUtilization",
      "OverageEvent",
      "PurchaseOrder",
      "OrgInvoiceCounter",
    ],
    anchors: ["Organization", "Membership", "Payment"],
    intro:
      "The commercial spine: `BillingAccount` → `Contract` → `Program` → `ProgramAssignment` → `BookingUtilization`. Each link adds a layer of budget control. `BillingSubscription` is the billing cycle, `WalletTopUp` is the top-up lifecycle, `RateCard` is the three-way basis-point split, `LicensedSeatConfig` and `CreditPoolConfig` are the two overage shapes, `OverageEvent` is the append-only over-cap charge ledger, and `PurchaseOrder` is the org's pre-authorisation.",
    notes: [
      "**The wallet balance is a liability account in the double-entry ledger, not a standalone table.** `BillingAccount.walletBalance` is retained only as a denormalised cache for the atomic-debit guard, and the nightly reconciliation asserts it equals the `WALLET` account balance. `billing_account_wallet_nonnegative` refuses a negative balance.",
      "**A contract is superseded, never edited.** `Contract.supersededByContractId` is a self-relation with a `ContractSupersessionReason`, and `contract_one_active_per_billing_account_idx` keeps exactly one active contract per billing account.",
      "**A program assignment cannot overlap itself.** `program_assignment_no_active_overlap` refuses two active assignments for the same member and program, and `ProgramAssignment.rolledToAssignmentId` is the one-way link when a cycle rolls over.",
      "**The rate card must divide the whole.** `rate_card_bps_sum_is_whole` refuses a split that is not exactly 10,000 bps across platform, organisation and consultant, and `rate_card_one_open_window` keeps one open validity window at a time.",
      "**Overage is a formula, not a number.** `overage_marginal_is_base_plus_surcharge` refuses a marginal charge that is not the base plus its surcharge, so the two can never drift apart.",
    ],
  },
  {
    id: "enterprise-invoicing",
    title: "Enterprise Invoicing, Receipts & Organisation Payouts",
    models: [
      "OrganizationInvoice",
      "OrganizationInvoiceReceipt",
      "InvoiceLineItem",
      "OrganizationEarnings",
      "OrganizationPayout",
      "OrganizationPayoutAccount",
      "CreditNote",
      "OrgCreditNoteCounter",
    ],
    anchors: ["Organization", "Payment", "Refund", "Dispute", "BillingAccount"],
    intro:
      "Month-end invoicing for the organisation side. `OrganizationInvoice` is the tax invoice, `InvoiceLineItem` its lines, `OrganizationInvoiceReceipt` the money received against it, `OrganizationEarnings` the organisation's share of a host booking, `OrganizationPayout` the batch that disburses it, `OrganizationPayoutAccount` the destination, and `CreditNote` the Section 34 / CGST Rule 53 document that cancels or reduces an invoice.",
    notes: [
      "**An invoice is paid when its receipts and credit notes cover its total.** A bank transfer is recorded as a `BANK_TRANSFER` receipt with a UTR; a gateway capture is a `GATEWAY` receipt with the gateway payment id. `organizationId` plus `reference` is unique, so the same UTR cannot be recorded twice.",
      "**A voided invoice is not a deleted invoice.** `CreditNote.voidedInvoiceId` is unique, so a platform void produces exactly one credit note against that invoice, and the audit trail survives.",
      "**The invoice number is per-organisation and per fiscal year.** `OrgInvoiceCounter` allocates it with an insert-on-conflict update, and the format is `<PREFIX>-<FY>-<SEQ>` under CGST Rule 46.",
      "**The organisation's split must fit inside the gross.** `org_earnings_split_within_gross` refuses a split whose platform fee plus consultant share exceeds the gross, and `organization_earnings_split_key` stops the same split being recorded twice.",
    ],
  },
  {
    id: "ledger",
    title: "Double-Entry Ledger & Gateway Settlement",
    models: [
      "LedgerAccount",
      "LedgerTransaction",
      "LedgerEntry",
      "UsageLedgerEntry",
      "LedgerReconciliationReport",
      "GatewaySettlementLine",
    ],
    anchors: ["Payment", "Refund", "Organization", "ConsultantProfile"],
    intro:
      "The single source of truth for cash. Every cash event is one `LedgerTransaction` whose `LedgerEntry` rows satisfy the sum-of-debits-equals-sum-of-credits identity, and each `LedgerAccount` balance is derived from those postings. `UsageLedgerEntry` counts non-cash engagement consumption and is deliberately outside the cash journal. `GatewaySettlementLine` holds the gateway's own settlement report for matching, and `LedgerReconciliationReport` is the nightly audit output.",
    notes: [
      "**Balances are derived, not stored.** There is no balance table on `dev`: the balance is the sum of the postings, and the reconciliation job recomputes it. The earlier `LedgerAccountBalance` cache was removed in #2251 in favour of computing the balance from the journal.",
      "**The journal is immutable.** `ledger_entry_immutable` and `ledger_transaction_immutable` refuse updates and deletes, and `ledger_txn_balanced` is the constraint trigger that enforces the debit-equals-credit identity at commit.",
      "**A reversal is a counter-transaction, never an edited row.** That is why the ledger can be re-derived at any time and compared against the gateway.",
      "**The usage ledger is a different thing.** `usage_ledger_entry_immutable` keeps the engagement counter append-only, but it is not part of the cash balance identity and does not carry money.",
    ],
  },
  {
    id: "support-legacy",
    title: "Support — Legacy Queues & Self-Serve Threads",
    models: [
      "SupportTicket",
      "SupportTicketCounter",
      "SupportResponse",
      "SupportTicketAttachment",
      "AppointmentSupportThread",
      "SupportMessage",
      "SupportFlowOutcome",
    ],
    anchors: ["User", "Appointment", "Organization"],
    intro:
      "The older support surfaces, kept alive while the canonical case record takes over. `SupportTicket` is the general queue with its SLA clocks and speakable reference number. `AppointmentSupportThread` is the per-appointment conversation that a deterministic flowchart drives, with `SupportMessage` as its transcript and `SupportFlowOutcome` as the counter that says whether the tree resolved the turn without a human.",
    notes: [
      "**The reference number is year-scoped and forward-only.** `SupportTicketCounter` allocates it with an insert-on-conflict update. A unique index permits unlimited nulls, so tickets that predate the column keep their uuid and no backfill is owed.",
      "**A thread's transcript is ordered by `seq`, not by `createdAt`.** The user's turn and the bot's reply are written in one transaction, and Postgres `CURRENT_TIMESTAMP` is transaction start time, so the two can carry a byte-identical timestamp. `seq` is a strict per-thread total order allocated from the thread's own counter, and the row lock that counter takes is the serialisation point between a user typing on a phone and an agent replying on a desktop.",
      "**Deflection is measured, not assumed.** `SupportFlowOutcome` records one row per terminal turn, so the rate of conversations the tree resolves without a human is answerable. It carries counts and timings, never a transcript.",
    ],
  },
  {
    id: "support-case",
    title: "Support — The Canonical Case",
    models: [
      "SupportCase",
      "SupportCaseSubject",
      "SupportCaseMessage",
      "SupportCaseEvent",
    ],
    anchors: [
      "User",
      "Appointment",
      "AppointmentOccurrence",
      "Organization",
      "Payment",
      "Refund",
    ],
    intro:
      "`SupportCase` is the canonical record from intake through private evidence, decisions, appeals and resolution. It owns the transcript (`SupportCaseMessage`), the event trail (`SupportCaseEvent`), and the links to whatever the case is about (`SupportCaseSubject`, which names the subject type and id rather than a foreign key per type).",
    notes: [
      "**The case is addressed by scope, not by a free-text key.** `ownershipScope` and `scopeKey` say whose conversation this is — a personal account, organisation operations, or organisation billing — and `support_case_open_scope_key` keeps exactly one open case per scope tuple. `support_case_scope_and_shape_chk` refuses a case whose scope and its columns disagree.",
      "**A subject is polymorphic by design.** `SupportCaseSubject.subjectType` plus `subjectId` names the appointment, occurrence, payment, refund, invoice, organisation or account a case concerns, and `support_case_subject_primary_key` allows exactly one primary subject per case.",
      "**The message stream is retry-safe.** `clientTurnId` is unique per case, so a client that retries a turn does not create a second message.",
    ],
  },
  {
    id: "feedback",
    title: "Feedback & Ratings",
    models: ["AppointmentFeedback"],
    anchors: [
      "Appointment",
      "AppointmentOccurrence",
      "User",
      "ConsultantProfile",
      "Organization",
    ],
    intro:
      "The private per-call rating, distinct from the public `ConsultantReview`. It covers calls that a public review does not, such as a webinar or a class, and it feeds the organisation-level quality aggregate. The rater's role is recorded so a consultant's rating of their own session can be excluded.",
    notes: [
      "**One rating per person per call, and one per person per whole appointment.** That is a unique index on `(appointmentId, appointmentOccurrenceId, userId)` where nulls are distinct, which Prisma cannot express — so it lives in `prisma/sql/check-constraints.sql` as `appointment_feedback_level_key`.",
      "**An aggregate that can be adjudicated needs a rater role.** `raterRole` is nullable and never backfilled: rows written before the column cannot be attributed, and asserting `CONSULTEE` over them would re-admit the self-ratings being excluded. The aggregate filters on `CONSULTEE`, so unknown provenance fails closed.",
    ],
  },
  {
    id: "moderation",
    title: "Moderation, Trust & Incidents",
    models: [
      "ConsultantReview",
      "ConsultantReviewRevision",
      "ModerationReport",
      "ModerationAction",
      "PlatformFeedback",
      "PlatformIncident",
      "IncidentRemedy",
    ],
    anchors: ["User", "ConsultantProfile", "ConsulteeProfile", "Appointment"],
    intro:
      "The public reputation rail and the machinery around it. `ConsultantReview` is a public review of a consultant; `ConsultantReviewRevision` is the append-only chain of superseded versions of its text. `ModerationReport` is a report against content or a person; `ModerationAction` is every enforcement step and it can exist without a report behind it since #1562. `PlatformFeedback` is feedback about the platform rather than a rating of a call. `PlatformIncident` and `IncidentRemedy` are the declared-incident record.",
    notes: [
      "**An action must name its target, and the target must match the action type.** `moderation_action_has_target` and `moderation_action_target_matches_type` refuse a row that points at nothing, or at the wrong kind of thing for the action it claims to be.",
      "**A report that names a review must name a real one.** `moderation_report_review_has_review` refuses the reverse edge.",
      "**Public and private reputation are separate surfaces.** Removing a public review and excluding a private rating are different actions with different restoration paths, which is why the two have separate removed-pair constraints.",
      "**A review's text is versioned, never edited.** `review_revision_immutable` refuses an update or delete of a revision, and `consultant_review_pair_track_event_key` keeps a reviewer's one review per track. `consultant_review_group_has_event` requires a group review to have the event it was written for.",
      "**A removed review keeps its shape.** `consultant_review_removed_pair` and `consultant_review_reply_removed_pair` enforce that removal is expressed as a pair of flags rather than by deleting the row, so the moderation audit stays complete.",
    ],
  },
  {
    id: "leads",
    title: "Leads",
    models: ["Lead"],
    anchors: ["Organization", "User"],
    intro:
      "The pre-account funnel. A `Lead` captures an organisation that has not yet signed up, and the state it is in.",
    notes: [
      "**A lead is not a `User` and not a `Membership`.** It is a separate record with its own status, so an unqualified enquiry never has to be coerced into the membership model and later deleted from it.",
    ],
  },
  {
    id: "compliance",
    title: "Compliance — DPDP Consent, Erasure & Data Rights",
    models: [
      "ConsentArtifact",
      "DataBreach",
      "DpdpGrievance",
      "ErasureRequest",
      "OrgDataExportJob",
      "StreamRevocationRetry",
      "VendorErasureRetry",
    ],
    anchors: ["User", "Organization"],
    intro:
      "The India-first compliance subsystem. `ConsentArtifact` is the append-only record of what a user consented to and when. `DataBreach` is the incident record, `DpdpGrievance` the grievance register, `ErasureRequest` the right-to-erasure workflow, and `OrgDataExportJob` the organisation's data-export request.",
    notes: [
      "**The consent gate is fail-closed.** A request with no matching artefact is refused, not treated as implicit consent. The artefact records the terms version and the privacy-policy version, so a later change to either does not retroactively alter what a user agreed to.",
      "**Erasure is a workflow with a human gate, not a delete.** The request is filed, processed, and only then does the selective scrub described in the identity section run. The two retry tables — `StreamRevocationRetry` and `VendorErasureRetry` — exist because revocation at an external vendor is a separate, retryable action that cannot be rolled back with the database transaction.",
      "**Reconciliation across vendor boundaries is the one place an application sweep is correct.** The database cannot enforce that a third-party service has actually deleted a video, so that reconciliation lives in application code and is the deliberate exception to the no-reconciler rule.",
    ],
  },
  {
    id: "system",
    title: "System, Operations & Notification Delivery",
    models: [
      "SystemEvent",
      "SystemJobExecution",
      "OpsActionLog",
      "OpsActionProposal",
      "Announcement",
      "MaintenanceWindow",
      "WebhookEndpoint",
      "OutboundWebhookDelivery",
      "FailedEmail",
      "FailedEmailBatch",
      "NotificationOutbox",
      "EmailEvent",
      "EmailSuppression",
    ],
    anchors: ["User", "Payment"],
    intro:
      "The operational substrate. `SystemEvent` and `SystemJobExecution` are the observability record, `OpsActionLog` is the audit of every privileged action, and `OpsActionProposal` is the second-admin queue for money doors above the threshold. `NotificationOutbox` is the durable outbox every notification is written to, with `EmailEvent`, `EmailSuppression`, `FailedEmail` and `FailedEmailBatch` recording what happened to each send. `WebhookEndpoint` and `OutboundWebhookDelivery` are the platform's own outbound webhooks.",
    notes: [
      "**Notifications are written to an outbox, not sent inline.** A row lands in `NotificationOutbox` in the same transaction as the event that caused it, and a leased sweep delivers it. That is why a delivery failure never loses the message, and why `FailedEmail_active_outbox_idx` and `NotificationOutbox_active_outbox_idx` are partial indexes over the active rows only.",
      "**A money door above the threshold is a proposal, not an execution.** `OpsActionProposal` holds the validated request body and the route it was proposed against, so the approver's run replays exactly what the proposer saw. `ops_action_proposal_one_open_key` allows only one open proposal per action and target.",
      "**A processed webhook is either processed or failed, never both.** `webhook_event_processed_error_exclusive` refuses a row that claims both, and `webhook_event_processed_timestamp_consistent` requires the processed stamp to exist whenever the processed flag is set.",
    ],
  },
];
