/** Pure client-safe support callback parser and diagnostic escalation builder. */

import { callbackPhoneSchema } from "@/lib/validation/phone";

const CALLBACK_PREFIX = "[callback requested:";

/** Parse an explicit callback phone tag from the first line of ticket description or fall back to user.phone. */
export function extractCallbackInfo(
  description: string | null | undefined,
  fallbackPhone?: string | null,
): { phone: string | null; callbackRequested: boolean } {
  if (description) {
    const newlineIdx = description.indexOf("\n");
    const firstLine =
      newlineIdx === -1 ? description : description.slice(0, newlineIdx);
    const lower = firstLine.toLowerCase();
    const prefixIdx = lower.indexOf(CALLBACK_PREFIX);
    if (prefixIdx !== -1) {
      const valueStart = prefixIdx + CALLBACK_PREFIX.length;
      const closeIdx = firstLine.indexOf("]", valueStart);
      if (closeIdx !== -1) {
        const extracted = firstLine.slice(valueStart, closeIdx).trim();
        const parsed = callbackPhoneSchema.safeParse(extracted);
        if (parsed.success) {
          return { phone: parsed.data, callbackRequested: true };
        }
      }
    }
  }
  const cleanFallback = fallbackPhone?.trim() || null;
  return { phone: cleanFallback, callbackRequested: false };
}

export interface EngineeringEscalationParams {
  key: string;
  reference?: string | null;
}

/** Build a non-PII GitHub issue URL for engineering escalation from backoffice support. */
export function buildEngineeringEscalationHref(
  params: EngineeringEscalationParams,
): string {
  const title = `[Support Escalation] ${params.reference ?? params.key}`;
  const lines = [
    "## Support Case Context",
    `- **Case Key**: \`${params.key}\``,
    params.reference ? `- **Reference**: \`${params.reference}\`` : null,
    "",
    "## Investigation Notes",
    "_Add steps to reproduce or observed behaviour (do not include user PII)._",
  ].filter((line): line is string => line !== null);

  const url = new URL(
    "https://github.com/Practitionist/familiarise_web/issues/new",
  );
  url.searchParams.set("labels", "bug,from-support");
  url.searchParams.set("title", title);
  url.searchParams.set("body", lines.join("\n"));
  return url.toString();
}
