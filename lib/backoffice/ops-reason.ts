import { z } from "zod";

/** A reason an auditor can read later; five characters rules out "ok"/"fix". */
export const opsReasonSchema = z
  .string()
  .trim()
  .min(5, "Give a reason of at least 5 characters.")
  .max(1000);
