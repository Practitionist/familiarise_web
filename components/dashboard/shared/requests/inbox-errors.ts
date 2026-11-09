import { z } from "zod";

const failureBody = z.object({
  error: z.string().optional(),
  code: z.string().optional(),
});

/** A refused or failed inbox read; the status and code decide whether a retry can help. */
export class RequestsLoadError extends Error {
  constructor(
    readonly status: number | null,
    readonly code: string | null = null,
    message?: string,
  ) {
    super(
      message ?? `Requests inbox read failed${status ? ` (${status})` : ""}`,
    );
    this.name = "RequestsLoadError";
  }
}

/**
 * Reads the failure body once; the response was not ok. `describe` words the
 * message the caller shows from the server's code and sentence.
 */
export async function inboxFailure(
  response: Response,
  describe?: (
    code: string | undefined,
    serverMessage: string | undefined,
  ) => string,
): Promise<RequestsLoadError> {
  const parsed = failureBody.safeParse(await response.json().catch(() => null));
  const body = parsed.success ? parsed.data : {};
  return new RequestsLoadError(
    response.status,
    body.code ?? null,
    describe?.(body.code, body.error),
  );
}

/** A 403 is a permission problem, not a transient fault: retrying cannot fix it. */
export const isForbidden = (error: unknown): boolean =>
  error instanceof RequestsLoadError && error.status === 403;

/** Another tab signed in as someone else; the page is already reloading. */
export const isIdentityChanged = (error: unknown): boolean =>
  error instanceof RequestsLoadError &&
  error.status === 409 &&
  error.code === "IDENTITY_CHANGED";

/** Only a transient fault is worth a second attempt or a Retry button. */
export const isRetryable = (error: unknown): boolean =>
  !isForbidden(error) && !isIdentityChanged(error);
