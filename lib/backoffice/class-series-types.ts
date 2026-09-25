import type { SeriesLedger } from "@/lib/booking/class-series";

/** #1771 K-6 — the Class-series tab's read, shared by the route and the client. */
export interface ClassSeriesView {
  classId: string;
  appointmentId: string;
  title: string;
  status: string;
  series: SeriesLedger;
  reliability: { active: boolean; since: string | null };
  upcoming: { id: string; ordinal: number; startsAt: string }[];
  cancelledSessions: {
    id: string;
    ordinal: number;
    startsAt: string;
    hostCancelledAt: string;
    seatsSettledAt: string | null;
    makeUp: { id: string; startsAt: string } | null;
  }[];
  seats: {
    userId: string;
    name: string | null;
    status: string;
    paymentId: string | null;
    rail: string | null;
    valuePaise: number;
    unitPaise: number;
    delivered: number;
    held: number;
    occRefundedPaise: number;
  }[];
}
