// The only place checkout opens its booking transaction.

import prisma from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withSerializableRetry } from "@/lib/db/serializable-retry";
import { assertPlanExpertStandsInTx } from "@/lib/booking/expert-standing";
import { resolveCheckoutCancellationPolicyId } from "@/lib/payments/operations/cancellation-policy-store";
import { seatPayerOrganizationId } from "@/lib/data/org-sponsored-seats";
import { findSelfHoldAppointmentIds } from "@/lib/payments/checkout/self-hold";
import { assertConsulteeHasNoOverlappingSession } from "@/lib/payments/checkout/occupancy-validate";
import { handleClassCheckout } from "@/lib/payments/checkout/handlers/class";
import { handleWebinarCheckout } from "@/lib/payments/checkout/handlers/webinar";
import { handleSubscriptionCheckout } from "@/lib/payments/checkout/handlers/subscription";
import { handleConsultationCheckout } from "@/lib/payments/checkout/handlers/consultation";
import {
  assertWithinInvoiceCreditLimit,
  readInvoiceExposurePaise,
} from "@/lib/payments/checkout/org-funding";
import { recordCheckoutUtilization } from "@/lib/payments/checkout/commit/org-utilization";
import { recordSynchronousEarnings } from "@/lib/payments/checkout/commit/ledger";
import { settleCheckoutLegs } from "@/lib/payments/checkout/commit/payment-legs";
import { writeCheckoutPayment } from "@/lib/payments/checkout/commit/payment-row";
import type { CheckoutCommitInput } from "@/lib/payments/checkout/commit/types";
import type { PriorSeatPayment } from "@/lib/payments/checkout/seats";
import {
  readSeatJoin,
  stageFreeSeatNoticeTx,
} from "@/lib/payments/checkout/free-seat-notice";
import { stageCreditsApplied } from "@/lib/referrals/referral-notify";

/**
 * The booking transaction: Serializable, retried on P2034, with the slot grant
 * renewed at the top of every attempt. Nothing non-idempotent runs inside it.
 */
