/** A plain identifier (cuid, uuid, gateway id or a `prefix:id` key); never a name or an email. */
export const ENTITY_ID_PATTERN = /^[\w:.-]{1,128}$/;

const ENTITY_KEY = /^(?:id|[a-z][A-Za-z0-9]*Id)$/;

/** The first `id` or `*Id` string in a context object, if it is a plain identifier. */
export function entityIdOf(
  context: Record<string, unknown> | null | undefined,
): string | undefined {
  if (!context) return undefined;
  for (const [key, value] of Object.entries(context)) {
    if (
      ENTITY_KEY.test(key) &&
      typeof value === "string" &&
      ENTITY_ID_PATTERN.test(value)
    ) {
      return value;
    }
  }
  return undefined;
}
