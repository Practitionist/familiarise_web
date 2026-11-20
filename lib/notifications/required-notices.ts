import { z } from "zod";
import { NOVU_WORKFLOWS } from "@/lib/novu/workflows";

/**
 * Notices that reach the recipient whatever their switches say, because
 * someone else changed the recipient's booking or their place on a plan's
 * team. Only erasure stops them.
 */
export const REQUIRED_NOTICE_KINDS = [
  "CANCELLED_BY_HOST",
  "CANCELLED_BY_STAFF",
  "REFUND_FROM_HOST_CANCEL",
  "REFUND_FROM_STAFF_CANCEL",
  "REQUEST_DECLINED",
  "RESCHEDULE_PROPOSED",
  "PROPOSAL_LAPSED",
  "PROPOSAL_WITHDRAWN",
  "MOVE_AUTO_CONFIRMED",
  "SERIES_MOVED",
  "EVENT_MOVED",
  "SEAT_RELEASED",
  "CLASS_SESSION_REFUNDED",
  "COLLABORATION_CHANGED",
  "COHOST_CHANGED",
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
  PROPOSAL_WITHDRAWN: "withdrawn proposals",
  MOVE_AUTO_CONFIRMED: "moves that confirmed automatically",
  SERIES_MOVED: "class and webinar time changes",
  EVENT_MOVED: "class and webinar time changes",
  SEAT_RELEASED: "removed seats",
  CLASS_SESSION_REFUNDED: "refunds for class sessions the host missed",
  COLLABORATION_CHANGED:
    "co-hosting invitations and what the other side does with them",
  COHOST_CHANGED: "a co-host joining or leaving a class or webinar you booked",
};

/** Who a required notice can reach; `alwaysSentNotices` reads it against the viewer. */
export type NoticeAudience =
  "everyone" | "booker" | "expert" | "reviewer" | "compliance";

/** Co-hosting notices reach experts; every other kind reaches whoever booked. */
export const REQUIRED_NOTICE_AUDIENCE: Record<
  RequiredNoticeKind,
  NoticeAudience
> = {
  CANCELLED_BY_HOST: "booker",
  CANCELLED_BY_STAFF: "booker",
  REFUND_FROM_HOST_CANCEL: "booker",
  REFUND_FROM_STAFF_CANCEL: "booker",
  REQUEST_DECLINED: "booker",
  RESCHEDULE_PROPOSED: "booker",
  PROPOSAL_LAPSED: "booker",
  PROPOSAL_WITHDRAWN: "booker",
  MOVE_AUTO_CONFIRMED: "booker",
  SERIES_MOVED: "booker",
  EVENT_MOVED: "booker",
  SEAT_RELEASED: "booker",
  CLASS_SESSION_REFUNDED: "booker",
  COLLABORATION_CHANGED: "expert",
  COHOST_CHANGED: "booker",
};

type SystemNotice = { label: string; audience: NoticeAudience };
const ACCOUNT: SystemNotice = {
  label: "account and security notices",
  audience: "everyone",
};
const MODERATION: SystemNotice = {
  label: "moderation decisions",
  audience: "everyone",
};

/** The `required: true` templates in `lib/novu/templates`, named for Settings; a test pins the key set to them. */
export const REQUIRED_WORKFLOW_NOTICES: Readonly<Record<string, SystemNotice>> =
  {
    [NOVU_WORKFLOWS.ACCOUNT_SECURITY_NOTICE]: ACCOUNT,
    [NOVU_WORKFLOWS.ACCOUNT_SUSPENDED]: ACCOUNT,
    [NOVU_WORKFLOWS.ACCOUNT_BANNED]: ACCOUNT,
    [NOVU_WORKFLOWS.MODERATION_WARNING]: MODERATION,
    [NOVU_WORKFLOWS.CONTENT_REMOVED_NOTICE]: MODERATION,
    [NOVU_WORKFLOWS.VERIFICATION_STATUS_CHANGED]: {
      label: "profile verification updates",
      audience: "expert",
    },
    [NOVU_WORKFLOWS.NEW_CONSULTANT_APPLICATION]: {
      label: "new expert applications",
      audience: "reviewer",
    },
    [NOVU_WORKFLOWS.COMPLIANCE_DEADLINE_ALERT]: {
      label: "compliance deadline alerts",
      audience: "compliance",
    },
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
