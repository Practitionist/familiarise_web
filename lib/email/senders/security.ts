/**
 * Account security notices: second-factor and passkey changes, backup-code
 * use and two-factor lockouts. Required notices, sent from security@.
 */

import * as React from "react";
import SecurityEventEmail, {
  securityEventSubject,
  type SecurityEvent,
} from "@/emails/auth/SecurityEventEmail";
import { EMAIL_BUDGET_MS, SENDERS, supportEmail } from "../config";
import { defineFixedBudgetEmailSender, greet, whenText } from "./shared";

export type { SecurityEvent };

export interface SecurityEventEmailArgs {
  userId: string;
  event: SecurityEvent;
  occurredAt: Date;
}

export const sendSecurityNoticeEmail =
  defineFixedBudgetEmailSender<SecurityEventEmailArgs>(
    EMAIL_BUDGET_MS.AUTH,
    ({ userId, event, occurredAt }) => ({
      userIds: [userId],
      spec: {
        emailType: "SECURITY_EVENT",
        category: null,
        from: SENDERS.security,
        entityRef: `user:${userId}`,
        subject: () => securityEventSubject(event),
        render: (r) =>
          React.createElement(SecurityEventEmail, {
            recipientName: greet(r),
            event,
            occurredAtText: whenText(occurredAt, r.zone),
            lockedUntilText:
              event.kind === "two-factor-locked"
                ? whenText(event.lockedUntil, r.zone)
                : undefined,
            supportEmail: supportEmail(),
          }),
      },
    }),
  );
