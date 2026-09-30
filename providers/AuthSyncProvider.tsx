"use client";

import { useCallback, useEffect, useRef } from "react";
import { useSession } from "@/lib/auth-client";
import {
  forgetAuthState,
  postAuthSync,
  readAuthedFlag,
  subscribeAuthSync,
  writeAuthedFlag,
  type AuthSyncMessage,
} from "@/lib/auth-broadcast";
import { signOutEverywhere } from "@/lib/auth/sign-out";
import {
  clearSentryIdentity,
  setSentryIdentity,
} from "@/lib/observability/identity";

/**
 * Keeps the auth session in sync across browser tabs.
 *
 * Mounted once at the root. It does three things:
 *   1. Listens for login/logout pings from peer tabs and refetches this tab's
 *      session so every `useSession()` consumer re-renders without a reload.
 *   2. Detects this tab's own logged-out⇄logged-in transition (covers email
 *      sign-in AND the OAuth/SSO redirect, which has no client fetch hook) and
 *      pings peers so they refetch too — including a same-profile sign-in
 *      as a DIFFERENT account (boolean true→true is no transition, so the
 *      user-id change is detected explicitly and peers are told to
 *      refetch to the new account).
 *   3. Classifies unexpected sign-outs (#1856): when this tab goes from
 *      authed to null WITHOUT initiating it — a revoked session, an expired
 *      one, or a transient failure — one authoritative re-check tells those
 *      apart. Only a confirmed-gone session signs out (with
 *      `?reason=session-revoked` so the sign-in page can say why); a failed
 *      lookup refetches instead of signing out (#1716, client-side).
 *
 * Revocation triggers feeding the classifier: the provider's own
 * visible-tab tick (cross-device, no focus needed, authoritative so
 * detection lands within ~5 min, jittered so tabs do not stampede the
 * session read), the `session-revoked` BroadcastChannel ping from the
 * tab that performed the revoke (same-browser, instant), a throttled
 * `visibilitychange` re-check (cross-device, within one tab-switch),
 * and the opt-in Redis poll below (cross-device, within the poll
 * interval).
 *   4. Mirrors the resolved session onto the Sentry user, so client-side
 *      events are attributable.
 *
 * Renders nothing. See `lib/auth-broadcast.ts` for why this is needed.
 */

/**
 * Minimum gap between authoritative re-checks (focus path and tick share it).
 */
const CHECK_THROTTLE_MS = 30_000;

/**
 * Cadence for the visible-tab revalidation tick.
 *
 * Five minutes, not sixty seconds. This check is authoritative
 * (`disableCookieCache`) and it is NOT cheap: it bypasses the cookie
 * cache and re-runs `customSession`, which is ~4 uncached Prisma round
 * trips (session, user, the nested `user.findUnique`, the nested
 * `membership.findMany`). It also travels over HTTP to
 * `/api/auth/get-session`, so the `React.cache` memo in
 * `lib/auth-server.ts` does not apply to it — there is no
 * deduplication at all on this path.
 *
 * At 60s that was thousands of extra full session resolutions per
 * minute across the fleet, on a production pool running
 * `PG_POOL_MAX=1`. The detection bound it bought over the alternatives
 * was small: an active user is already covered within one tab-switch by
 * the throttled focus check below, and a revoke from the same browser
 * lands instantly via the BroadcastChannel ping. The tick exists for
 * the one case neither covers — a tab left visible and untouched on
 * another device — and five minutes is a fine bound for that.
 *
 * The poll is the seconds-level escape hatch, and it stays opt-in.
 */
const VISIBLE_CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Extra spread on top of the interval, per tab, per cycle.
 *
 * Without it, every tab opened in the same minute fires on the same
 * second and the fleet stampedes `/get-session` in lockstep — the
 * thundering-herd shape a fixed interval always has. Jitter is drawn
 * per cycle (not once at mount) so two tabs do not stay permanently
 * in phase, and the first tick is staggered too so N tabs opened at
 * once do not all wake together.
 */
const VISIBLE_CHECK_JITTER_MS = 60_000;

/** Per-tab cursor for the opt-in Redis revocation poll. */
const REVSIG_CURSOR_KEY = "familiarise.auth_revsig";

