// Re-runs checkout's validation under the lock, and re-reads the org rail,
// so nothing decided before the lock is trusted after it.

import { seatHoldingParticipant } from "@/utils/scheduling-engine/occupancyPolicy";
import prisma from "@/lib/prisma";
import { assertNotSelfBooking } from "@/lib/booking/self-booking";
import {
  checkAssignee,
  SPONSOR_SEAT_MESSAGES,
} from "@/lib/api/organizations/sponsor-seat";
import type { CheckoutInput } from "@/schemas/checkout";
import { ensureConsulteeProfile } from "@/lib/profiles/ensure-consultee-profile";
import { getClassCapacity, getWebinarCapacity } from "@/lib/events/capacity";
import { getInvoiceCreditLimitPaise } from "@/lib/enterprise/governance";
import { checkConsent } from "@/lib/compliance/dpdp";
import { PURPOSE_CODES } from "@/lib/compliance/purpose-codes";
import { ENABLE_DUNNING_SUSPEND } from "@/lib/feature-flags";
import { verifyPlanExistsInsideLock } from "@/lib/payments/checkout/locks";
import {
  assertConsulteeHasNoOverlappingSession,
  validateSlotAvailability,
} from "@/lib/payments/checkout/occupancy-validate";

/**
 * Re-validate availability inside the lock
 * Critical for preventing TOCTOU race conditions
 */
/**
 * What the pre-lock org gate chain resolved; re-asserted under the lock.
 *
 * `billingAccountId` is here because the lock must pin the account the rail
 * came FROM, not merely "some account of this org": the wallet debit and the
 * Payment's `billingAccountId` both address that exact row, and a rail decision
 * read off a different account than the one charged is the axis collapse this
 * module is guarded against.
 */
export interface OrgFundingContext {
  organizationId: string;
  callerMembershipId: string;
  programAssignmentId: string | null;
  appointmentType: "CONSULTATION" | "SUBSCRIPTION" | "WEBINAR" | "CLASS";
  billingAccountId: string | null;
}

/**
 * The org money state RE-READ under the lock. Everything rail-dependent is
 * derived from this, never from the pre-lock value: `PATCH
 * /api/organizations/[orgId]/billing-account` can flip `fundingSource` and
 * resize `creditLimit` at any moment behind a FINANCE_MUTATORS permission, with
 * no coordination with a checkout in flight.
 */
export interface OrgFundingRead {
  /** The rail as it stands under the lock; "PERSONAL" when there is no account. */
  fundingSource: "PERSONAL" | "WALLET" | "INVOICE" | "LICENSE";
  /** The account actually read — null once the org has none. */
  billingAccountId: string | null;
  /** INVOICE credit ceiling folded with the unverified-org governance cap. */
  creditEffectiveLimit: number | null;
}

