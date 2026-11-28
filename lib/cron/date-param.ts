import type { NextRequest } from "next/server";
import { z } from "zod";

/** Thrown for a `?date=` that is not a `YYYY-MM-DD` day the job can run for; the route answers 400. */
export class InvalidDateParamError extends Error {
  constructor() {
    super("INVALID_DATE");
    this.name = "InvalidDateParamError";
  }
}

const dateParamSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** The `?date=YYYY-MM-DD` a manual caller sends to run one day again; absent on the ticker. */
export function parseDateParam(req: NextRequest): string | undefined {
  const raw = req.nextUrl.searchParams.get("date");
  if (raw === null) return undefined;
  const parsed = dateParamSchema.safeParse(raw);
  if (!parsed.success) throw new InvalidDateParamError();
  return parsed.data;
}
