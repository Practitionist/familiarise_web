import { z } from "zod";

export const CreateAnnouncementSchema = z.object({
  title: z.string().min(1, "Title is required"),
  content: z.string().min(1, "Content is required"),
  isActive: z.boolean().default(true),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  backgroundColor: z.string().default("#000000"),
  textColor: z.string().default("#FFFFFF"),
  linkUrl: z.string().url().optional(),
  linkText: z.string().optional(),
});

export type CreateAnnouncementInput = z.infer<typeof CreateAnnouncementSchema>;
