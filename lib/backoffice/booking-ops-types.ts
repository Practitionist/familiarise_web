import type {
  AppointmentsType,
  OccurrenceCompletionStatus,
  OccurrenceOutcome,
  PaymentStatus,
} from "@prisma/client";

/** #1771 — the per-booking Ops actions panel's read, shared by route and client. */
export interface BookingOpsView {
  appointmentId: string;
  type: AppointmentsType;
  classId: string | null;
  subscriptionId: string | null;
  sessions: {
    id: string;
    ordinal: number;
    startsAt: string;
    endsAt: string;
    completionStatus: OccurrenceCompletionStatus;
    outcome: OccurrenceOutcome | null;
  }[];
  payments: {
    id: string;
    status: PaymentStatus;
    amountPaise: number;
    currency: string;
    /** Refunds that moved, or are moving, money. */
    refundedPaise: number;
    pendingRefundPaise: number;
  }[];
  /** Event attendees whose removal still blocks a rejoin, for the lift door. */
  removedSeats: {
    userId: string;
    name: string | null;
    removal: "ORGANISER" | "CONDUCT";
    /** Paid or credit-funded: lifting lets support rejoin them, not a self-serve rebuy. */
    paidSeat: boolean;
  }[];
}
