import { z } from "zod";

export const cookiePreferencesSchema = z.object({
  essential: z.literal(true),
  analytics: z.boolean(),
  marketing: z.boolean(),
});
export type CookiePreferences = z.infer<typeof cookiePreferencesSchema>;
export const cookiePreferenceUpdateSchema = cookiePreferencesSchema
  .omit({ essential: true })
  .partial()
  .strict()
  .refine(
    (value) => Object.keys(value).length > 0,
    "Choose at least one preference",
  );
export type CookiePreferenceUpdate = z.infer<
  typeof cookiePreferenceUpdateSchema
>;
