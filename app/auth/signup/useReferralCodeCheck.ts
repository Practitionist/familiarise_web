"use client";

import { useEffect, useState } from "react";

export type ReferralCodeCheck =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "valid"; referrerName: string | null }
  | { state: "invalid" };

/**
 * Checks a typed referral code against the read-only lookup route, debounced,
 * so a typo is reported at the field instead of being dropped silently at
 * onboarding. A limiter answer or an outage falls back to "idle": the code
 * must never block sign-up.
 */
export function useReferralCodeCheck(
  code: string,
  enabled: boolean,
): ReferralCodeCheck {
  const [check, setCheck] = useState<ReferralCodeCheck>({ state: "idle" });
  useEffect(() => {
    const trimmed = code.trim();
    if (!trimmed || !enabled) {
      setCheck({ state: "idle" });
      return;
    }
    let cancelled = false;
    setCheck({ state: "checking" });
    const timer = setTimeout(() => {
      void lookup(trimmed).then((result) => {
        if (!cancelled) setCheck(result);
      });
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [code, enabled]);
  return check;
}

async function lookup(code: string): Promise<ReferralCodeCheck> {
  try {
    const res = await fetch(
      `/api/referrals/code/check/${encodeURIComponent(code)}`,
    );
    if (!res.ok) return { state: "idle" };
    const body = (await res.json()) as {
      data?: { valid: boolean; referrerName: string | null };
    };
    return body.data?.valid
      ? { state: "valid", referrerName: body.data.referrerName }
      : { state: "invalid" };
  } catch {
    return { state: "idle" };
  }
}

export function referralCheckText(check: ReferralCodeCheck): string {
  switch (check.state) {
    case "checking":
      return "Checking the code…";
    case "valid":
      return check.referrerName
        ? `Referred by ${check.referrerName} — you'll get a welcome bonus after your first booking.`
        : "Valid code — you'll get a welcome bonus after your first booking.";
    case "invalid":
      return "We don't recognise this code. You can still sign up without it.";
    default:
      return "";
  }
}
