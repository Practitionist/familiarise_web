import { humanizeEnum } from "@/lib/ui/tone";

/** The reasons an expert can pick when reporting a review of themselves. */
export const REVIEW_REPORT_REASONS = [
  { value: "SPAM_OR_FAKE", label: "Spam or unverified claim" },
  { value: "HARASSMENT_OR_ABUSE", label: "Harassment or abusive language" },
  { value: "OFF_TOPIC", label: "Irrelevant or off-topic" },
  { value: "OTHER", label: "Other policy concern" },
] as const;

const LABEL_BY_CODE: Readonly<Record<string, string>> = Object.fromEntries(
  REVIEW_REPORT_REASONS.map((r) => [r.value, r.label]),
);

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

/** `ModerationReport.reason` is free text: known codes get their label, other codes are humanised, prose passes through. */
export function reportReasonLabel(reason: string): string {
  const known = LABEL_BY_CODE[reason];
  if (known) return known;
  return CODE_RE.test(reason) ? humanizeEnum(reason) : reason;
}
