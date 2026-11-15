import { z } from "zod";

/**
 * Notices that reach the recipient whatever their switches say, because the
 * other party changed the recipient's booking. Only erasure stops them.
 */
export const REQUIRED_NOTICE_KINDS = [
  "CANCELLED_BY_HOST",
  "REFUND_FROM_HOST_CANCEL",
  "RESCHEDULE_PROPOSED",
  "PROPOSAL_LAPSED",
  "SERIES_MOVED",
  "SEAT_RELEASED",
] as const;

export const RequiredNoticeKindSchema = z.enum(REQUIRED_NOTICE_KINDS);
export type RequiredNoticeKind = z.infer<typeof RequiredNoticeKindSchema>;

/** How Settings names each kind. */
export const REQUIRED_NOTICE_LABEL: Record<RequiredNoticeKind, string> = {
  CANCELLED_BY_HOST: "cancellations",
  REFUND_FROM_HOST_CANCEL: "refunds they cause",
  RESCHEDULE_PROPOSED: "proposed new times",
  PROPOSAL_LAPSED: "original times restored when a proposal lapses",
  SERIES_MOVED: "series moves",
  SEAT_RELEASED: "released seats",
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
export const ALWAYS_SENT_LINE = `Always sent: changes the other person makes to your booking (${REQUIRED_NOTICE_KINDS.map(
  (kind) => REQUIRED_NOTICE_LABEL[kind],
).join(", ")}).`;
