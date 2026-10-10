import { createHash } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";
import { z } from "zod";
import prisma from "@/lib/prisma";
import { scheduleAfter } from "@/lib/api/after-safe";
import { AUTH_PROVIDERS } from "@/lib/auth-providers";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import { buildSignupConsentArtifacts } from "@/lib/compliance/dpdp";
import {
  sendAccountLinkedEmail,
  sendExistingAccountEmail,
  sendPasswordChangedEmail,
  sendVerificationEmail,
  sendWelcomeEmail,
} from "@/lib/email";
import { syncSubscriber } from "@/lib/novu/subscriber";
import { reportSentryError } from "@/lib/observability/report";
import { captureThrottled } from "@/lib/observability/throttled-capture";
import { existingAccountNoticeLimiter } from "@/lib/rate-limit";

/** How long an email verification code stays valid. */
export const VERIFICATION_CODE_TTL_SECONDS = 10 * 60;

interface LifecycleUser {
  id: string;
  email: string;
  name: string;
}

const UserFlagsSchema = z.object({
  emailVerified: z.boolean().nullish(),
  role: z.string().nullish(),
  twoFactorEnabled: z.boolean().nullish(),
});

/** The additional user columns BetterAuth hands hooks untyped. */
export function userFlags(user: unknown): z.infer<typeof UserFlagsSchema> {
  const parsed = UserFlagsSchema.safeParse(user);
  return parsed.success ? parsed.data : {};
}

function reportAuthFailure(error: unknown, op: string): void {
  reportSentryError(error, { subsystem: "auth", op, level: "warning" });
}

/** Novu holds the address, so only proven (verified) users get a subscriber. */
function syncVerifiedSubscriber(user: LifecycleUser): void {
  const nameParts = (user.name || "User").split(" ");
  syncSubscriber({
    userId: user.id,
    email: user.email,
    firstName: nameParts[0],
    lastName: nameParts.slice(1).join(" ") || undefined,
    routingMode: "BELL_AND_EMAIL",
  }).catch((error) => reportAuthFailure(error, "novu-subscriber-sync"));
}

/**
 * The first moment a person has proven their address: create their Novu
 * subscriber, stamp the sign-up DPDP consent (unless they never saw the
 * sign-up form) and send the welcome mail.
 */
export async function welcomeVerifiedUser(
  user: LifecycleUser,
  opts: { stampConsent: boolean },
): Promise<void> {
  syncVerifiedSubscriber(user);
  if (opts.stampConsent) {
    // Fails open: ConsentSection lets the user grant it, and every consent
    // gate fails closed until they do.
    try {
      for (const draft of buildSignupConsentArtifacts(user.id)) {
        await prisma.consentArtifact.create({ data: draft });
      }
    } catch (error) {
      reportAuthFailure(error, "signup-consent");
    }
  }
  scheduleAfter(
    () =>
      sendWelcomeEmail({
        email: user.email,
        name: user.name || "there",
        userId: user.id,
      }),
    "auth:welcome-email",
  );
}

/**
 * `databaseHooks.user.create.after`. Credential sign-ups arrive unverified and
 * are welcomed by {@link welcomeVerifiedUser} once the code is entered; social
 * and SSO users arrive verified. SSO and admin-created operators give consent
 * themselves on first sign-in, and operators get a setup mail, not a welcome.
 */
export async function provisionNewUser(
  user: LifecycleUser & { emailVerified: boolean },
  path: string | undefined,
): Promise<void> {
  try {
    await prisma.cookiePreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
    });
    await prisma.notificationPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id },
      update: {},
    });

    if (!user.emailVerified) return;
    if (path === "/admin/create-user") {
      syncVerifiedSubscriber(user);
    } else if (path?.startsWith("/sso/")) {
      // A refused SSO login deletes the user it just created (account hooks),
      // so greet only a user still present once the callback has answered.
      scheduleAfter(async () => {
        const kept = await prisma.user.findUnique({
          where: { id: user.id },
          select: { id: true },
        });
        if (kept) await welcomeVerifiedUser(user, { stampConsent: false });
      }, "auth:sso-welcome");
    } else {
      await welcomeVerifiedUser(user, { stampConsent: true });
    }
  } catch (error) {
    reportAuthFailure(error, "user-create-after");
  }
}

/** `emailOTP.sendVerificationOTP`: only unverified accounts get a code. */
export async function sendVerificationCode(
  email: string,
  otp: string,
): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { email },
    select: { emailVerified: true },
  });
  if (!user || user.emailVerified) return;
  await sendVerificationEmail({
    email,
    otp,
    expiresInMinutes: VERIFICATION_CODE_TTL_SECONDS / 60,
  });
}

