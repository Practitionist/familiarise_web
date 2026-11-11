/** A plan's price or length terms changed between an edit's read and its write. */
export class StalePlanEditError extends Error {
  readonly code = "PLAN_CHANGED" as const;
  readonly httpStatus = 409;

  constructor() {
    super("This plan was changed by someone else; reload and try again.");
    this.name = "StalePlanEditError";
  }
}
