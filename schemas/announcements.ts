import { z } from "zod";
import {
  MAX_SHORT_FIELD_LENGTH,
  MAX_TEXT_LENGTH,
  MAX_TITLE_LENGTH,
} from "@/lib/validation/input-limits";

// #831 — every user-typed string carries a .max()
export const CreateAnnouncementSchema = z.object({
  title: z.string().min(1, "Title is required").max(MAX_TITLE_LENGTH),
  content: z.string().min(1, "Content is required").max(MAX_TEXT_LENGTH),
  isActive: z.boolean().default(true),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  backgroundColor: z.string().max(MAX_SHORT_FIELD_LENGTH).default("#000000"),
  textColor: z.string().max(MAX_SHORT_FIELD_LENGTH).default("#FFFFFF"),
  linkUrl: z.string().url().max(MAX_TITLE_LENGTH).nullish(),
  linkText: z.string().max(MAX_TITLE_LENGTH).nullish(),
  /** Create-time action, not stored: also ring every eligible user's bell. */
  postToInbox: z.boolean().default(false),
});
