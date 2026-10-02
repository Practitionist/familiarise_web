"use client";

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Building2, CheckCircle2, AlertCircle, Loader2 } from "lucide-react";
import { GlobeIcon } from "@/components/auth/auth-icons";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useSession } from "@/lib/auth-client";
import { MEMBER_ROLE_LABEL, MemberRoleSchema } from "@/lib/labels/org-labels";
import { humanizeOrgError } from "@/lib/labels/org-errors";
import {
  AUTH_ERROR_COPY,
  normalizeAuthErrorCode,
} from "@/lib/labels/auth-errors";
import {
  PURPOSE_CODE_META,
  SIGNUP_PURPOSES,
} from "@/lib/compliance/purpose-codes";

interface AcceptResponse {
  organization: { id: string; name: string };
  role?: string;
  alreadyMember?: boolean;
}

/** `"<title>. <description>"` — the one shape a single `<p>` can hold. */
function joinCopy(copy: { title: string; description: string }): string {
  return `${copy.title}. ${copy.description}`;
}

/**
 * The accept route's real refusals, in the customer's words.
 *
 * BEFORE: every non-OK accept became one string — `body.error` fed to
 * `humanizeOrgError`, which passes unknown input through unchanged. The
 * route answers *sentences*, not codes (`{ error: "Invitation has expired" }`,
 * `{ error: "This invitation is not addressed to you" }`), so the invitee saw
 * server prose — and, on the 403, the organisation's internal status enum —
 * where a sentence was owed. The codes already existed in the auth catalog
 * (`INVITATION_EXPIRED`, `INVITATION_NOT_FOR_YOU`, …); nothing was reading
 * them.
 *
 * Resolution order:
 *   1. A real `code` from the route, if it ever grows one. `normalizeAuthErrorCode`
 *      narrows it, so a stray string cannot index the catalog.
 *   2. The status, which is the only machine signal the route currently
 *      offers, disambiguated by `raw` only where two refusals share a status
 *      (the two 404s, the two 409s).
 *   3. `humanizeOrgError` for the app-rail codes the org dashboard mints
 *      (`NOT_A_CONSULTANT`, `ORG_NOT_VERIFIED`, …), whose whole reason for
 *      existing is this call site.
 *
 * The two sentences below are page-local because the catalog has no entry for
 * them. Both are deliberate: the route's own sentence for the first embeds the
 * organisation's internal status enum, and neither says anything an invitee
 * can act on. The honest long-term fix is an `ORG_*` code in
 * `lib/labels/org-errors.ts` (not owned here) — flagged in the handoff.
 */
function inviteAcceptanceCopy(
  status: number,
  code: string | null,
  raw: string | null,
): string {
  const normalized = normalizeAuthErrorCode(code);
  if (normalized) return joinCopy(AUTH_ERROR_COPY[normalized]);

  // 410 — `inv.expiresAt < Date.now()`.
  if (status === 410) return joinCopy(AUTH_ERROR_COPY.INVITATION_EXPIRED);

  if (status === 404) {
    // Two 404s: the invitation row is gone, or the organisation is. The
    // first is an ordinary dead link; the second means the inviter has
    // nothing left to invite anyone into.
    return raw === "Organization no longer exists"
      ? "This organisation no longer exists, so the invitation can't be accepted. Ask whoever invited you for a new one."
      : joinCopy(AUTH_ERROR_COPY.INVITATION_NOT_FOUND);
  }

  if (status === 403) {
    // `requireApiAuth` — the accepter's own account is suspended. Checked
    // first because it is not an invitation problem at all.
    if (raw === "Account suspended") {
      return joinCopy(AUTH_ERROR_COPY.BANNED_USER);
    }
    // `isOnboardingBlocked(org.status)` inside the accept transaction. The
    // route's sentence is `Organization is <status>; cannot accept new
    // members` — the status enum is ours, not the invitee's, so it is not
    // echoed back.
    if (raw?.startsWith("Organization is ")) {
      return "This organisation isn't accepting new members right now. Ask an administrator to re-activate it, then use the link in the invitation email again.";
    }
    // `inv.email !== session.user.email` — the only 403 left.
    return joinCopy(AUTH_ERROR_COPY.INVITATION_NOT_FOR_YOU);
  }

  if (status === 409) {
    // Two 409s from the accept transaction: the atomic claim lost (this is
    // the double-click / two-tabs case, and the same answer as a link that
    // was already redeemed), or the membership row is an `ERASED` tombstone.
    if (raw?.includes("erased")) {
      return "This membership was erased, so the invitation can't be accepted. Ask an administrator for a new invitation.";
    }
    return joinCopy(AUTH_ERROR_COPY.INVITATION_ALREADY_ACCEPTED);
  }

  // 401 — the accepter's session is gone (`requireApiAuth`), so the button
  // can never succeed until they sign in again.
  if (status === 401) {
    return "Your session has ended. Sign in again, then reopen the invitation link.";
  }

  // 503 — the session *lookup* failed, which is not "signed out"
  // (see `lib/auth-session-lookup.ts`); the catalog's UNREACHABLE entry is
  // the honest sentence and it explicitly says nothing was changed.
  if (status === 503) {
    return joinCopy(AUTH_ERROR_COPY.SESSION_LOOKUP_FAILED);
  }

  return humanizeOrgError(raw ?? "We could not accept this invitation.");
}

