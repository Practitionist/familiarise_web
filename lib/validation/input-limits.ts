/**
 * Shared input bounds, safe to import from browser schemas and server handlers.
 * Every user-typed string carries a `.max()`: unbounded text is a large-payload
 * DoS surface (Postgres TOAST bloat and log amplification).
 */
export const MAX_TITLE_LENGTH = 200;
export const MAX_TEXT_LENGTH = 2_000;
export const MAX_SHORT_FIELD_LENGTH = 50;

/** Default request-body ceiling for JSON mutation routes. */
export const MAX_BODY_BYTES = 64 * 1024;
