import { z } from "zod";

const INDIAN_MOBILE_RE = /^(?:\+91|91|0)?([6-9]\d{9})$/;
const E164_RE = /^\+[1-9]\d{7,14}$/;
const REPEATED_DIGITS_RE = /(\d)\1{9,}/;
const CALLBACK_TAG_PREFIX = "[callback requested:";

/** Validate and canonicalize Indian mobile or E.164 phone numbers without repeating-digit placeholders. */
export const callbackPhoneSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s()-]/g, ""))
  .refine((value) => !REPEATED_DIGITS_RE.test(value), {
    message: "Invalid phone number",
  })
  .transform((value, ctx) => {
    const indianMatch = INDIAN_MOBILE_RE.exec(value);
    if (indianMatch) {
      return `+91${indianMatch[1]}`;
    }
    if (E164_RE.test(value)) {
      return value;
    }
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "Enter a valid Indian mobile or international E.164 phone number",
    });
    return z.NEVER;
  });

/** Remove any case-insensitive `[Callback Requested: ...]` substrings in linear time. */
export function stripCallbackTags(input: string): string {
  const lower = input.toLowerCase();
  let result = "";
  let cursor = 0;

  while (cursor < input.length) {
    const tagStart = lower.indexOf(CALLBACK_TAG_PREFIX, cursor);
    if (tagStart === -1) {
      result += input.slice(cursor);
      break;
    }
    const tagEnd = input.indexOf("]", tagStart + CALLBACK_TAG_PREFIX.length);
    if (tagEnd === -1) {
      result += input.slice(cursor);
      break;
    }
    result += input.slice(cursor, tagStart);
    cursor = tagEnd + 1;
  }

  return result;
}
