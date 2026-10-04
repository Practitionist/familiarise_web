/**
 * `/api/cleanup/[job]` slugs with no scheduler on purpose; the value is the reason.
 * A leaf module so the scheduler-drift test can import it without loading job code.
 */
export const MANUAL_ONLY: Readonly<Record<string, string>> = {};
