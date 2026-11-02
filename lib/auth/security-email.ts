import { sendSecurityNoticeEmail, type SecurityEvent } from "@/lib/email";
import { notifyAccountSecurityNotice } from "@/lib/novu/service";
import { flushNotificationsAfter } from "@/lib/novu/stage-then-attempt";
import { goHref } from "@/lib/dashboard/go";
import { getAppUrl } from "@/lib/url";
import { reportSentryError } from "@/lib/observability/report";

export type { SecurityEvent };

function securityBellKind(
  event: SecurityEvent,
):
  | "TWO_FACTOR_ENABLED"
  | "TWO_FACTOR_DISABLED"
  | "PASSKEY_ADDED"
  | "PASSKEY_REMOVED"
  | "SECURITY_UPDATE" {
  switch (event.kind) {
    case "passkey-added":
      return "PASSKEY_ADDED";
    case "passkey-removed":
      return "PASSKEY_REMOVED";
    case "authenticator-added":
      return "TWO_FACTOR_ENABLED";
    case "two-factor-reset-by-admin":
      return "TWO_FACTOR_DISABLED";
    case "backup-codes-regenerated":
    case "backup-code-used":
    case "two-factor-locked":
    case "payout-account-changed":
      return "SECURITY_UPDATE";
  }
}

function securityBellMessage(event: SecurityEvent): string | undefined {
  switch (event.kind) {
    case "backup-codes-regenerated":
      return "Your two-factor backup codes were regenerated.";
    case "backup-code-used":
      return "A backup code was used to sign in to your account.";
    case "two-factor-locked":
      return "Two-factor authentication was temporarily locked after repeated failed attempts.";
    default:
      return undefined;
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
    const bellKind = securityBellKind(event);
    const message = securityBellMessage(event);
    const [, bellResults] = await Promise.all([
      sendSecurityNoticeEmail({
        userId: user.id,
        event,
        occurredAt,
      }).catch((err) => {
        console.error("[auth] Failed to send security notice email:", err);
        return undefined;
      }),
      notifyAccountSecurityNotice(
        user.id,
        {
          kind: bellKind,
          ...(message ? { message } : {}),
          dashboardUrl: `${getAppUrl()}${goHref("auto", "settings/account")}`,
        },
        `security-event:${event.kind}:${user.id}:${occurredAt.getTime()}`,
        { deferAttempt: true },
      ).catch((err) => {
        console.error("[auth] Failed to stage security notice bell:", err);
        return [];
      }),
    ]);
    if (bellResults.length > 0) {
      await flushNotificationsAfter(
        { bells: bellResults.flatMap((r) => (r.staged ? [r.staged] : [])) },
        `auth:security-event:${event.kind}`,
      ).catch(() => undefined);
    }
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
