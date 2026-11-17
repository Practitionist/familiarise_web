/** The entity trace's shapes, shared by the server reader and the client view. */

export const TRACE_KINDS = ["payment", "appointment", "user"] as const;
export type TraceKind = (typeof TRACE_KINDS)[number];

/** Each source the trace reads, in the order rows with equal timestamps sort. */
export const TRACE_SOURCES = [
  "payment",
  "leg",
  "ledger",
  "earnings",
  "hold",
  "payout",
  "invoice",
  "refund",
  "creditNote",
  "dispute",
  "booking",
  "support",
  "opsAction",
  "systemEvent",
] as const;
export type TraceSource = (typeof TRACE_SOURCES)[number];

export interface TraceRow {
  /** Unique across the trace: source, row id and event. */
  key: string;
  at: string;
  source: TraceSource;
  status: string;
  amountPaise: number | null;
  currency: string | null;
  /** A person's name, or null for a system writer (webhook, sweep, job). */
  actor: string | null;
  detail: string | null;
  /** The domain row's own id, for the Sentry search and the audit-log filter. */
  entityId: string;
  sentryHref: string | null;
}

export interface TraceSourceReport {
  source: TraceSource;
  rows: number;
  /** The source hit its row cap; older rows exist and are not shown. */
  truncated: boolean;
  /** The read failed; the rest of the trace still rendered. */
  failed: boolean;
}

export interface EntityTrace {
  kind: Exclude<TraceKind, "user">;
  id: string;
  paymentIds: string[];
  appointmentId: string | null;
  userId: string | null;
  /** The buyer of the first payment, named as every console screen names a person. */
  customer: { id: string; name: string | null; email: string | null } | null;
  sentryHref: string | null;
  rows: TraceRow[];
  sources: TraceSourceReport[];
}

/** What a user id resolves to: their recent payments and bookings to pick from. */
export interface TraceCandidates {
  userId: string;
  name: string;
  payments: {
    id: string;
    amountPaise: number;
    currency: string;
    status: string;
    createdAt: string;
  }[];
  appointments: {
    id: string;
    type: string;
    role: string;
    createdAt: string;
  }[];
}

/** Where one entity's trace opens in the console. */
export const traceHref = (basePath: string, kind: TraceKind, id: string) =>
  `${basePath}/trace?kind=${kind}&id=${encodeURIComponent(id)}`;
