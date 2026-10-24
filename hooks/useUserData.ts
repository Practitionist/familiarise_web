"use client";

import { useState, useEffect, useCallback } from "react";
import { reportSentryError } from "@/lib/observability/report";
import { User } from "@prisma/client";
import { fetchUserDetails } from "@/lib/user";
import { withJitter } from "@/lib/stream/backoff";
import {
  profileLoadFailure,
  type ConnectFailure,
} from "@/lib/stream/connect-failure";

/** Fetch attempts before the profile load is reported as failed. */
const MAX_PROFILE_ATTEMPTS = 4;

const PROFILE_BACKOFF_BASE_MS = 1_000;
const PROFILE_BACKOFF_CAP_MS = 8_000;

function isUnauthorized(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "status" in err &&
    err.status === 401
  );
}

/**
 * The signed-in user's core record, for the Stream connect.
 *
 * Deliberately narrow: `StreamProviderImpl` will not connect until `isLoading`
 * clears, so anything added here is time the Messages tab spends on a skeleton.
 * It fetches `id`, `name`, `image` and `role` only.
 *
 * A failed fetch retries with capped, jittered backoff. When the budget runs
 * out `failure` is set (and reported once) and `retry` starts a fresh budget.
 */
export const useUserData = (userId: string) => {
  const [userDetails, setUserDetails] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);

  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);

  useEffect(() => {
    // Cancelled-flag teardown: userId can flip and the component can unmount
    // mid-flight; neither may set state afterwards.
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const attemptFetch = async (attempt: number) => {
      try {
        const userData = await fetchUserDetails(userId);
        if (cancelled) return;
        setUserDetails(userData);
        setFailure(null);
        setIsLoading(false);
      } catch (err: unknown) {
        if (cancelled) return;
        const failed = err instanceof Error ? err : new Error(String(err));
        setError(failed);
        // 401 is expected after sign-out (session cleared before unmount).
        if (isUnauthorized(err)) {
          setIsLoading(false);
          return;
        }
        if (attempt >= MAX_PROFILE_ATTEMPTS) {
          reportSentryError(failed, { subsystem: "client" });
          setFailure(profileLoadFailure(failed.message));
          setIsLoading(false);
          return;
        }
        const base = Math.min(
          PROFILE_BACKOFF_BASE_MS * 2 ** (attempt - 1),
          PROFILE_BACKOFF_CAP_MS,
        );
        timer = setTimeout(
          () => void attemptFetch(attempt + 1),
          withJitter(base),
        );
      }
    };

    if (userId) {
      setIsLoading(true);
      setError(null);
      setFailure(null);
      void attemptFetch(1);
    }

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [userId, retryNonce]);

  return { userDetails, isLoading, error, failure, retry };
};