/** 0/disabled by default — the focus check covers revocation; opt in via env. */
const REVSIG_POLL_MS = (() => {
  const raw = process.env.NEXT_PUBLIC_SESSION_REVOCATION_POLL_MS ?? "0";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();

function readRevsigCursor(): number | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(REVSIG_CURSOR_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeRevsigCursor(value: number): void {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(REVSIG_CURSOR_KEY, String(value));
  } catch {
    // Best-effort — a missing cursor just re-baselines on next read.
  }
}

/**
 * Same-profile second sign-in as a DIFFERENT account: the shared cookie
 * jar now belongs to them, but peer tabs still paint the old account
 * (boolean true→true is no transition). Ping login so peers refetch to
 * the truth, and drop this tab's revocation cursor — it belonged to the
 * old account's counter, and a lower counter there would wedge this
 * tab's poll silent forever.
 */
function handleAccountSwitch(
  authed: boolean,
  nextUserId: string | null,
  prevUserId: string | undefined,
): void {
  if (
    authed &&
    nextUserId !== null &&
    prevUserId !== undefined &&
    prevUserId !== nextUserId
  ) {
    postAuthSync({ type: "login" });
    try {
      sessionStorage.removeItem(REVSIG_CURSOR_KEY);
    } catch {
      // Best-effort — a stale cursor only delays one poll cycle.
    }
  }
}

type ProbeState = "active" | "revoked" | "unknown";

/**
 * One authoritative, three-state answer from `/api/user/sessions/current`.
 * Only 401 (no session) and 403 (suspended) mean "revoked"; a 503, any other
 * status or a network error is "unknown" and must never sign anyone out.
 */
async function probeSession(): Promise<ProbeState> {
  try {
    const res = await fetch("/api/user/sessions/current", {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (res.ok) return "active";
    if (res.status === 401 || res.status === 403) return "revoked";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export default function AuthSyncProvider() {
  const { data: session, isPending, refetch } = useSession();
  // In-memory fallback for the previous authed state, used when the cross-tab
  // localStorage flag is unavailable (private mode / blocked storage) so
  // BroadcastChannel sync still works there. Resets per page load.
  const previousAuthedRef = useRef<boolean | undefined>(undefined);
  const previousUserIdRef = useRef<string | undefined>(undefined);
  const lastCheckRef = useRef<number>(0);
  // Last user stamped onto Sentry, as `id|role`, so a re-render that resolves
  // the same session does not re-issue a `setUser` on every re-render — but a
  // ROLE change does re-issue one. The role is part of the identity label, and
  // a promotion or a back-office demotion arrives on the same `user.id`.
  const stampedIdentityRef = useRef<string | null>(null);

  /**
   * One authoritative re-check that answers "was I revoked?".
   *
   * - error (network/503) → could-not-ask, NOT a revocation: refetch
   *   through the normal path and stay put.
   * - 200 → the null was transient: refetch to recover.
   * - 401/403 while we believed we were authed → clean sign-out:
   *   drop the remembered identity, tear down Stream sockets, and land
   *   on sign-in with the reason so the page can say why.
   *
   * Asks `/api/user/sessions/current`, NOT `getSession`: BetterAuth's
   * customSession answers `200 null` for a failed lookup as well as a
   * missing session, so reading that null as "revoked" signed every open
   * tab out during a database blip.
   */
  const classifyUnexpectedSignOut = useCallback(async () => {
    if (!previousAuthedRef.current) return;
    // Capture the account this check is FOR: a same-profile sign-in as a
    // different account mid-check must not let a stale answer for the OLD
    // account sign out the NEW one. Compared again before signing out.
    const checkedUserId = previousUserIdRef.current;
    const state = await probeSession();
    if (state !== "revoked") {
      refetch?.();
      return;
    }
    if (previousUserIdRef.current !== checkedUserId) return;
    forgetAuthState();
    await signOutEverywhere("/auth/signin?reason=session-revoked");
  }, [refetch]);

  // Peer-tab pings. `session-revoked` comes from the tab that performed
  // the revoke and short-circuits the wait for focus: classify now.
  useEffect(() => {
    const onMessage = (message: AuthSyncMessage) => {
      if (message.type === "session-revoked") {
        void classifyUnexpectedSignOut();
        return;
      }
      refetch?.();
    };
    return subscribeAuthSync(onMessage);
  }, [refetch, classifyUnexpectedSignOut]);

  // Stamp the acting user onto Sentry. The single source of truth for the
  // CLIENT identity, and it lives here rather than in the sign-in page for two
  // reasons: SSO and social sign-in are full-page redirects through an IdP, so
  // the only place their return trip observes a session is this resolver —
  // which is why the previous `Sentry.setUser` in `app/auth/signin/page.tsx`
  // fired for email/password only and left every SSO and OAuth user
  // unattributed; and this also covers session expiry and cross-tab sign-out,
  // neither of which touches the sign-in page.
  //
  // The wrapped `signOut` in `lib/auth-client.ts` clears the identity on
  // SUCCESS, not eagerly — a failed sign-out leaves the user authenticated, so
  // the id already on the scope is still correct and clearing it would drop the
  // actor for someone who never left (see that file for the full argument). It
  // needs no backstop on the success path, because `signOutEverywhere` and the
  // `onError` paths hard-navigate, which reloads this provider. This effect is
  // the backstop for every path that resolves a session change WITHOUT a
  // sign-out call: session expiry, cross-tab sign-out, SSO, and OAuth.
  useEffect(() => {
    if (isPending) return;
    const userId = session?.user?.id ?? null;
    const role = session?.user?.role ?? null;
    const identity = userId ? `${userId}|${role ?? ""}` : null;
    if (identity === stampedIdentityRef.current) return;
    stampedIdentityRef.current = identity;
    if (userId) {
      setSentryIdentity({ userId, role });
    } else {
      // Without this, the next anonymous session on the same tab keeps the
      // previous account's id — so a stranger on a shared machine files events
      // against the last person who signed in.
      clearSentryIdentity();
    }
  }, [isPending, session]);

  // Unexpected authed→null transitions (revoked elsewhere, expired, or
  // transient) all land here; the classifier tells them apart. The
  // `logout` ping is kept as-is so revoked peers converge by refetch.
  useEffect(() => {
    // The loading phase is not a transition — wait for the session to resolve.
    if (isPending) return;

    const authed = !!session?.user;
    const nextUserId = session?.user?.id ?? null;
    // Snapshot first: the ping decision below must compare against the
    // LAST run's value, not the one recorded this run.
    const prevAuthed = previousAuthedRef.current;
    // Prefer THIS tab's last observed state: the wrapped `signOut` clears the
    // localStorage flag BEFORE the network call (shared-device fail-safe), so
    // by the time the session resolves null the flag already reads `false` and
    // flag-first comparison would swallow the logout ping. The snapshot is
    // immune to that pre-clear; it is undefined only on first resolution,
    // where we fall back to the flag so an OAuth/SSO full-page redirect (new
    // load, no client fetch hook) still pings peers.
    const previous = prevAuthed ?? readAuthedFlag();
    // typeof check: with storage blocked, readAuthedFlag() returns null —
    // `null !== undefined` would treat "no known before-state" as a transition
    // and fire a spurious login/logout ping on first resolution.
    if (typeof previous === "boolean" && previous !== authed) {
      postAuthSync({ type: authed ? "login" : "logout" });
      if (previous && !authed) {
        // Seed the ref BEFORE classifying: it reads the ref
        // synchronously, and on first resolution the ref is still
        // undefined (which reads as "never authed" and aborts the
        // check) — a cold tab whose session died while away would then
        // never classify. Later runs already carry the prior value.
        if (prevAuthed === undefined) previousAuthedRef.current = true;
        void classifyUnexpectedSignOut();
      }
    }
    previousAuthedRef.current = authed;
    // Same-profile second sign-in as a DIFFERENT account is no boolean
    // transition — detect the user-id change explicitly (see helper).
    handleAccountSwitch(authed, nextUserId, previousUserIdRef.current);
    previousUserIdRef.current = nextUserId ?? undefined;
    // Also the reconciliation point for the navbar's optimistic first paint:
    // a resolved session rewrites the remembered shape in BOTH directions, and
    // `writeAuthedFlag(false)` drops the cached identity outright.
    writeAuthedFlag(
      authed,
      authed
        ? {
            name: session?.user?.name ?? null,
            image: session?.user?.image ?? null,
          }
        : null,
    );
  }, [isPending, session, classifyUnexpectedSignOut]);

  // Cross-device, within one tab-switch: when the tab becomes visible,
  // run the authoritative check (throttled — it bypasses the cookie
  // cache and re-runs customSession enrichment, so it is NOT cheap).
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== "visible") return;
      if (previousAuthedRef.current !== true) return;
      const now = Date.now();
      if (now - lastCheckRef.current < CHECK_THROTTLE_MS) return;
      lastCheckRef.current = now;
      void classifyUnexpectedSignOut();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [classifyUnexpectedSignOut]);

  // Visible-tab revalidation, no focus or opt-in needed: while this tab
  // believes it is signed in, re-run the authoritative check on a steady
  // cadence. Hidden tabs skip (zero cost asleep); logged-out tabs return
  // inside the classifier immediately. The check is authoritative
  // (disableCookieCache), so unlike a cookie-cached refetch it detects
  // revocation the same tick — bounded by the cadence below, with no
  // re-render on the happy path (only a confirmed null navigates).
  // Shares lastCheckRef with the focus path so the two never double-fire.
  //
  // Self-rescheduling setTimeout rather than setInterval, so the jitter
  // is re-drawn each cycle: a fixed interval would keep every tab in
  // phase and re-create the same-second stampede the jitter removes.
  useEffect(() => {
    let timer: number | undefined;

    const runVisibleCheck = () => {
      if (document.visibilityState !== "visible") return;
      if (previousAuthedRef.current !== true) return;
      const now = Date.now();
      if (now - lastCheckRef.current < VISIBLE_CHECK_INTERVAL_MS) return;
      lastCheckRef.current = now;
      void classifyUnexpectedSignOut();
    };

    const schedule = (delayMs: number) => {
      timer = window.setTimeout(() => {
        runVisibleCheck();
        schedule(
          VISIBLE_CHECK_INTERVAL_MS + Math.random() * VISIBLE_CHECK_JITTER_MS,
        );
      }, delayMs);
    };

    // Stagger the first one so tabs opened together do not all wake at
    // the same instant; subsequent cycles carry the base + fresh jitter.
    schedule(Math.random() * VISIBLE_CHECK_JITTER_MS);

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [classifyUnexpectedSignOut]);

  // Cross-device, within the poll interval: compare the per-user
  // revocation counter against this tab's cursor. Opt-in only
  // (NEXT_PUBLIC_SESSION_REVOCATION_POLL_MS, default 0 = off). A move
  // means "something was revoked" — the classifier confirms whether it
  // was US. Strictly-greater comparison: a Redis restart resets the
  // counter and must not mass-sign-out users.
  useEffect(() => {
    if (REVSIG_POLL_MS <= 0) return;
    const id = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (previousAuthedRef.current !== true) return;
      void (async () => {
        try {
          const res = await fetch("/api/user/sessions/revocation-signal", {
            credentials: "same-origin",
          });
          if (!res.ok) {
            // A 401/403 here means OUR session is gone (requireApiAuth
            // answers before the route reads the counter) — classify now
            // instead of sitting stale until the next focus event. Any
            // other status (503, 500, network) is "could not ask", never
            // a revocation (#1716): stay put.
            if (res.status === 401 || res.status === 403) {
              await classifyUnexpectedSignOut();
            }
            return;
          }
          const { signal } = (await res.json()) as { signal: unknown };
          if (typeof signal !== "number") return;
          const cursor = readRevsigCursor();
          if (cursor === null) {
            writeRevsigCursor(signal);
            return;
          }
          if (signal > cursor) {
            writeRevsigCursor(signal);
            await classifyUnexpectedSignOut();
          }
        } catch {
          // Best-effort — the focus check remains the source of truth.
        }
      })();
    }, REVSIG_POLL_MS);
    return () => window.clearInterval(id);
  }, [classifyUnexpectedSignOut]);

  return null;
}
