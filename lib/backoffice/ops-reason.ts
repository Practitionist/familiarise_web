import { z } from "zod";

const REASON_MESSAGE = "Give a reason of at least 5 characters.";

/** A reason an auditor can read later; five characters rules out "ok"/"fix". */
export const opsReasonSchema = z
  .string({
    required_error: REASON_MESSAGE,
    invalid_type_error: REASON_MESSAGE,
  })
  .trim()
  .min(5, REASON_MESSAGE)
  .max(1000);
