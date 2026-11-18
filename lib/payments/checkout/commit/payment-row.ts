// Writes the checkout's Payment row (or re-mints a buyer's dead seat payment
// in place) and links the participants to it, on the checkout tx.

import type { Tx } from "@/lib/prisma";
import {
  linkParticipantsToPayment,
  transitionParticipant,
} from "@/lib/booking/participants";
import { PaymentStatus } from "@prisma/client";
import { ENABLE_HOST_ORGS } from "@/lib/feature-flags";
import { BookingRuleError } from "@/lib/booking/booking-rule-error";
import { markEventWaitlistBooked } from "@/lib/booking/event-waitlist";
import { markAppointmentWindowsBooked } from "@/lib/booking/backup-interest";
import { tombstonePriorIntent } from "@/lib/payments/operations/prior-intent-tombstone";
import {
  assertSeatRemintable,
  priorSeatStanding,
  SEAT_CHECKOUT_OPEN_MESSAGE,
  type PriorSeatPayment,
} from "@/lib/payments/checkout/seats";
import type { CheckoutCommitInput } from "@/lib/payments/checkout/commit/types";
import { checkoutRequestFingerprint } from "@/lib/payments/operations/checkout-replay";

/** The checkout's payment; `rejoined` when a left free seat revived on its earlier payment. */
export type CheckoutPaymentRow = {
  id: string;
  amount: number;
  expiresAt: Date | null;
} & (
  | { rejoined: false }
  /** The reused payment's own stored intent, which the checkout answers with. */
  | { rejoined: true; reusedPaymentIntent: string }
);

