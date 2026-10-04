import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { getSession } from "@/lib/auth-server";
import { reportSentryError } from "@/lib/observability/report";
import { referralApplyLimiter } from "@/lib/rate-limit";
import {
  ATTRIBUTION_COOKIE_MAX_AGE_S,
  REFERRAL_CODE_COOKIE,
} from "@/lib/referrals/attribution-token-shape";
import {
  applyReferralCode,
  validateReferralCode,
} from "@/lib/referrals/service";

const codeSchema = z
  .string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_-]+$/);

/**
 * A consumer referral link: remembers the code in a first-party cookie (30 days) that the
 * onboarding stash reads, then applies it now for a signed-in user or sends a visitor to signup.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ code: string }> },
) {
  const parsed = codeSchema.safeParse((await params).code);
  const referralCode = parsed.success
    ? await validateReferralCode(parsed.data)
    : null;
  if (!parsed.success || !referralCode) {
    return NextResponse.redirect(new URL("/auth/signup", req.url));
  }
  const code = parsed.data;

  const session = await getSession();
  let target = `/auth/signup?ref=${encodeURIComponent(code)}`;
  if (session?.user?.id) {
    let applied = false;
    const limited = await referralApplyLimiter
      .limit(session.user.id)
      .then((r) => !r.success)
      .catch(() => false);
    if (!limited) {
      try {
        applied = (await applyReferralCode(session.user.id, code)) !== null;
      } catch (error) {
        reportSentryError(error, {
          subsystem: "referrals",
          op: "applyReferralCode",
          extra: { code },
        });
      }
    }
    target = applied ? "/dashboard?ref_applied=true" : "/dashboard";
  }

  const res = NextResponse.redirect(new URL(target, req.url));
  res.cookies.set(REFERRAL_CODE_COOKIE, code, {
    maxAge: ATTRIBUTION_COOKIE_MAX_AGE_S,
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
  return res;
}
