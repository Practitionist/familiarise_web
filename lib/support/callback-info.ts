/** Pure client-safe support callback parser and diagnostic escalation builder. */

const CALLBACK_PREFIX = "[callback requested:";

/** Parse an explicit callback phone tag from ticket/message bodies or fall back to user.phone. */
export function extractCallbackInfo(
  texts: readonly (string | null | undefined)[],
  fallbackPhone?: string | null,
): { phone: string | null; callbackRequested: boolean } {
  for (const text of texts) {
    if (!text) continue;
    const lower = text.toLowerCase();
    const prefixIdx = lower.indexOf(CALLBACK_PREFIX);
    if (prefixIdx !== -1) {
      const valueStart = prefixIdx + CALLBACK_PREFIX.length;
      const closeIdx = text.indexOf("]", valueStart);
      if (closeIdx !== -1) {
        const extracted = text.slice(valueStart, closeIdx).trim();
        if (extracted) {
          return { phone: extracted, callbackRequested: true };
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
  kind: string;
  topic: string;
  priority?: string | null;
  status: string;
  appointmentId?: string | null;
  paymentId?: string | null;
  backofficePath: string;
}

/** Build a non-PII GitHub issue URL for engineering escalation from backoffice support. */
export function buildEngineeringEscalationHref(
  params: EngineeringEscalationParams,
): string {
  const title = `[Support Escalation] ${params.reference ?? params.key} (${params.topic})`;
  const lines = [
    "## Support Case Context",
    `- **Case Key**: \`${params.key}\``,
    params.reference ? `- **Reference**: \`${params.reference}\`` : null,
    `- **Kind**: \`${params.kind}\``,
    `- **Topic**: \`${params.topic}\``,
    params.priority ? `- **Priority**: \`${params.priority}\`` : null,
    `- **Status**: \`${params.status}\``,
    params.appointmentId
      ? `- **Appointment ID**: \`${params.appointmentId}\``
      : null,
    params.paymentId ? `- **Payment ID**: \`${params.paymentId}\`` : null,
    `- **Backoffice Path**: \`${params.backofficePath}\``,
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