/**
 * `emailAndPassword.onExistingUserSignUp`: the sign-up response is the same
 * as for a new address, and the owner learns someone tried. Throttled per
 * recipient so the form cannot be used to flood one inbox.
 */
export async function notifyExistingAccountSignUp(
  user: LifecycleUser,
): Promise<void> {
  const recipientKey = createHash("sha256")
    .update(user.email.toLowerCase())
    .digest("hex");
  try {
    const { success } = await existingAccountNoticeLimiter.limit(recipientKey);
    if (!success) return;
  } catch (error) {
    captureThrottled("auth:existing-account-notice-limiter", error, {
      subsystem: "auth",
      op: "existing-account-notice-limit",
      level: "warning",
    });
  }
  await sendExistingAccountEmail({ email: user.email, userId: user.id });
}

/**
 * Stored identifiers of the user's emailOTP codes, matching BetterAuth's
 * `${type}-otp-${email}` key under `verification.storeIdentifier: "hashed"`.
 */
export function emailOtpVerificationIdentifiers(email: string): string[] {
  const normalized = email.toLowerCase();
  return ["email-verification", "forget-password"].map((type) =>
    createHash("sha256")
      .update(`${type}-otp-${normalized}`)
      .digest("base64url"),
  );
}

/**
 * After a reset or change: every outstanding single-use token bound to the
 * user (other reset links, pending 2FA challenges, emailed codes) dies, and
 * the owner is told.
 * A completed reset also proves the inbox, so it verifies the address.
 */
export async function onPasswordChanged(
  user: LifecycleUser,
  opts: { viaReset: boolean; notify: boolean; welcomeIfVerified: boolean },
): Promise<void> {
  await prisma.verification.deleteMany({
    where: {
      OR: [
        { value: user.id },
        { identifier: { in: emailOtpVerificationIdentifiers(user.email) } },
      ],
    },
  });
  if (opts.viaReset) {
    const verified = await prisma.user.updateMany({
      where: { id: user.id, emailVerified: false },
      data: { emailVerified: true },
    });
    // No consent notice is shown on reset; the onboarding gate collects it.
    if (verified.count === 1 && opts.welcomeIfVerified) {
      await welcomeVerifiedUser(user, { stampConsent: false });
    }
  }
  if (opts.notify) {
    scheduleAfter(
      () =>
        sendPasswordChangedEmail({
          email: user.email,
          name: user.name || "there",
          userId: user.id,
        }),
      "auth:password-changed-email",
    );
  }
}

/** `emailAndPassword.onPasswordReset`. */
export async function onPasswordReset(user: LifecycleUser): Promise<void> {
  const { role, twoFactorEnabled } = userFlags(user);
  const operator = isOperatorRole(role);
  await onPasswordChanged(user, {
    viaReset: true,
    // An unenrolled operator's first reset is their invitation, not a change.
    notify: !(operator && twoFactorEnabled !== true),
    welcomeIfVerified: !operator,
  });
}

function providerLabel(providerId: string): string {
  return (
    AUTH_PROVIDERS.find((provider) => provider.id === providerId)?.label ??
    "your organisation's single sign-on"
  );
}

/**
 * `databaseHooks.account.create.after`. A brand-new user's first account is
 * covered by the welcome mail; only a sign-in method added to an existing
 * account is a security event worth a mail.
 */
export async function notifyAccountLinked(account: {
  id: string;
  userId: string;
  providerId: string;
}): Promise<void> {
  if (account.providerId === "credential") return;
  try {
    const otherAccounts = await prisma.account.count({
      where: { userId: account.userId, id: { not: account.id } },
    });
    if (otherAccounts === 0) return;
    const user = await prisma.user.findUnique({
      where: { id: account.userId },
      select: { email: true, name: true },
    });
    if (!user) return;
    scheduleAfter(
      () =>
        sendAccountLinkedEmail({
          email: user.email,
          name: user.name || "there",
          provider: providerLabel(account.providerId),
          userId: account.userId,
        }),
      "auth:account-linked-email",
    );
  } catch (error) {
    reportAuthFailure(error, "account-create-after");
  }
}

const ChangedPasswordResponseSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), name: z.string() }),
});

/** Runs {@link onPasswordChanged} after a successful `/change-password`. */
export const accountLifecycle = {
  id: "account-lifecycle",
  hooks: {
    after: [
      {
        matcher: (ctx) => ctx.path === "/change-password",
        handler: createAuthMiddleware(async (ctx) => {
          const changed = ChangedPasswordResponseSchema.safeParse(
            ctx.context.returned,
          );
          if (!changed.success) return;
          await onPasswordChanged(changed.data.user, {
            viaReset: false,
            notify: true,
            welcomeIfVerified: false,
          });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
