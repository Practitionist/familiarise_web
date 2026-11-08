import { z } from "zod";

/** The stored newsletter batch, as `app/api/admin/newsletter/broadcast` writes it. */
export const batchMessagesSchema = z
  .array(
    z
      .object({
        from: z.string().min(1),
        to: z.string().min(1),
        subject: z.string(),
        html: z.string(),
        text: z.string().optional(),
        headers: z.record(z.string()).optional(),
      })
      .strict(),
  )
  .min(1)
  .max(100);
