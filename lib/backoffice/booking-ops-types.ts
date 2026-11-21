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
    /** The issue door's own answer (`refundDoorRefusal`): false when it would refuse this payment. */
    refundable: boolean;
  }[];
  /** Event attendees whose removal still blocks a rejoin, for the lift door. */
  removedSeats: {
    userId: string;
    name: string | null;
    /** LEGACY: a free seat released with no recorded leave, which only staff can open again. */
    removal: "ORGANISER" | "CONDUCT" | "LEGACY";
    /** Paid, credit-funded, or on an event since priced: lifting lets support rejoin them, not a self-serve rebuy. */
    paidSeat: boolean;
    /** A conduct removal's latest case, decided or not; null for any other removal. */
    conductCase: "DECIDED" | "UNDECIDED" | null;
  }[];
}
