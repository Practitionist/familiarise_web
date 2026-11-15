import { formatCurrencyAmount } from "@/utils/formatting";

/** A refund still PENDING at the gateway has started; only settlement may say it arrived. */
export function refundStartedText(
  amountPaise: number,
  currency: string,
): string {
  return `Your ${formatCurrencyAmount(amountPaise, currency)} refund has started and usually reaches you in 5–7 working days.`;
}

/** The line a cancel-time notice carries: started while pending, on its way once settled. */
export function refundNoticeText(
  amountPaise: number,
  currency: string,
  pending: boolean,
): string {
  return pending
    ? refundStartedText(amountPaise, currency)
    : `A refund of ${formatCurrencyAmount(amountPaise, currency)} is on its way`;
}
