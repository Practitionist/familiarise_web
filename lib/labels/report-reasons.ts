import { humanizeEnum } from "@/lib/ui/tone";
import {
  MODERATION_REASON_LABELS,
  REVIEW_REPORT_REASONS,
} from "@/schemas/moderation";

export { REVIEW_REPORT_REASONS };

const LABEL_BY_CODE: Readonly<Record<string, string>> =
  MODERATION_REASON_LABELS;

const CODE_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * `ModerationReport.reason` is the human label of the ground a report was
 * filed on. A report written before the typed code existed stored the code
 * there instead, so a known code still reads as its label; anything else is
 * humanised when it looks like a code and passes through as prose.
 */
export function reportReasonLabel(reason: string): string {
  const known = LABEL_BY_CODE[reason];
  if (known) return known;
  return CODE_RE.test(reason) ? humanizeEnum(reason) : reason;
}
