import { z } from "zod";

export const orgInfoSchema = z.object({
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100),
  billingEmail: z.string().email("Must be a valid email"),
  description: z.string().max(2000),
  industry: z.string(),
  sizeBucket: z.string(),
  website: z.string(),
});

export const billingSchema = z.object({
  billingMode: z.enum(["TAG_ONLY", "SEAT_PACK", "INVOICED_MONTHLY"]),
  paymentTermsDays: z.coerce.number().int().min(1).max(120),
  seatsTotal: z.coerce.number().int().positive().nullable(),
});

export const brandingSchema = z.object({
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color")
    .nullable()
    .optional(),
  secondaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/, "Must be a hex color")
    .nullable()
    .optional(),
});

export const inviteSchema = z.object({
  inviteEmails: z.array(z.string().email()).default([]),
  inviteRole: z.string().default("ORG_LEARNER"),
});

export type OrgInfoFormData = z.infer<typeof orgInfoSchema>;
export type BillingFormData = z.infer<typeof billingSchema>;
export type BrandingFormData = z.infer<typeof brandingSchema>;
export type InviteFormData = z.infer<typeof inviteSchema>;
