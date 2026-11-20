/** What a learner reads when an expert's unpaid sale ends: neutral, never the expert's standing. */

/** "No payment was taken" only when no gateway order ever existed; otherwise the refund promise. */
export function moneyLine(orderExisted: boolean): string {
  return orderExisted
    ? "If you were charged, the money is refunded automatically."
    : "No payment was taken.";
}

/** The notice for a request, link, trial hold or seat the reject closed. */
export function closedRequestNotice(
  expertName: string,
  orderExisted: boolean,
): string {
  return `${expertName} isn't taking bookings right now, so your request was closed. ${moneyLine(orderExisted)}`;
}

/** The pay page for an order whose expert takes no bookings; no way back is offered. */
export function expertUnavailablePayMessage(orderExisted: boolean): string {
  return `This expert isn't taking bookings right now. ${moneyLine(orderExisted)}`;
}
