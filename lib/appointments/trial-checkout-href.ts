import type { AppointmentVM } from "@/lib/appointments/view-model";
import { payLinkHref } from "@/lib/payments/pay-link-href";

/** The branded checkout page of a trial awaiting payment; null for every other booking. */
export function trialCheckoutHref(
  vm: Pick<AppointmentVM, "kind" | "trialId">,
): string | null {
  if (vm.kind !== "TRIAL" || !vm.trialId) return null;
  return `/checkout/plans/trial/${vm.trialId}`;
}

/**
 * #1775 P-1 — the one "Pay now" answer for a booking row: the trial's branded
 * page, else the pay page for a Razorpay order id, else a hosted https link.
 */
export function bookingPayHref(
  vm: Pick<
    AppointmentVM,
    "kind" | "trialId" | "pendingPaymentUrl" | "pendingPaymentId"
  >,
): string | null {
  return (
    trialCheckoutHref(vm) ??
    payLinkHref({
      paymentId: vm.pendingPaymentId,
      checkoutUrl: vm.pendingPaymentUrl,
    })
  );
}
