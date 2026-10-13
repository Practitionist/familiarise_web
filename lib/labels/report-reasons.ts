import { humanizeEnum } from "@/lib/ui/tone";
import { REVIEW_REPORT_REASONS } from "@/schemas/moderation";

export { REVIEW_REPORT_REASONS };

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
