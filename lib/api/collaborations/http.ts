import { NextResponse } from "next/server";
import type { ZodType, ZodTypeDef } from "zod";
import { CollaborationError } from "@/lib/collaborators/service";
import type { CollaborationAccess } from "@/lib/collaborators/viewer";
import { reportSentryError } from "@/lib/observability/report";
import { BookingLockUnavailableError } from "@/utils/appointmentlock";

/** A refusal as `{ error, code, ...detail }`; anything unexpected is reported once and answered 500. */
export function collaborationErrorResponse(
  error: unknown,
  op: string,
): NextResponse {
  if (error instanceof CollaborationError) {
    return NextResponse.json(
      { error: error.message, code: error.code, ...error.detail },
      { status: error.httpStatus },
    );
  }
  if (error instanceof BookingLockUnavailableError) {
    return NextResponse.json(
      { error: error.message, code: error.code },
      { status: error.httpStatus },
    );
  }
  reportSentryError(error, { subsystem: "collaborators", op });
  return NextResponse.json(
    { error: "Something went wrong. Please try again.", code: "INTERNAL" },
    { status: 500 },
  );
}

export const unauthorized = () =>
  NextResponse.json(
    { error: "Sign in to continue.", code: "UNAUTHORIZED" },
    { status: 401 },
  );

/** Route params that do not parse name nothing that exists. */
export function parseParams<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  raw: unknown,
): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new CollaborationError("NOT_FOUND", "Not found.");
  return parsed.data;
}

export async function parseBody<T>(
  req: Request,
  schema: ZodType<T, ZodTypeDef, unknown>,
): Promise<T> {
  const raw: unknown = await req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new CollaborationError(
      "INVALID_TERMS",
      parsed.error.errors.map((e) => e.message).join(". "),
    );
  }
  return parsed.data;
}

/** Only a plan's manager changes its team, and only while its organisation is active. */
export function requireManager(access: CollaborationAccess): void {
  if (!access.plan)
    throw new CollaborationError("NOT_FOUND", "Plan not found.");
  if (access.viewer.kind !== "manager") {
    throw new CollaborationError(
      "FORBIDDEN",
      "Only the plan's host or its organisation's catalogue managers can change its team.",
    );
  }
  if (!access.viewer.canWrite) {
    throw new CollaborationError(
      "FORBIDDEN",
      "This organisation is not active, so its plans' teams cannot change.",
    );
  }
}
