import "server-only";

import * as Sentry from "@sentry/nextjs";
import { NextResponse } from "next/server";
import type { z } from "zod";

import {
  FILE_ERROR_MESSAGE,
  FILE_ERROR_STATUS,
  type ClientFileErrorCode,
  type FileApiError,
  type FileErrorCode,
} from "./file-errors";

type ServerFileErrorCode = Exclude<FileErrorCode, ClientFileErrorCode>;

/** The one failure response for file routes: `{ code, message }`, never vendor text. */
export function fileApiError(
  code: ServerFileErrorCode,
  extra: {
    closedAt?: Date | null;
    headers?: HeadersInit;
    /** Extra fields a client may read beside the code. */
    fields?: Record<string, unknown>;
  } = {},
): NextResponse<FileApiError> {
  return NextResponse.json(
    {
      ...extra.fields,
      code,
      message: FILE_ERROR_MESSAGE[code],
      ...(extra.closedAt ? { closedAt: extra.closedAt.toISOString() } : {}),
    },
    {
      status: FILE_ERROR_STATUS[code],
      headers: { "Cache-Control": "private, no-store", ...extra.headers },
    },
  );
}

/** A coded refusal thrown inside a transaction and answered by the route. */
export class FileRouteError extends Error {
  readonly code: ServerFileErrorCode;
  readonly closedAt: Date | null;

  constructor(code: ServerFileErrorCode, closedAt: Date | null = null) {
    super(code);
    this.name = "FileRouteError";
    this.code = code;
    this.closedAt = closedAt;
  }
}

/** Runs a file route; coded refusals become their response, anything else one Sentry event and a 500. */
export async function answerFileRoute(
  run: () => Promise<Response>,
  subsystem = "documents",
): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof FileRouteError) {
      return fileApiError(error.code, { closedAt: error.closedAt });
    }
    // Previews sample Sentry at 10%, so the function log always gets one line.
    console.error(
      `[file-route:${subsystem}] unhandled`,
      error instanceof Error ? error.message.split("\n")[0] : "non-error throw",
    );
    Sentry.captureException(error, { tags: { subsystem } });
    return fileApiError("SERVER_ERROR");
  }
}

/** Parses a JSON body with `schema`, refusing anything else as INVALID_INPUT. */
export async function parseJsonBody<T extends z.ZodTypeAny>(
  request: Request,
  schema: T,
): Promise<z.infer<T>> {
  const raw: unknown = await request.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new FileRouteError("INVALID_INPUT");
  return parsed.data;
}
