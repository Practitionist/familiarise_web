import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { auth } from "@/lib/auth";
import { requireApiAuth } from "@/lib/auth-helpers";
import { isOperatorRole } from "@/lib/auth/operator-session-policy";
import prisma from "@/lib/prisma";
import { applyRateLimit, reauthLimiter } from "@/lib/rate-limit";
import { sendSecurityEventEmail } from "@/lib/auth/security-email";
import {
  isTwoFactorLocked,
  recordTwoFactorFailure,
  resetTwoFactorFailures,
} from "@/lib/auth/two-factor-lockout";

const bodySchema = z.object({
  password: z.string().min(1).max(128),
  totpCode: z
    .string()
    .trim()
    .regex(/^\d{6}$/)
    .optional(),
});

function refuse(status: number, code: string, error: string) {
  return NextResponse.json({ error, code }, { status });
}

/**
 * POST /api/user/reauthenticate — re-proves the signed-in user and stamps
 * `reauthenticatedAt` on the current session (lib/auth/step-up.ts). Operators
 * give the password and an authenticator code; a passkey step-up is a fresh
 * passkey sign-in instead, which mints a session that is fresh by creation.
 */
export async function POST(req: NextRequest) {
  const authResult = await requireApiAuth({ expectUser: true });
  if (authResult.error) return authResult.error;
  const { session, user } = authResult.session;

  const limited = await applyRateLimit(reauthLimiter, user.id);
  if (limited) return limited;

  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return refuse(400, "INVALID_BODY", "Enter your password.");
  }
  const { password, totpCode } = parsed.data;

  const credential = await prisma.account.findFirst({
    where: { userId: user.id, providerId: "credential" },
    select: { id: true },
  });
  if (!credential) {
    return refuse(409, "NO_PASSWORD", "Sign in again to continue.");
  }

  const operator = isOperatorRole(user.role);
  if (operator && !totpCode) {
    return refuse(
      400,
      "TOTP_REQUIRED",
      "Enter the code from your authenticator app.",
    );
  }

  const requestHeaders = await headers();
  try {
    await auth.api.verifyPassword({
      body: { password },
      headers: requestHeaders,
    });
  } catch (err) {
    if (err instanceof APIError) {
      return refuse(400, "INVALID_PASSWORD", "That password is not correct.");
    }
    throw err;
  }

  if (operator && totpCode) {
    // The plugin does not count codes checked with a live session; this does.
    if (await isTwoFactorLocked(prisma, user.id)) {
      return refuse(
        429,
        "ACCOUNT_TEMPORARILY_LOCKED",
        "Too many incorrect codes. Try again in 15 minutes.",
      );
    }
    try {
      await auth.api.verifyTOTP({
        body: { code: totpCode },
        headers: requestHeaders,
      });
    } catch (err) {
      if (err instanceof APIError) {
        await recordTwoFactorFailure(prisma, user.id);
        if (await isTwoFactorLocked(prisma, user.id)) {
          const lock = await prisma.twoFactor.findUnique({
            where: { userId: user.id },
            select: { lockedUntil: true },
          });
          if (lock?.lockedUntil) {
            await sendSecurityEventEmail(user, {
              kind: "two-factor-locked",
              lockedUntil: lock.lockedUntil,
            });
          }
        }
        return refuse(400, "INVALID_CODE", "That code is not correct.");
      }
      throw err;
    }
    await resetTwoFactorFailures(prisma, user.id);
  }

  const stamped = await prisma.session.updateMany({
    where: { id: session.id, userId: user.id },
    data: { reauthenticatedAt: new Date() },
  });
  if (stamped.count !== 1) {
    return refuse(401, "SESSION_EXPIRED", "Your session ended. Sign in again.");
  }
  return NextResponse.json({ ok: true });
}
