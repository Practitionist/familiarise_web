import { z } from "zod";

/**
 * Notices that reach the recipient whatever their switches say, because
 * someone else changed the recipient's booking. Only erasure stops them.
 */
export const REQUIRED_NOTICE_KINDS = [
  "CANCELLED_BY_HOST",
  "CANCELLED_BY_STAFF",
  "REFUND_FROM_HOST_CANCEL",
  "REFUND_FROM_STAFF_CANCEL",
  "REQUEST_DECLINED",
  "RESCHEDULE_PROPOSED",
  "PROPOSAL_LAPSED",
  "MOVE_AUTO_CONFIRMED",
  "SERIES_MOVED",
  "EVENT_MOVED",
  "SEAT_RELEASED",
  "CLASS_SESSION_REFUNDED",
] as const;

export const RequiredNoticeKindSchema = z.enum(REQUIRED_NOTICE_KINDS);
export type RequiredNoticeKind = z.infer<typeof RequiredNoticeKindSchema>;

/** How Settings names each kind; kinds that share a label are named once. */
export const REQUIRED_NOTICE_LABEL: Record<RequiredNoticeKind, string> = {
  CANCELLED_BY_HOST: "cancellations by your expert, host or our staff",
  CANCELLED_BY_STAFF: "cancellations by your expert, host or our staff",
  REFUND_FROM_HOST_CANCEL: "the refunds those cause",
  REFUND_FROM_STAFF_CANCEL: "the refunds those cause",
  REQUEST_DECLINED: "declined requests",
  RESCHEDULE_PROPOSED: "proposed new times",
  PROPOSAL_LAPSED: "original times restored when a proposal lapses",
  MOVE_AUTO_CONFIRMED: "moves that confirmed automatically",
  SERIES_MOVED: "class and webinar time changes",
  EVENT_MOVED: "class and webinar time changes",
  SEAT_RELEASED: "removed seats",
  CLASS_SESSION_REFUNDED: "refunds for class sessions the host missed",
};

/** A per-send override: these recipients get this notice whatever their switches say. */
export type RequiredOverride = {
  kind: RequiredNoticeKind;
  recipients: readonly string[];
};

/** The bell outbox payload field that carries the override to every attempt. */
export const REQUIRED_NOTICE_FIELD = "requiredNotice";

const RequiredPayloadSchema = z.object({
  [REQUIRED_NOTICE_FIELD]: RequiredNoticeKindSchema,
});

/** The kind a staged bell payload was required for, or null. */
export function requiredNoticeOf(payload: unknown): RequiredNoticeKind | null {
  const parsed = RequiredPayloadSchema.safeParse(payload);
  return parsed.success ? parsed.data[REQUIRED_NOTICE_FIELD] : null;
}

/** The Settings line; built from the kinds so the copy cannot drift from the rule. */
export const ALWAYS_SENT_LINE = `Always sent: changes someone else makes to your booking (${[
  ...new Set(REQUIRED_NOTICE_KINDS.map((kind) => REQUIRED_NOTICE_LABEL[kind])),
].join(", ")}).`;
