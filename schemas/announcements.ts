import { z } from "zod";
import {
  MAX_SHORT_FIELD_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/validation/input-limits";

// #831 — every user-typed string carries a .max()
const announcementFields = z.object({
  title: z.string().min(1, "Title is required").max(MAX_TITLE_LENGTH),
  content: z.string().min(1, "Content is required").max(MAX_TEXT_LENGTH),
  isActive: z.boolean().default(true),
  startDate: z.string().datetime().nullable().optional(),
  endDate: z.string().datetime().nullable().optional(),
  backgroundColor: z.string().max(MAX_SHORT_FIELD_LENGTH).default("#000000"),
  textColor: z.string().max(MAX_SHORT_FIELD_LENGTH).default("#FFFFFF"),
  linkUrl: z
    .string()
    .url()
    .max(MAX_TITLE_LENGTH)
    .refine((value) => /^https?:\/\//i.test(value), "Use an HTTP or HTTPS URL")
    .nullable()
    .optional(),
  linkText: z.string().max(MAX_TITLE_LENGTH).nullable().optional(),
});

function validWindow(value: {
  startDate?: string | null;
  endDate?: string | null;
}) {
  return (
    !value.startDate ||
    !value.endDate ||
    new Date(value.endDate) > new Date(value.startDate)
  );
}
export const CreateAnnouncementSchema = announcementFields.refine(validWindow, {
  message: "End must be after start",
  path: ["endDate"],
});
export const UpdateAnnouncementSchema = announcementFields
  .partial()
  .strict()
  .refine(validWindow, {
    message: "End must be after start",
    path: ["endDate"],
  });
export const announcementBellContextSchema = z.object({
  announcementId: z.string().min(1),
  revision: z.string().datetime(),
  title: z.string(),
  content: z.string(),
  startDate: z.string().datetime().nullable(),
  endDate: z.string().datetime().nullable(),
  linkUrl: z.string().optional(),
  linkText: z.string().optional(),
});
export const AnnouncementListQuerySchema = z.object({
  view: z.literal("manage").optional(),
});

export const AnnouncementListResponseSchema = z.object({
  success: z.literal(true),
  data: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      content: z.string(),
      isActive: z.boolean(),
      startDate: z.string().datetime().nullable(),
      endDate: z.string().datetime().nullable(),
      backgroundColor: z
        .string()
        .nullable()
        .transform((value) => value ?? "#000000"),
      textColor: z
        .string()
        .nullable()
        .transform((value) => value ?? "#FFFFFF"),
      linkUrl: z.string().nullable(),
      linkText: z.string().nullable(),
      createdAt: z.string().datetime(),
    }),
  ),
});
export type AnnouncementListItem = z.infer<
  typeof AnnouncementListResponseSchema
>["data"][number];
export const AnnouncementMutationResponseSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
});

export const ANNOUNCEMENT_CANCELLATION_REASONS = [
  "announcement:cancelled",
  "announcement:deleted",
  "announcement:inactive",
  "announcement:expired",
  "announcement:superseded",
] as const;
