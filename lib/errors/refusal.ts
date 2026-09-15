/**
 * A typed refusal: the code anticipated this outcome and is answering, not
 * failing. One object carries both audiences — `userMessage` is what a toast
 * shows, `devMessage` (the Error's `message`) is what Sentry and logs get and
 * may name ids. Routes hand one to `apiError`, actions return one through
 * `refusalResult`, and the client reads it back with `userMessageFrom`.
 *
 * Dependency-free on purpose: it is thrown on the server and rehydrated in
 * the browser, so it must import nothing that is server-only.
 */

export interface RefusalInit {
  /** Machine-readable, stable across rewording — what a client branches on. */
  code: string;
  /** 401 unauthenticated, 403 forbidden, 404 not found, 409 state, 422 input. */
  httpStatus?: number;
  userMessage: string;
  /** Defaults to `userMessage`; add ids here, never in the user copy. */
  devMessage?: string;
  context?: Record<string, unknown>;
}

/** The wire format a refusal travels in: the code and the user's sentence. */
export type RefusalShape = { code: string; message: string };

export class Refusal extends Error {
  readonly code: string;
  readonly httpStatus: number;
  readonly userMessage: string;
  readonly devMessage: string;
  readonly context?: Record<string, unknown>;

  constructor({
    code,
    httpStatus = 409,
    userMessage,
    devMessage = userMessage,
    context,
  }: RefusalInit) {
    super(devMessage);
    this.name = "Refusal";
    this.code = code;
    this.httpStatus = httpStatus;
    this.userMessage = userMessage;
    this.devMessage = devMessage;
    this.context = context;
  }

  toShape(): RefusalShape {
    return { code: this.code, message: this.userMessage };
  }
}

export function isRefusal(error: unknown): error is Refusal {
  return error instanceof Refusal;
}

export function isRefusalShape(value: unknown): value is RefusalShape {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as RefusalShape).code === "string" &&
    typeof (value as RefusalShape).message === "string"
  );
}