export async function revalidateInsideLock(
  data: CheckoutInput,
  userId: string,
  // ADR 18 — Program funding this org-sponsored booking; null for
  // PERSONAL/marketplace checkouts. Drives the curated-panel check.
  programId: string | null = null,
  orgContext: OrgFundingContext | null = null,
): Promise<OrgFundingRead | null> {
  // Re-run the same validation as calculateAmountAndValidate
  // but this time we're inside the lock, so it's safe
  return prisma.$transaction(async (tx) => {
    await ensureConsulteeProfile(tx, userId);
    const user = await tx.user.findUnique({
      where: { id: userId },
      include: {
        consulteeProfile: true,
        // For the self-booking guard below. A user may hold both profiles —
        // ConsultantProfile and ConsulteeProfile are independent 1:1s and
        // deliberately not mutually exclusive (ADR 18, and the roles doc says
        // so outright), which is exactly what makes the guard necessary.
        consultantProfile: { select: { id: true } },
      },
    });

    if (!user?.consulteeProfile) {
      throw new Error("User profile not found");
    }

    // BUG-E: Re-validate plan still exists (could be deleted between initial validation and lock)
    const plan = await verifyPlanExistsInsideLock(
      tx,
      data.appointmentType,
      data.planId,
      data.eventId,
    );

    assertNotSelfBooking(user.consultantProfile?.id, plan);

    // #1319 (B2B gap 3) — the org gate chain ran BEFORE the locks, so an org
    // suspended, a membership revoked, an assignment rolled or a consent
    // withdrawn between the gate and the write still got sponsored. Re-assert
    // the resolved rows by id under the lock; the credit limit is re-checked
    // inside the Serializable booking tx already.
    //
    // #1854 — and now the RAIL too. `Organization.status`, `canSponsor` and the
    // rest are re-read here, but `BillingAccount` used not to be read at all
    // outside the pre-lock gate, so `fundingSource` stayed whatever it was
    // seconds earlier. The dangerous direction is LICENSE → WALLET: `isOrgLicensedPayment`
    // stays true, so the leg is written as a 0-value LICENSE leg while
    // `Payment.amount` holds the full price — and `payment_legs_sum_to_amount`
    // explicitly carves that shape out, so the booking commits, earnings accrue
    // at full value and the org is never charged. Everything below is derived
    // from what this read returns.
    let freshOrgFunding: OrgFundingRead | null = null;
    if (orgContext) {
      const now = new Date();
      const org = await tx.organization.findUnique({
        where: { id: orgContext.organizationId },
        select: { status: true, canSponsor: true },
      });
      // #1582 B-P1-01b — registered codes rethrow unchanged through the tx
      // catch (isBusinessErrorCode) instead of collapsing to 500 UNKNOWN.
      if (
        !org ||
        (org.status !== "ACTIVE" && org.status !== "PENDING_VERIFICATION")
      ) {
        throw Object.assign(
          new Error(
            "This organization can no longer sponsor bookings. Please refresh and try again.",
          ),
          { httpStatus: 403, code: "ORG_NOT_OPERATIONAL" },
        );
      }
      if (!org.canSponsor) {
        throw Object.assign(
          new Error("This organization is not configured to sponsor bookings."),
          { httpStatus: 403, code: "ORG_CANNOT_SPONSOR" },
        );
      }
      // The rail, re-read. `ownerOrgId` is the canonical 1:1, so this resolves
      // the account even if one appeared (or vanished) between the two reads.
      const billingAccount = await tx.billingAccount.findFirst({
        where: { ownerOrgId: orgContext.organizationId },
        select: { id: true, fundingSource: true, creditLimit: true },
      });
      // An account that was there pre-lock and is gone now (sponsorship turned
      // off mid-flight) would otherwise leave the caller debiting and stamping
      // an id no row carries. Refuse, and let the buyer retry against the
      // configuration as it now stands. `ORG_CANNOT_SPONSOR` rather than a new
      // code: it is the registered answer for "this org is not set up to
      // sponsor right now", and its userMessage already points the buyer at the
      // billing admin or at booking the session themselves.
      if (orgContext.billingAccountId !== (billingAccount?.id ?? null)) {
        throw Object.assign(
          new Error(
            "This organization's billing account changed while this booking was in progress. Please refresh and try again.",
          ),
          { httpStatus: 403, code: "ORG_CANNOT_SPONSOR" },
        );
      }
      // Same fold as the pre-lock gate (#687): the explicit ceiling, capped by
      // the governance ceiling while the org is unverified. Recomputed rather
      // than carried, because `creditLimit` is editable at any moment too — and
      // the in-transaction re-check compares the org's accrual against exactly
      // this number, so a stale one is a credit-limit hole, not a cosmetic one.
      const freshGovernanceLimit =
        org.status === "ACTIVE" ? null : getInvoiceCreditLimitPaise();
      const freshExplicitLimit = billingAccount?.creditLimit ?? null;
      freshOrgFunding = {
        fundingSource: billingAccount?.fundingSource ?? "PERSONAL",
        billingAccountId: billingAccount?.id ?? null,
        creditEffectiveLimit:
          freshExplicitLimit === null
            ? freshGovernanceLimit
            : freshGovernanceLimit === null
              ? freshExplicitLimit
              : Math.min(freshExplicitLimit, freshGovernanceLimit),
      };
      const membership = await tx.membership.findUnique({
        where: { id: orgContext.callerMembershipId },
        select: { id: true, status: true, role: true },
      });
      if (membership?.status !== "ACTIVE") {
        throw Object.assign(
          new Error("You are not an active member of this organization."),
          { httpStatus: 403, code: "ORG_MEMBERSHIP_REQUIRED" },
        );
      }
      if (
        freshOrgFunding.fundingSource !== "PERSONAL" &&
        !checkAssignee(membership, membership.id, null).ok
      ) {
        throw Object.assign(new Error(SPONSOR_SEAT_MESSAGES.ROLE), {
          httpStatus: 409,
          code: "SPONSOR_SEAT_ROLE",
        });
      }
      if (orgContext.programAssignmentId) {
        const assignment = await tx.programAssignment.findFirst({
          where: {
            id: orgContext.programAssignmentId,
            status: "ACTIVE",
            periodStart: { lte: now },
            periodEnd: { gte: now },
            program: {
              status: "ACTIVE",
              OR: [
                { coveredPlanTypes: { isEmpty: true } },
                { coveredPlanTypes: { has: orgContext.appointmentType } },
              ],
              contract: {
                organizationId: orgContext.organizationId,
                status: "ACTIVE",
                effectiveFrom: { lte: now },
                OR: [{ effectiveTo: null }, { effectiveTo: { gte: now } }],
              },
            },
          },
          select: { id: true },
        });
        if (!assignment) {
          throw new Error(
            "Your program assignment changed while this booking was in progress. Please refresh and try again.",
          );
        }
      }
      if (ENABLE_DUNNING_SUSPEND) {
        const suspended = await tx.organizationInvoice.findFirst({
          where: {
            organizationId: orgContext.organizationId,
            status: "OVERDUE",
            dunningSuspendedAt: { not: null },
          },
          select: { id: true },
        });
        if (suspended) {
          // #1467 — the in-lock re-check of the same dunning gate. It throws
          // inside the checkout transaction, so without the code the catch below
          // rewrites it to "Failed to record payment information"; with it the
          // buyer gets the same 402 the pre-lock gate returns.
          throw Object.assign(
            new Error(
              "This organization is suspended from new sponsored bookings until its overdue invoice is paid.",
            ),
            { httpStatus: 402, code: "BILLING_SUSPENDED_DUNNING" },
          );
        }
      }
      if (
        // #1421 — same pool-starvation rule as validateSlotAvailability: this
        // runs inside revalidateInsideLock's transaction.
        !(await checkConsent(
          {
            userId,
            purposeCode: PURPOSE_CODES.SESSION_BOOKING,
          },
          tx,
        ))
      ) {
        throw Object.assign(
          new Error(
            "Your organisation needs your permission to book sessions for you. You can give it in Settings › Account › Data consent.",
          ),
          {
            httpStatus: 403,
            code: "CONSENT_REQUIRED",
            purposeCode: "SESSION_BOOKING",
          },
        );
      }
    }

    // ADR 18 — curated-panel enforcement (#971 shipped the stub). Rows on
    // the funding Program restrict org-sponsored bookings to listed
    // consultants; zero rows keep the sponsor network open. Checked under
    // the distributed lock to close the check-then-book race.
    if (programId) {
      const panel = await tx.programConsultantAllowlist.findMany({
        where: { programId },
        select: { consultantProfileId: true },
      });
      if (
        panel.length > 0 &&
        !panel.some(
          (row) => row.consultantProfileId === plan.consultantProfileId,
        )
      ) {
        throw Object.assign(
          new Error(
            "This consultant is not on your organization's approved panel for this program. Choose a listed consultant or ask your organization admin.",
          ),
          { httpStatus: 409, code: "CONSULTANT_NOT_ON_PANEL" },
        );
      }
    }

    // ADR 18 — exclusiveEngagement blocks the consultant's independent
    // plans (no org ownership) while an ACTIVE membership declares
    // exclusivity. Org-owned plans stay bookable. The "hide" half
    // (marketplace visibility filtering) remains future work per the ADR.
    if (plan.consultantProfileId && !plan.organizationId) {
      const exclusive = await tx.membership.findFirst({
        where: {
          consultantProfileId: plan.consultantProfileId,
          exclusiveEngagement: true,
          status: "ACTIVE",
        },
        select: { id: true },
      });
      if (exclusive) {
        throw Object.assign(
          new Error(
            "This consultant works exclusively through their organization; their independent plans cannot be booked.",
          ),
          { httpStatus: 409, code: "CONSULTANT_EXCLUSIVE_ENGAGEMENT" },
        );
      }
    }

    // Re-validate slot availability based on appointment type
    switch (data.appointmentType) {
      case "CONSULTATION": {
        // Only validate if there are slots
        if (data.startsAt && data.endsAt) {
          // FIX: Fetch plan to get consultant user ID for filtering
          const consultationPlan = await tx.consultationPlan.findUnique({
            where: { id: data.planId },
            include: { consultantProfile: { include: { user: true } } },
          });
          if (!consultationPlan) throw new Error("Consultation plan not found");

          // #1463 — the buyer's User id, and the self-held appointments it
          // resolves are excluded from the consultee-side check below too.
          const { selfHoldAppointmentIds } = await validateSlotAvailability(
            tx,
            data,
            userId,
            consultationPlan.consultantProfile.user.id,
            orgContext?.organizationId ?? null,
            consultationPlan.consultantProfile.id,
          );

          // Consultee-side conflict check.
          //
          // validateNoConflicts (ScheduleValidationService) is scoped to the
          // consultant's User ID — it ensures the consultant is not double-booked
          // but says nothing about the learner's own calendar. A learner who is
          // a member of two orgs (e.g., Org A with SEAT_PACK and Org B with
          // PREPAID_UNLIMITED) faces zero cost friction on either side, making
          // it easy to accidentally book overlapping sessions with two different
          // consultants. Both would pass the consultant-side check because they
          // involve different consultants, leaving the learner double-booked.
          //
          // The same scenario exists on the open marketplace — any consultee can
          // book overlapping sessions with two different consultants. Enterprise
          // multi-org membership increases the probability because the learner
          // has multiple "free" billing paths with no payment step to slow them.
          //
          // This call is the CHEAP EARLY EXIT and nothing more: it runs under
          // the distributed consultee lock, in a transaction that COMMITS before
          // the booking is written. The authoritative re-assertion is the same
          // predicate read again inside the Serializable transaction that
          // creates the occurrence, where a rw-dependency forms and SSI aborts
          // one of a racing pair. See the arm in handleCheckout and
          // assertConsulteeHasNoOverlappingSession.
          await assertConsulteeHasNoOverlappingSession(tx, {
            userId,
            startsAt: data.startsAt!,
            endsAt: data.endsAt!,
            selfHoldAppointmentIds,
          });
        }
        break;
      }
      case "SUBSCRIPTION": {
        // Only validate if there are slots
        if (data.startsAt && data.endsAt) {
          // FIX: Fetch plan to get consultant user ID for filtering
          const subscriptionPlan = await tx.subscriptionPlan.findUnique({
            where: { id: data.planId },
            include: { consultantProfile: { include: { user: true } } },
          });
          if (!subscriptionPlan) throw new Error("Subscription plan not found");

          // #1463 — the buyer's User id; see the consultation arm above.
          const { selfHoldAppointmentIds } = await validateSlotAvailability(
            tx,
            data,
            userId,
            subscriptionPlan.consultantProfile.user.id,
            orgContext?.organizationId ?? null,
            subscriptionPlan.consultantProfile.id,
          );

          // Consultee-side conflict check for direct-slot subscriptions.
          // Same reasoning as the CONSULTATION case above — a subscription
          // booked with an explicit slot window must not overlap an existing
          // consultee appointment, regardless of which org or marketplace
          // context that prior appointment came from. This is the under-lock
          // early exit only, exactly as above.
          await assertConsulteeHasNoOverlappingSession(tx, {
            userId,
            startsAt: data.startsAt!,
            endsAt: data.endsAt!,
            selfHoldAppointmentIds,
          });
        }
        break;
      }

      case "WEBINAR": {
        if (!data.eventId) throw new Error("Event ID is required for webinar");

        const webinar = await tx.webinar.findUnique({
          where: { id: data.eventId },
          relationLoadStrategy: "join",
          include: {
            webinarPlan: {
              include: {
                consultantProfile: true,
              },
            },
            appointment: {
              // `participants` is load-bearing: without it the participant
              // count is silently 0 and this whole recheck is dead.
              include: {
                occurrences: true,
                participants: {
                  where: seatHoldingParticipant(new Date()),
                  select: { userId: true },
                },
              },
            },
          },
        });

        if (!webinar) throw new Error("Webinar not found");

        const plan = webinar.webinarPlan;
        const consultantUserId = plan.consultantProfile?.userId;
        const capacity = getWebinarCapacity({
          webinar,
          plan,
          excludeUserIds: consultantUserId ? [consultantUserId] : [],
        });

        if (capacity.isFull) {
          // #1757 — a coded refusal (EVENT_FULL, 409), not a fault; the tx
          // catch rethrows registered codes unchanged.
          throw Object.assign(new Error("Webinar is full"), {
            httpStatus: 409,
            code: "EVENT_FULL",
          });
        }

        for (const occ of webinar.appointment?.occurrences ?? []) {
          if (
            occ.startsAt &&
            occ.endsAt &&
            !occ.deletedAt &&
            occ.completionStatus !== "CANCELLED"
          ) {
            await assertConsulteeHasNoOverlappingSession(tx, {
              userId,
              startsAt: occ.startsAt,
              endsAt: occ.endsAt,
              selfHoldAppointmentIds: webinar.appointment
                ? [webinar.appointment.id]
                : [],
            });
          }
        }
        break;
      }

      case "CLASS": {
        if (!data.eventId) throw new Error("Event ID is required for class");

        const classInstance = await tx.class.findUnique({
          where: { id: data.eventId },
          include: {
            classPlan: {
              include: { consultantProfile: true },
            },
            appointment: {
              include: {
                occurrences: true,
                participants: {
                  where: seatHoldingParticipant(new Date()),
                  select: { userId: true },
                },
              },
            },
          },
        });

        if (!classInstance) throw new Error("Class not found");

        const ownerUserId = classInstance.classPlan.consultantProfile?.userId;
        const capacity = getClassCapacity({
          classInstance,
          plan: classInstance.classPlan,
          excludeUserIds: ownerUserId ? [ownerUserId] : [],
        });

        if (capacity.isFull) {
          // #1757 — a coded refusal (EVENT_FULL, 409), not a fault; the tx
          // catch rethrows registered codes unchanged.
          throw Object.assign(new Error("Class is full"), {
            httpStatus: 409,
            code: "EVENT_FULL",
          });
        }

        for (const occ of classInstance.appointment?.occurrences ?? []) {
          if (
            occ.startsAt &&
            occ.endsAt &&
            !occ.deletedAt &&
            occ.completionStatus !== "CANCELLED"
          ) {
            await assertConsulteeHasNoOverlappingSession(tx, {
              userId,
              startsAt: occ.startsAt,
              endsAt: occ.endsAt,
              selfHoldAppointmentIds: classInstance.appointment
                ? [classInstance.appointment.id]
                : [],
            });
          }
        }
        break;
      }

      default:
        throw new Error("Invalid appointment type");
    }

    // The org money state as it stood when the lock was taken. Read fresh at
    // the point of use rather than hoisted: the caller re-binds its locals to
    // this, so every rail decision downstream (skip the gateway, debit the
    // wallet, the PaymentLeg source, whose cancellation ladder binds) reads
    // the value this transaction saw rather than the one it hoped for.
    return freshOrgFunding;
  });
}
