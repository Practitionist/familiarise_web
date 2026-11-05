import { z } from "zod";
import { carriesCredential } from "./classify";
import { HELD_PRE_LAUNCH } from "./held";
import { providerWindowRefusal } from "@/lib/retry/provider-window";

export const emailReplayRefusalSchema = z.enum([
  "not_dead_letter",
  "credential",
  "pre_launch_hold",
  "already_accepted",
  "recipient_policy",
  "provider_review",
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
    "Recipient eligibility stopped this message. Review the source journey.",
  provider_review:
    "Check provider acceptance before issuing a fresh message. Replaying this key may duplicate mail.",
};

export function emailReplayRefusal(
  row: {
    status: string;
    emailType: string;
    lastError: string | null;
    resendId: string | null;
    sentAt: Date | null;
    createdAt: Date;
  },
  now: Date,
): EmailReplayRefusal | null {
  if (row.resendId || row.sentAt) return "already_accepted";
  if (carriesCredential(row.emailType)) return "credential";
  if (row.lastError === HELD_PRE_LAUNCH) return "pre_launch_hold";
  if (row.status !== "DEAD_LETTER") return "not_dead_letter";
  if (
    row.lastError?.startsWith("policy:") ||
    row.lastError?.startsWith("suppressed:")
  )
    return "recipient_policy";
  if (
    row.lastError?.startsWith("review:") ||
    providerWindowRefusal(row.createdAt, now)
  )
    return "provider_review";
  return null;
}
