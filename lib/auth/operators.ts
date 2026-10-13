import { randomBytes } from "node:crypto";

import { auth } from "@/lib/auth";
import prisma from "@/lib/prisma";
import { OpsRefusal } from "@/lib/backoffice/ops-refusal-error";

/** The roles an operator account can hold. */
export const OPERATOR_ROLES = ["STAFF", "ADMIN"] as const;
export type OperatorRole = (typeof OPERATOR_ROLES)[number];

export interface CreatedOperator {
  userId: string;
  email: string;
  role: OperatorRole;
  profileId: string;
}

/**
 * Create a STAFF/ADMIN account. Shared by `POST /api/admin/team/members` and
 * `scripts/bootstrap-admin.ts`, so there is one way an operator comes into
 * existence.
 *
 * `auth.api.createUser` is called without headers, which BetterAuth treats as
 * a trusted server call (no caller session, no admin-plugin permission check);
 * the caller has already passed its own gate. The account gets a random
 * password nobody knows, so it holds a credential account and the person
 * chooses their real password through the reset link sent by
 * {@link sendOperatorSetupLink}. `emailVerified` is set because an admin
 * typed the address and the setup link proves it on first use.
 *
 * Consent is not stamped here: lib/auth.ts skips the signup consent rows for
 * this path, and the operator gives consent on first sign-in.
 */
export async function createOperator(input: {
  email: string;
  name: string;
  role: OperatorRole;
}): Promise<CreatedOperator> {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (existing) {
    throw new OpsRefusal(
      "ALREADY_EXISTS",
      "That address already has a Familiarise account.",
      409,
    );
  }

  const { user } = await auth.api
    .createUser({
      body: {
        email,
        name: input.name.trim(),
        password: randomBytes(32).toString("base64url"),
        role: input.role,
        data: { emailVerified: true, onboardingCompleted: true },
      },
    })
    .catch((error: unknown) => {
      // The same address created between the check above and this call.
      const code = (error as { body?: { code?: string } }).body?.code;
      if (code === "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL") {
        throw new OpsRefusal(
          "ALREADY_EXISTS",
          "That address already has a Familiarise account.",
          409,
        );
      }
      throw error;
    });

  // Restated on the row: `data` above is passed through unparsed today, but
  // these two must hold whatever a future BetterAuth does with input:false
  // fields.
  const settled = { emailVerified: true, onboardingCompleted: true };
  try {
    const profileId = await prisma.$transaction(async (tx) => {
      if (input.role === "ADMIN") {
        const profile = await tx.adminProfile.create({
          data: { userId: user.id },
          select: { id: true },
        });
        await tx.user.update({
          where: { id: user.id },
          data: { adminProfileId: profile.id, ...settled },
        });
        return profile.id;
      }
      const profile = await tx.staffProfile.create({
        data: { userId: user.id },
        select: { id: true },
      });
      await tx.user.update({
        where: { id: user.id },
        data: { staffProfileId: profile.id, ...settled },
      });
      return profile.id;
    });
    return { userId: user.id, email, role: input.role, profileId };
  } catch (error) {
    // An operator without a profile row is half-made; remove it so the
    // address can be retried rather than answering 409 forever.
    await prisma.user.delete({ where: { id: user.id } }).catch(() => {});
    throw error;
  }
}

/**
 * Email the operator a link to choose their password. This is BetterAuth's
 * own reset flow (30-minute single-use token); lib/auth.ts words the email as
 * an invitation while the account has no second factor yet. A link that
 * lapses is re-requested from "Forgot password".
 */
export async function sendOperatorSetupLink(email: string): Promise<void> {
  await auth.api.requestPasswordReset({
    body: { email, redirectTo: "/auth/reset-password" },
  });
}
