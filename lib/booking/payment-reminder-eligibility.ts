type ReminderPayment = {
  paymentStatus: string;
  createdAt: Date;
  expiresAt: Date | null;
};

/** A manual reminder reuses the newest pending order only while it can be paid. */
export function liveReminderPayment<P extends ReminderPayment>(
  request: {
    status: string;
    pendingPaymentUrl: string | null;
    requestedBy: { user: { email: string | null } } | null;
    appointment: { payment: readonly P[] } | null;
  },
  now: Date,
): (P & { expiresAt: Date }) | null {
  if (
    request.status !== "APPROVED_PENDING_PAYMENT" ||
    !request.pendingPaymentUrl ||
    !request.requestedBy?.user.email ||
    !request.appointment
  ) {
    return null;
  }
  const payment = request.appointment.payment.reduce<P | null>(
    (latest, candidate) =>
      candidate.paymentStatus === "PENDING" &&
      (!latest || candidate.createdAt > latest.createdAt)
        ? candidate
        : latest,
    null,
  );
  if (!payment?.expiresAt || payment.expiresAt <= now) return null;
  return { ...payment, expiresAt: payment.expiresAt };
}
