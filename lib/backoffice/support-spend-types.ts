import type { OpsLogFilters } from "@/schemas/ops-log";
import type { TargetRef } from "./money-list-schemas";

/** One payment an operator refunded, cancelled or held inside the spend window. */
export interface SupportSpendPayment {
  paymentId: string;
  /** Who paid, and for which booking. */
  target: TargetRef | null;
  /** Live refunds and approved, unvoided support remedies on the payment from every door: what the per-payment limit counts. */
  supportCommittedPaise: number;
  /** This operator's platform-cancel refunds on the payment in the window; also inside `supportCommittedPaise`. */
  platformCancelPaise: number;
  /** What the per-payment staff limit still allows; null for an operator without staff limits. */
  remainingPerPaymentPaise: number | null;
  holdsApplied: number;
}

export interface SupportSpendOperator {
  userId: string;
  name: string;
  role: string;
  /** True when the staff refund limits apply to this operator. */
  capped: boolean;
  refunds: {
    /** Since IST midnight today. */
    istDayPaise: number;
    /** The trailing 24 hours: the basis the refund doors enforce. */
    rolling24hPaise: number;
    rolling30dPaise: number;
    count30d: number;
    /** The platform-cancel share of `rolling30dPaise`. */
    platformCancel30dPaise: number;
    /** Older group platform cancels whose ops row lacks the per-payment split. */
    platformCancelUnsplit30dPaise: number;
  };
  /** Daily staff limit minus `rolling24hPaise`, floored at 0; null without staff limits. */
  remainingDailyCapPaise: number | null;
  holds: {
    appliedIstDay: number;
    applied30d: number;
    released30d: number;
    /** Summed from holds whose ops row records `heldPaise`. */
    heldPaise30d: number;
    /** Holds recorded before `heldPaise` was logged: counted, with no amount. */
    appliedWithoutAmount30d: number;
  };
  payments: SupportSpendPayment[];
  /** Audit-log filters for this operator's rows behind each figure, over the 30-day window. */
  audit: {
    supportRefunds: OpsLogFilters;
    platformCancels: OpsLogFilters;
    holdsApplied: OpsLogFilters;
  };
}

export interface SupportSpendReport {
  /** One page of operators, by name; each operator's figures are whole. */
  operators: SupportSpendOperator[];
  total: number;
  page: number;
  pageSize: number;
  windows: {
    istDayStart: string;
    rolling24hStart: string;
    rolling30dStart: string;
  };
  /** The enforced staff limits, read from the money policy. */
  caps: { perPaymentPaise: number; rolling24hPaise: number };
  fetchedAt: string;
}