export async function commitCheckout(input: CheckoutCommitInput) {
  const {
    validatedData,
    userId,
    isMockPayment,
    renewOrAbort,
    perAttemptTtl,
    checkoutTxTimeoutMs,
    organizationId,
    fundingSource,
    creditEffectiveLimit,
    isOrgInvoicedPayment,
    isOrgSponsoredPayment,
    isZeroAmountPayment,
    preparedSeatNotice,
  } = input;
  const {
    amount,
    consulteeProfileId,
    classSessionsQuoted,
    subscriptionSchedulingPeriod,
  } = input.priced;

  return withSerializableRetry(async () => {
    await renewOrAbort(perAttemptTtl);
    return prisma.$transaction(
      async (tx) => {
        // Every attempt re-reads the expert's standing with the write: a reject
        // after the locked re-read refuses here, and the minted order is retired.
        await assertPlanExpertStandsInTx(
          tx,
          validatedData.appointmentType,
          validatedData.planId,
        );
        // #785 B6 — re-check the INVOICE credit limit INSIDE the Serializable
        // tx. The pre-lock check ran on the global client before this tx, so
        // two concurrent disjoint-slot bookings (which take different per-slot
        // locks) could both pass it. Reading the accrual set here — the same
        // rows this tx is about to add to — makes SSI abort one of a racing
        // pair; the retry then sees the sibling's committed accrual.
        if (
          isOrgInvoicedPayment &&
          creditEffectiveLimit !== null &&
          organizationId
        ) {
          const exposure = await readInvoiceExposurePaise(tx, organizationId);
          // Same gate as the pre-lock check, re-run inside the tx so a
          // concurrent sibling's just-committed accrual is visible — SSI then
          // aborts the loser of a racing pair instead of both straddling the cap.
          assertWithinInvoiceCreditLimit(
            exposure,
            amount,
            creditEffectiveLimit,
          );
        }

        let createdAppointment;
        // Engagement count for enterprise cap (issue #710). One
        // engagement = one Appointment row = one calendar occurrence.
        //   - CONSULTATION/WEBINAR: 1 (single Appointment created here)
        //   - CLASS: N (count of appointments the learner enrolled in,
        //     all known at checkout because consultant pre-allocated)
        //   - SUBSCRIPTION: null → SKIP recordBookingUtilization at
        //     checkout. Slots are allocated lazily by the consultant;
        //     debits land in createAppointments (lib/booking/allocation/commit),
        //     1 per allocation batch.
        let engagementsForCap: number | null = null;
        let classEngagementIds: string[] = [];
        let bookedPlan: {
          consultantProfileId?: string | null;
          organizationId?: string | null;
        } | null = null;
        let priorSeat: PriorSeatPayment | null = null;
        let eventPricePaise: number | null = null;

        const skipPayment =
          isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment;

        const cancellationPolicyId = await resolveCheckoutCancellationPolicyId(
          tx,
          {
            organizationId: isOrgSponsoredPayment ? organizationId : null,
          },
        );

        // A PERSONAL-rail booking is paid by the member's own card, so
        // Appointment.organizationId stays null (keeps the booking on the
        // buyer's personal dashboard rather than vanishing from personal
        // scope while Payment.organizationId retains the reporting tag).
        const appointmentOrganizationId =
          fundingSource === "PERSONAL" ? null : organizationId;

        // A direct-slot 1:1 (consultation or subscription) re-checks the
        // buyer's calendar inside the commit that writes the hold.
        const assertBuyerSlotFree = async () => {
          if (!validatedData.startsAt || !validatedData.endsAt) return;
          await assertConsulteeHasNoOverlappingSession(tx, {
            userId,
            startsAt: validatedData.startsAt,
            endsAt: validatedData.endsAt,
            selfHoldAppointmentIds: await findSelfHoldAppointmentIds(tx, {
              buyerUserId: userId,
              appointmentType: validatedData.appointmentType,
              planId: validatedData.planId,
              paymentGateway: validatedData.paymentGateway,
              organizationId,
              slotStart: new Date(validatedData.startsAt),
              slotEnd: new Date(validatedData.endsAt),
              now: new Date(),
            }),
          });
        };

        // Create appointment based on type (with isTentative flag)
        switch (validatedData.appointmentType) {
          case "CONSULTATION": {
            await assertBuyerSlotFree();
            const consultationResult = await handleConsultationCheckout(
              tx,
              validatedData,
              consulteeProfileId,
              userId,
              skipPayment,
              appointmentOrganizationId,
              cancellationPolicyId,
              organizationId,
            );
            createdAppointment = consultationResult.appointment;
            bookedPlan = consultationResult.plan;
            engagementsForCap = 1;
            break;
          }

          case "SUBSCRIPTION": {
            await assertBuyerSlotFree();
            const subscriptionResult = await handleSubscriptionCheckout(
              tx,
              validatedData,
              consulteeProfileId,
              skipPayment,
              appointmentOrganizationId,
              cancellationPolicyId,
              subscriptionSchedulingPeriod,
            );
            createdAppointment = subscriptionResult.appointment;
            bookedPlan = subscriptionResult.plan;
            break;
          }

          case "WEBINAR": {
            const webinarResult = await handleWebinarCheckout(
              tx,
              validatedData,
              userId,
              skipPayment,
              seatPayerOrganizationId(organizationId, isOrgSponsoredPayment),
            );
            for (const occ of webinarResult.appointment?.occurrences ?? []) {
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
                  selfHoldAppointmentIds: webinarResult.appointment
                    ? [webinarResult.appointment.id]
                    : [],
                });
              }
            }
            createdAppointment = webinarResult.appointment;
            bookedPlan = webinarResult.plan;
            priorSeat = webinarResult.priorSeat;
            eventPricePaise = webinarResult.amount;
            engagementsForCap = 1;
            break;
          }

          case "CLASS": {
            const classResult = await handleClassCheckout(
              tx,
              validatedData,
              userId,
              skipPayment,
              classSessionsQuoted,
              seatPayerOrganizationId(organizationId, isOrgSponsoredPayment),
            );
            for (const occ of classResult.appointment?.occurrences ?? []) {
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
                  selfHoldAppointmentIds: classResult.appointment
                    ? [classResult.appointment.id]
                    : [],
                });
              }
            }
            createdAppointment = classResult.appointment || null;
            bookedPlan = classResult.plan;
            priorSeat = classResult.priorSeat;
            eventPricePaise = classResult.amount;
            engagementsForCap = classResult.engagementsConsumed;
            classEngagementIds = classResult.engagementIds;
            break;
          }

          default:
            throw new Error(
              `Unsupported appointment type: ${validatedData.appointmentType}`,
            );
        }

        // A free seat's booked notice is keyed on the join this commit wrote.
        const seatJoin =
          isZeroAmountPayment &&
          createdAppointment &&
          (validatedData.appointmentType === "WEBINAR" ||
            validatedData.appointmentType === "CLASS")
            ? await readSeatJoin(tx, createdAppointment.id, userId)
            : null;
        const payment = await writeCheckoutPayment(tx, input, {
          createdAppointment,
          bookedPlan,
          skipPayment,
          priorSeat,
          eventPricePaise,
        });
        // No capture follows a free seat, so its booked notice commits with the join here.
        const seatNotice =
          seatJoin &&
          createdAppointment &&
          (validatedData.appointmentType === "WEBINAR" ||
            validatedData.appointmentType === "CLASS")
            ? await stageFreeSeatNoticeTx(tx, {
                appointmentId: createdAppointment.id,
                userId,
                appointmentType: validatedData.appointmentType,
                join: seatJoin,
                prepared: preparedSeatNotice,
              })
            : null;
        // A rejoined free seat revived on its earlier payment, whose legs and earnings already exist.
        if (payment.rejoined) {
          return {
            appointmentId: createdAppointment?.id,
            paymentId: payment.id,
            reusedPaymentIntent: payment.reusedPaymentIntent,
            seatNotice,
            holdExpiresAt: payment.expiresAt,
            creditsApplied: 0,
            creditNotices: {},
            capNearBell: null,
            overageBell: null,
          };
        }
        const { capNearBell, overageBell } = await recordCheckoutUtilization(
          tx,
          input,
          {
            createdAppointment,
            payment,
            engagementsForCap,
            classEngagementIds,
          },
        );
        const { actualCreditsApplied, creditsRemainingAfter } =
          await settleCheckoutLegs(tx, input, {
            payment,
          });
        await recordSynchronousEarnings(tx, input, { payment, skipPayment });
        // A gateway payment's notice waits for its capture; these rails never see one.
        const creditNotices =
          skipPayment && actualCreditsApplied > 0
            ? await stageCreditsApplied(tx, {
                userId,
                paymentId: payment.id,
                creditsUsedPaise: actualCreditsApplied,
                remainingPaise: creditsRemainingAfter ?? 0,
                appointmentType: validatedData.appointmentType,
              })
            : {};

        return {
          appointmentId: createdAppointment?.id,
          paymentId: payment.id,
          reusedPaymentIntent: null as string | null,
          seatNotice,
          holdExpiresAt: payment.expiresAt,
          creditsApplied: actualCreditsApplied,
          creditNotices,
          capNearBell,
          overageBell,
        };
      },
      {
        timeout: checkoutTxTimeoutMs,
        // H6 FIX: Use Serializable isolation for booking transactions to prevent
        // phantom reads on capacity-limited events (webinars, classes). The
        // distributed lock serializes per-event, but Serializable adds DB-level
        // safety for edge cases like lock expiry under high load.
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      },
    );
  });
}
