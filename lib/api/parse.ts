import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

/**
 * Parse a request payload (JSON body or query object) against a Zod schema.
 * Returns `{ data }` on success or `{ error }` — a ready-to-return 400 —
 * so routes share one validation shape instead of repeating safeParse
 * boilerplate (Sonar duplication gate). Message defaults to "Invalid
 * request body"; pass a specific one for query params.
 */
export function parseRequestBody<S extends z.ZodTypeAny>(
  schema: S,
  body: unknown,
  message = "Invalid request body",
  errorExtra?: Record<string, unknown>,
): { data: z.infer<S>; error?: never } | { data?: never; error: NextResponse } {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return {
      error: NextResponse.json(
        { error: message, issues: parsed.error.issues, ...errorExtra },
        { status: 400 },
      ),
    };
  }
  return { data: parsed.data };
}

/**
 * Parse a JSON request body: malformed JSON 400s here instead of falling
 * through to the route's 500 catch, then the schema validates shape.
 * Prefer this over `parseRequestBody(schema, await req.json())` — a client
 * sending truncated JSON is a 400, not a server error.
 */
export async function parseJsonRequest<S extends z.ZodTypeAny>(
  schema: S,
  req: Pick<NextRequest, "json">,
  message = "Invalid request body",
  errorExtra?: Record<string, unknown>,
): Promise<
  { data: z.infer<S>; error?: never } | { data?: never; error: NextResponse }
> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return {
      error: NextResponse.json(
        { error: "Malformed JSON body" },
        { status: 400 },
      ),
    };
  }
  return parseRequestBody(schema, body, message, errorExtra);
}
