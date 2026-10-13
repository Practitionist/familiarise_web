import { z } from "zod";

/** A stored, user-supplied link: absolute and https only, so it never renders a `javascript:` href. */
export const HttpsUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => new URL(value).protocol === "https:", {
    message: "Use an https:// link",
  });

/** The value when it is an https URL, else null — for rendering stored links as hrefs. */
export function httpsHref(value: string | null | undefined): string | null {
  return value && HttpsUrlSchema.safeParse(value).success ? value : null;
}
