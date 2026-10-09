import { sendSecurityNoticeEmail, type SecurityEvent } from "@/lib/email";
import { reportSentryError } from "@/lib/observability/report";

export type { SecurityEvent };

/**
 * Sends the account-security notice for `event`. The sender re-reads address,
 * name and zone from the user row; this never throws.
 */
export async function sendSecurityEventEmail(
  user: { id: string; email: string; name?: string | null },
  event: SecurityEvent,
): Promise<void> {
  try {
    await sendSecurityNoticeEmail({
      userId: user.id,
      event,
      occurredAt: new Date(),
    });
  } catch (error) {
    reportSentryError(error, {
      subsystem: "auth",
      op: "security-event-email",
      level: "warning",
      tags: { securityEvent: event.kind },
      extra: { userId: user.id },
    });
  }
}
