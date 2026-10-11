import { sendSecurityNoticeEmail, type SecurityEvent } from "@/lib/email";
import { notifyAccountSecurityNotice } from "@/lib/novu/service";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { getAppUrl } from "@/lib/url";
import { reportSentryError } from "@/lib/observability/report";

export type { SecurityEvent };

function securityBellKind(
  event: SecurityEvent,
): "TWO_FACTOR_ENABLED" | "TWO_FACTOR_DISABLED" {
  switch (event.kind) {
    case "authenticator-added":
    case "passkey-added":
    case "backup-codes-regenerated":
    case "backup-code-used":
      return "TWO_FACTOR_ENABLED";
    case "passkey-removed":
    case "two-factor-reset-by-admin":
    case "two-factor-locked":
      return "TWO_FACTOR_DISABLED";
  }
}

/**
 * Sends the account-security notice for `event` across both Novu bell and email.
 * The sender re-reads address, name and zone from the user row; this never throws.
 */
export async function sendSecurityEventEmail(
  user: { id: string; email: string; name?: string | null },
  event: SecurityEvent,
): Promise<void> {
  try {
    const occurredAt = new Date();
    const [, bellResults] = await Promise.all([
      sendSecurityNoticeEmail({
        userId: user.id,
        event,
        occurredAt,
      }),
      notifyAccountSecurityNotice(
        user.id,
        {
          kind: securityBellKind(event),
          dashboardUrl: `${getAppUrl()}/dashboard/settings/security`,
        },
        `security-event:${event.kind}:${user.id}:${occurredAt.getTime()}`,
        { deferAttempt: true },
      ).catch(() => []),
    ]);
    flushNotificationsAfter(
      { bells: bellResults.flatMap((r) => (r.staged ? [r.staged] : [])) },
      `auth:security-event:${event.kind}`,
    );
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
