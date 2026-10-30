/** A deploy other than production refused to start a background job; a stand-down, not a failure. */
export class BackgroundDispatchRefusedError extends Error {
  readonly httpStatus = 409 as const;
  readonly code = "BACKGROUND_DISPATCH_PRODUCTION_ONLY" as const;
  constructor(readonly jobName: string) {
    super(
      `${jobName} runs only on the production deploy; this deploy does not start background jobs`,
    );
    this.name = "BackgroundDispatchRefusedError";
  }
}
