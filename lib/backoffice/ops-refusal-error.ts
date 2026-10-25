/**
 * #1771 K-1 — a refusal an ops door answers with its own code and copy: a
 * state the operator can act on, never a fault. A leaf module, so money
 * primitives can throw it without importing next/server.
 */
export class OpsRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly httpStatus = 409,
    /** Extra fields merged into the refusal body, e.g. the row that blocked the door. */
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "OpsRefusal";
  }
}