type PreviewState =
  | { phase: "loading" }
  | { phase: "valid"; orgName: string; orgLogo: string | null; role: string }
  | { phase: "invalid"; message: string };

// The preview API returns `role` as a free-form string (Invitation.role).
// Narrow it to a MemberRole before label lookup;
// fall back to the raw value when the string doesn't match the enum.
function roleLabel(role: string): string {
  const parsed = MemberRoleSchema.safeParse(role);
  return parsed.success ? MEMBER_ROLE_LABEL[parsed.data] : role;
}

/**
 * Public invitation acceptance page.
 *
 * Flow:
 *   1. Always fetch a public preview of the invitation (org name, role) so the
 *      page shows meaningful context to any visitor, authenticated or not.
 *   2. Unauthenticated → show "Join <OrgName> as <Role>" + Sign in / Create
 *      account buttons. Both preserve the token via callbackUrl so the visitor
 *      lands back here after auth and auto-accepts.
 *   3. Authenticated → POST /api/organizations/invitations/accept. On success,
 *      route to the org dashboard.
 *   4. Expired / already-accepted token → show a clear error from the preview
 *      step before prompting the visitor to sign in.
 *
 * The route lives outside the dashboard group so middleware doesn't gate it
 * behind a session cookie.
 */
export default function InviteAcceptPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = use(params);
  const router = useRouter();
  const { data: session, isPending } = useSession();

  const [preview, setPreview] = useState<PreviewState>({ phase: "loading" });
  const [status, setStatus] = useState<
    "idle" | "accepting" | "consent" | "success" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  // The raw code, for the one refusal that has a next step of its own.
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [result, setResult] = useState<AcceptResponse | null>(null);

  // Fetch invitation preview on mount — no auth required.
  // This gives the page enough context to show org name, role, and an
  // expired/invalid error before prompting the visitor to sign in.
  useEffect(() => {
    fetch(`/api/invitations/preview?token=${encodeURIComponent(token)}`)
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) {
          setPreview({
            phase: "invalid",
            message: body.error ?? "This invitation is no longer valid.",
          });
        } else {
          setPreview({
            phase: "valid",
            orgName: body.orgName,
            orgLogo: body.orgLogo,
            role: body.role,
          });
        }
      })
      .catch(() => {
        setPreview({
          phase: "invalid",
          message: "Could not load invitation details.",
        });
      });
  }, [token]);

  // Store the token in localStorage so new users signing up via this link
  // can be auto-redirected back here after completing onboarding.
  // This bridges the signup → onboarding → dashboard redirect chain where
  // the callbackUrl would otherwise be lost.
  //
  // KNOWN FRAGILITY (reported, deliberately unchanged — this works and the
  // only consumer, `app/form/onboarding/page.tsx`, already ranks an explicit
  // `callbackUrl` above this key):
  //
  //   - No TTL. The key is written on every render for a signed-out visitor
  //     and is only removed once onboarding completes, so an abandoned
  //     invitation link leaves a key that outlives the invitation's own
  //     14-day life and is then navigated to on an unrelated onboarding.
  //   - Not tab-scoped. A second tab that finishes onboarding first consumes
  //     the token, and the invitee lands on the invite page with nothing to
  //     accept (the atomic claim in the accept route then answers 409).
  //   - The consumer's `localStorage.getItem` is not wrapped in try/catch
  //     (the writer here is). Safari private mode can throw on access.
  //   - The value is interpolated into `/organizations/invite/${pendingToken}`
  //     on the consumer side, unvalidated. It is an opaque 64-char hex id and
  //     the page re-encodes it for the preview fetch, so there is no sink
  //     here today — but the key is untrusted input on a navigation.
  //
  // The durable fix is a short-lived, per-tab value (sessionStorage, or a
  // signed short-TTL cookie) rather than an unbounded localStorage key; that
  // is a change to the onboarding page too, so it is not made here.
  useEffect(() => {
    if (!isPending && !session?.user?.id) {
      try {
        localStorage.setItem("pendingOrgInviteToken", token);
      } catch {
        // localStorage unavailable — callbackUrl in the links below is the fallback
      }
    }
  }, [isPending, session, token]);

  // Auto-accept once session is ready — runs regardless of preview phase.
  // Preview only gates the unauthenticated sign-in prompt; authenticated users
  // always attempt accept so the accept API can surface specific, verified errors
  // (e.g. "you're already a member → go to dashboard" vs. generic "no longer valid").
  //
  // Flat `async` rather than a promise chain that throws a sentence: the
  // previous shape stashed the refusal in an `Error`'s message, read it back
  // out, and fed it to `humanizeOrgError` — which passes an unrecognised
  // string through untouched. Keying off `res.status` here is what lets
  // `inviteAcceptanceCopy` answer the 403/409/410s differently.
  const accept = useCallback(
    async (grantConsent: boolean) => {
      setStatus("accepting");
      setError(null);
      setErrorCode(null);
      let res: Response;
      try {
        res = await fetch("/api/organizations/invitations/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            invitationId: token,
            ...(grantConsent && { grantConsent: true }),
          }),
        });
      } catch {
        // Never completed, so nothing was written — say that rather than
        // guessing at a reason.
        setError(
          "We couldn't reach the server. Check your connection and try again.",
        );
        setStatus("error");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      // #1854 — no data-processing consent yet (an SSO-created account):
      // ask for it here, then accept with it in one request.
      if (res.status === 403 && body.code === "CONSENT_REQUIRED") {
        setStatus("consent");
        return;
      }
      if (!res.ok) {
        const raw = typeof body.error === "string" ? body.error : null;
        const code = typeof body.code === "string" ? body.code : null;
        // Kept for the one refusal with a next step of its own (the expert
        // profile wizard). The route sends that one as a bare code, so
        // `code ?? raw` is what carries it — see the render branch.
        setErrorCode(code ?? raw);
        setError(inviteAcceptanceCopy(res.status, code, raw));
        setStatus("error");
        return;
      }
      setResult(body as unknown as AcceptResponse);
      setStatus("success");
    },
    [token],
  );

  useEffect(() => {
    if (isPending) return;
    if (!session?.user?.id) return;
    if (status !== "idle") return;
    accept(false);
  }, [isPending, session, status, accept]);

  // Auto-route on success after a brief confirmation flash.
  useEffect(() => {
    if (status === "success" && result) {
      const t = setTimeout(() => {
        router.push(`/dashboard/organization/${result.organization.id}/home`);
      }, 1200);
      return () => clearTimeout(t);
    }
  }, [status, result, router]);

  // Derive org name + logo from whichever source is available:
  // preview (always) or accept response (after success).
  const orgName =
    status === "success" && result
      ? result.organization.name
      : preview.phase === "valid"
        ? preview.orgName
        : null;

  const orgLogo = preview.phase === "valid" ? preview.orgLogo : null;

  return (
    <div className="min-h-screen flex flex-col items-center justify-center bg-muted/40 p-4">
      <Link
        href="/"
        className="mb-6 inline-flex items-center gap-2 text-sm font-semibold tracking-wider text-foreground uppercase transition-opacity hover:opacity-80"
      >
        <GlobeIcon className="h-4 w-4" />
        Familiarise
      </Link>
      <Card className="w-full max-w-md rounded-2xl border-border shadow-elevation-2">
        <CardHeader className="text-center">
          <div className="w-12 h-12 mx-auto mb-3 rounded-xl bg-muted border border-border flex items-center justify-center overflow-hidden">
            {orgLogo ? (
              <Image
                src={orgLogo}
                alt={orgName ?? "Organization"}
                width={48}
                height={48}
                className="object-cover"
              />
            ) : (
              <Building2 className="w-6 h-6 text-muted-foreground" />
            )}
          </div>
          <CardTitle>
            {orgName ? `Join ${orgName}` : "Organization invitation"}
          </CardTitle>
          {preview.phase === "valid" && (
            <CardDescription>
              You&apos;ve been invited as a{" "}
              <span className="font-medium text-foreground">
                {roleLabel(preview.role)}
              </span>
            </CardDescription>
          )}
          {preview.phase === "loading" && (
            <CardDescription>Loading invitation details…</CardDescription>
          )}
        </CardHeader>
        <CardContent>
          {/* Session or preview still loading — match card anatomy */}
          {(preview.phase === "loading" || isPending) && (
            <div className="space-y-3 py-2" aria-busy="true">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-11 w-full rounded-lg" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
          )}

          {/* Authenticated users — always run through the accept flow.
              The accept API is identity-verified so it can surface specific,
              helpful errors (e.g. "you're already a member → go to dashboard")
              rather than the generic message the public preview uses. */}
          {!isPending && session?.user?.id && status === "consent" && (
            <InviteConsentStep onAgree={() => accept(true)} />
          )}
          {!isPending && session?.user?.id && status !== "consent" && (
            <>
              {status === "accepting" || status === "idle" ? (
                <div className="flex flex-col items-center py-6 gap-2">
                  <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    Accepting invitation…
                  </p>
                </div>
              ) : status === "success" && result ? (
                <div className="text-center space-y-2 py-2">
                  <CheckCircle2 className="h-10 w-10 text-emerald-500 mx-auto" />
                  <p className="text-base font-medium text-foreground">
                    {result.alreadyMember
                      ? "You're already a member!"
                      : "You're in!"}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {result.alreadyMember
                      ? `Taking you to ${result.organization.name}…`
                      : `Welcome to ${result.organization.name}. Redirecting you now…`}
                  </p>
                </div>
              ) : (
                <div className="text-center space-y-3 py-2">
                  <AlertCircle className="h-10 w-10 text-destructive mx-auto" />
                  <p className="text-sm text-foreground">
                    {error ?? "We could not accept this invitation."}
                  </p>
                  {errorCode === "NOT_A_CONSULTANT" ? (
                    // The wizard's add mode creates the expert profile on this
                    // account and returns here to finish accepting (PR-6).
                    <Link
                      href={`/form/onboarding?add=CONSULTANT&callbackUrl=${encodeURIComponent(`/organizations/invite/${token}`)}`}
                    >
                      <Button size="sm">Set up your expert profile</Button>
                    </Link>
                  ) : null}
                  <Link href="/dashboard">
                    <Button variant="outline" size="sm">
                      Go to dashboard
                    </Button>
                  </Link>
                </div>
              )}
            </>
          )}

          {/* Unauthenticated users — preview determines what they see.
              Generic error for all invalid states prevents state enumeration. */}
          {!isPending && !session?.user?.id && preview.phase !== "loading" && (
            <>
              {preview.phase === "invalid" ? (
                <div className="text-center space-y-3 py-2">
                  <AlertCircle className="h-10 w-10 text-destructive mx-auto" />
                  <p className="text-sm text-foreground">{preview.message}</p>
                  <Link href="/">
                    <Button variant="outline" size="sm">
                      Go to homepage
                    </Button>
                  </Link>
                </div>
              ) : (
                <div className="text-center space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Sign in or create an account to accept this invitation.
                  </p>
                  <div className="flex flex-col gap-2">
                    <Link
                      href={`/auth/signin?callbackUrl=${encodeURIComponent(
                        `/organizations/invite/${token}`,
                      )}`}
                    >
                      <Button className="w-full">Sign in</Button>
                    </Link>
                    <Link
                      href={`/auth/signup?callbackUrl=${encodeURIComponent(
                        `/organizations/invite/${token}`,
                      )}`}
                    >
                      <Button variant="outline" className="w-full">
                        Create account
                      </Button>
                    </Link>
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * #1854 — the sign-up consent, shown inline to an invitee who has none (an
 * account created by SSO sign-in). Agreeing records it and joins in one step.
 */
function InviteConsentStep({ onAgree }: Readonly<{ onAgree: () => void }>) {
  return (
    <div className="space-y-4 py-2">
      <p className="text-sm text-muted-foreground">
        To join, we need your consent to process your data for these purposes.
        You can withdraw it at any time in Account › Data consent.
      </p>
      <ul className="space-y-2 text-sm">
        {SIGNUP_PURPOSES.map((code) => (
          <li key={code}>
            <p className="font-medium text-foreground">
              {PURPOSE_CODE_META[code].label}
            </p>
            <p className="text-muted-foreground">
              {PURPOSE_CODE_META[code].description}
            </p>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        By clicking Agree and join, you agree to our Terms of Service and
        Privacy Policy.
      </p>
      <div className="flex flex-col gap-2">
        <Button className="w-full" onClick={onAgree}>
          Agree and join
        </Button>
        <Link href="/dashboard">
          <Button variant="outline" className="w-full">
            Not now
          </Button>
        </Link>
      </div>
    </div>
  );
}
