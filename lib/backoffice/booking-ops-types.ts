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
}
