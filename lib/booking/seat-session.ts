/**
 * Whether a missed session is owed to a seat: the rule the void settlement
 * applies, shared with the notice that promises its refund.
 */

/** When a seat funded by this payment could first attend: the later of the two rows. */
export function seatJoinedAt(
  seat: { createdAt: Date },
  payment?: { createdAt: Date } | null,
): Date {
  return new Date(
    Math.max(seat.createdAt.getTime(), payment?.createdAt.getTime() ?? 0),
  );
}

/**
 * Only a seat that held the session is owed for it: one that joined after it
 * started is owed nothing, and a paid seat still HELD is a human's call.
 */
export function seatSessionClaim(
  session: { startsAt: Date },
  seat: { createdAt: Date; status: string },
  payment: { createdAt: Date },
): "none" | "human" | "refund" {
  if (session.startsAt <= seatJoinedAt(seat, payment)) return "none";
  return seat.status === "HELD" ? "human" : "refund";
}