export async function writeCheckoutPayment(
  tx: Tx,
  input: CheckoutCommitInput,
  carried: {
    createdAppointment: { id: string } | null | undefined;
    bookedPlan: {
      consultantProfileId?: string | null;
      organizationId?: string | null;
    } | null;
    skipPayment: boolean;
    /** The buyer's earlier payment on this event, read by the handler before its revive; null otherwise. */
    priorSeat: PriorSeatPayment | null;
  },
): Promise<CheckoutPaymentRow> {
  const {
    validatedData,
    userId,
    isMockPayment,
    mintedOrder,
    holdExpiresAt,
    organizationId,
    billingAccountId,
    isOrgWalletPayment,
    isOrgInvoicedPayment,
    isOrgLicensedPayment,
    isOrgSponsoredPayment,
    isZeroAmountPayment,
    displayCurrencyAtCheckout,
    exchangeRateAtCheckout,
  } = input;
  const {
    amount,
    originalAmount,
    taxAmount,
    currency,
    discountCodeId,
    consulteeBillingStateCode,
    buyerCountry: detectedBuyerCountry,
    isInternational,
    attributionSource,
    attributionReferralId,
    platformFeeBps,
    welcomeDiscountPaise,
    gstRegime,
  } = input.priced;
  const { createdAppointment, bookedPlan, skipPayment, priorSeat } = carried;

  let hostOrganizationId: string | null = null;
  if (ENABLE_HOST_ORGS) {
    const planOwnerOrgId = bookedPlan?.organizationId ?? null;
    if (
      bookedPlan?.consultantProfileId &&
      typeof tx.membership?.findFirst === "function"
    ) {
      const ownerMembership = planOwnerOrgId
        ? await tx.membership.findFirst({
            where: {
              consultantProfileId: bookedPlan.consultantProfileId,
              role: "EXPERT",
              status: "ACTIVE",
              organizationId: planOwnerOrgId,
              organization: { canHost: true, status: "ACTIVE" },
            },
            select: { organizationId: true },
          })
        : null;
      const hostMembership =
        ownerMembership ??
        (await tx.membership.findFirst({
          where: {
            consultantProfileId: bookedPlan.consultantProfileId,
            role: "EXPERT",
            status: "ACTIVE",
            organization: { canHost: true, status: "ACTIVE" },
          },
          orderBy: { createdAt: "asc" },
          select: { organizationId: true },
        }));
      hostOrganizationId = hostMembership?.organizationId ?? null;
    } else {
      hostOrganizationId = planOwnerOrgId;
    }
  }

  const paymentData = {
    amount,
    originalAmount,
    // The licence invoice books the GST; a licensed booking books none.
    taxAmount: isOrgLicensedPayment ? 0 : taxAmount,
    currency,
    paymentMethod: isOrgWalletPayment
      ? "WALLET"
      : isOrgInvoicedPayment
        ? "INVOICE"
        : isOrgLicensedPayment
          ? "LICENSE"
          : isZeroAmountPayment
            ? "CREDITS"
            : "CARD",
    paymentIntent: mintedOrder.id,
    clientIdempotencyKey:
      validatedData.clientIdempotencyKey ?? globalThis.crypto.randomUUID(),
    requestFingerprint: checkoutRequestFingerprint(validatedData),
    paymentGateway: validatedData.paymentGateway,
    paymentStatus: skipPayment
      ? PaymentStatus.SUCCEEDED
      : PaymentStatus.PENDING,
    isMockPayment:
      isMockPayment || isZeroAmountPayment || isOrgSponsoredPayment,
    discountCodeId,
    expiresAt: skipPayment ? null : holdExpiresAt,
    buyerCountry: detectedBuyerCountry,
    isInternational,
    displayCurrencyAtCheckout,
    exchangeRateAtCheckout,
    consumerStateCode:
      validatedData.consumerStateCode ?? consulteeBillingStateCode ?? null,
    organizationId,
    hostOrganizationId,
    billingAccountId,
    attributionSource,
    attributionReferralId,
    platformFeeBps,
    welcomeDiscountPaise:
      welcomeDiscountPaise > 0 ? welcomeDiscountPaise : null,
    gstRegime,
  };

  // Group events share one appointment, so a re-buy re-mints the buyer's dead row in place.
  const isEventSeat =
    validatedData.appointmentType === "WEBINAR" ||
    validatedData.appointmentType === "CLASS";
  const priorSeatPayment = isEventSeat ? priorSeat : null;
  const eventKind =
    validatedData.appointmentType === "CLASS" ? "CLASS" : "WEBINAR";
  let payment: CheckoutPaymentRow;
  if (
    priorSeatPayment &&
    priorSeatStanding(priorSeatPayment) === "REJOINABLE"
  ) {
    // A left price-free seat keeps its SUCCEEDED ₹0 payment; only an order still price-free
    // (no list price, so no credit or discount to settle) may revive it.
    if (
      !isZeroAmountPayment ||
      isOrgSponsoredPayment ||
      input.priced.originalAmount > 0
    ) {
      throw new BookingRuleError(
        "SEAT_REBUY_UNSUPPORTED",
        "You left this event earlier, and a seat you've left can't be bought again yet. Contact support if you'd like to rejoin.",
      );
    }
    payment = {
      id: priorSeatPayment.id,
      amount: priorSeatPayment.amount,
      expiresAt: null,
      rejoined: true,
      reusedPaymentIntent: priorSeatPayment.paymentIntent,
    };
  } else if (priorSeatPayment) {
    assertSeatRemintable(priorSeatPayment, eventKind);
    // The old order's identity, kept apart from the row the CAS is about to rewrite.
    const retiringIntent = { ...priorSeatPayment };
    const reminted = await tx.payment.updateMany({
      where: {
        id: priorSeatPayment.id,
        paymentStatus: {
          in: [PaymentStatus.EXPIRED, PaymentStatus.FAILED],
        },
      },
      data: {
        ...paymentData,
        gatewayPaymentId: null,
        // A seat confirmed here is sold now; the row's createdAt is the lapsed attempt's.
        capturedAt: skipPayment ? new Date() : null,
        deletedAt: null,
        description: null,
        receiptUrl: null,
        referralReleasedAt: null,
      },
    });
    if (reminted.count !== 1) {
      throw new BookingRuleError(
        "PAYMENT_ALREADY_EXISTS",
        SEAT_CHECKOUT_OPEN_MESSAGE,
      );
    }
    await tombstonePriorIntent(
      tx,
      retiringIntent,
      "seat re-bought after the earlier payment lapsed or failed",
    );
    // A re-bought seat is a new sale: its fully reversed utilization re-opens on
    // today's assignment so checkout meters it once more; the id set dedupes replays.
    if (input.programAssignmentId) {
      await tx.bookingUtilization.updateMany({
        where: { paymentId: priorSeatPayment.id, reversedAt: { not: null } },
        data: {
          programAssignmentId: input.programAssignmentId,
          appointmentIds: [],
          reversedAt: null,
          reversalReason: null,
          wasOverage: false,
        },
      });
    }
    payment = {
      id: priorSeatPayment.id,
      amount,
      expiresAt: paymentData.expiresAt,
      rejoined: false,
    };
  } else {
    const created = await tx.payment.create({
      data: {
        ...paymentData,
        userId: userId,
        appointmentId: createdAppointment?.id || null,
      },
      select: { id: true, amount: true, expiresAt: true },
    });
    payment = { ...created, rejoined: false };
  }

  if (
    validatedData.consumerStateCode &&
    validatedData.consumerStateCode !== consulteeBillingStateCode
  ) {
    await tx.consulteeProfile.updateMany({
      where: { userId },
      data: { billingStateCode: validatedData.consumerStateCode },
    });
  }

  if (createdAppointment) {
    const participantWhere =
      validatedData.appointmentType === "CLASS" && validatedData.eventId
        ? { appointment: { classId: validatedData.eventId }, userId }
        : validatedData.appointmentType === "WEBINAR"
          ? { appointmentId: createdAppointment.id, userId }
          : { appointmentId: createdAppointment.id };
    if (validatedData.appointmentType === "CLASS" && validatedData.eventId) {
      await tx.appointmentParticipant.updateMany({
        where: { ...participantWhere, paymentId: null },
        data: { paymentId: payment.id },
      });
    } else {
      await linkParticipantsToPayment(
        tx,
        createdAppointment.id,
        payment.id,
        validatedData.appointmentType === "WEBINAR" ? userId : undefined,
      );
    }
    if (skipPayment) {
      await transitionParticipant(tx, participantWhere, "CONFIRMED");
      if (isEventSeat) {
        await markEventWaitlistBooked(
          tx,
          createdAppointment.id,
          userId,
          new Date(),
        );
      } else {
        // No capture follows a booking confirmed here, so its waits close now.
        await markAppointmentWindowsBooked(tx, createdAppointment.id, userId);
      }
    }
  }
  return payment;
}
