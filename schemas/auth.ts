import { z } from "zod";

export const DISPLAY_NAME_MAX = 80;

// The name is greeted in mail we send to any address typed at sign-up, and
// mail clients auto-link URLs, emails and phone numbers.
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/u;
const LINK_LIKE = /:\/\/|www\.|@|[\p{L}\p{N}-]\.[\p{L}]{2,}/iu;
const PHONE_LIKE = /\d{5,}/;

/** A display name: 1–80 characters, no control characters, links or phone numbers. */
export const DisplayNameSchema = z
  .string()
  .trim()
  .min(1, "Enter your name.")
  .refine((name) => [...name].length <= DISPLAY_NAME_MAX, {
    message: `Use at most ${DISPLAY_NAME_MAX} characters.`,
  })
  .refine((name) => !CONTROL_CHARS.test(name), {
    message: "Remove the hidden or control characters from your name.",
  })
  .refine((name) => !LINK_LIKE.test(name) && !PHONE_LIKE.test(name), {
    message: "Your name can't contain links, email addresses or phone numbers.",
  });
