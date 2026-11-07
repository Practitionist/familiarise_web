import { z } from "zod";
import { carriesCredential } from "./classify";
import { isErasedRecipient } from "./erased-recipient";
import { HELD_PRE_LAUNCH } from "./held";
import { providerWindowRefusal } from "@/lib/retry/provider-window";

export const emailReplayRefusalSchema = z.enum([
  "not_dead_letter",
  "credential",
  "pre_launch_hold",
  "already_accepted",
  "recipient_policy",
  "provider_review",
  "render_failed",
]);
export type EmailReplayRefusal = z.infer<typeof emailReplayRefusalSchema>;

export const EMAIL_REPLAY_EXPLANATIONS: Record<EmailReplayRefusal, string> = {
  not_dead_letter: "This message is already queued or accepted.",
  credential: "Request a fresh verification, reset or invitation message.",
  pre_launch_hold:
    "Pre-launch mail stays held. Start a fresh approved journey for a real recipient.",
  already_accepted:
    "Provider acceptance is recorded. Check its delivery evidence.",
  recipient_policy:
    "The recipient's preferences or suppression stopped this message. Review the source journey.",
  provider_review:
    "The provider may have accepted this over 23 hours ago and its duplicate guard has lapsed. Check delivery before sending anything new.",
  render_failed:
    "This message never rendered, so there is nothing to send. Fix the template, then tell the recipient from the source record.",
};

/** A message whose template threw: a body-less row that records the miss and never sends. */
export const RENDER_FAILED = "review:render_failed";

/** Expected outcomes, not failures: they never page and never count as dead letters. */
export const EXPECTED_REFUSAL_PREFIXES = ["policy:", "suppressed:"] as const;

/** Why an operator may not requeue this row as-is; null when a replay is safe. */
export function emailReplayRefusal(
  row: {
    recipient: string;
    status: string;
    emailType: string;
    lastError: string | null;
    resendId: string | null;
    sentAt: Date | null;
    firstAttemptAt: Date | null;
  },
  now: Date,
): EmailReplayRefusal | null {
  if (row.resendId || row.sentAt) return "already_accepted";
  if (carriesCredential(row.emailType)) return "credential";
  if (row.lastError === HELD_PRE_LAUNCH) return "pre_launch_hold";
  if (row.lastError === RENDER_FAILED) return "render_failed";
  if (row.status !== "DEAD_LETTER") return "not_dead_letter";
  if (isErasedRecipient(row.recipient)) return "recipient_policy";
  if (EXPECTED_REFUSAL_PREFIXES.some((p) => row.lastError?.startsWith(p)))
    return "recipient_policy";
  if (providerWindowRefusal(row.firstAttemptAt, now)) return "provider_review";
  return null;
}
