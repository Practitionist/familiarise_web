"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { pendingToast, useToast } from "@/hooks/use-toast";
import {
  AuthErrorAffordance,
  type AuthActionTarget,
} from "@/components/auth/AuthErrorAffordance";
import {
  humanizeAuthError,
  type AuthErrorAction,
} from "@/lib/labels/auth-errors";
import { AuthCardSkeleton } from "../AuthCardSkeleton";

/**
 * #1927 — `/auth/staff-invite?token=…`
 *
 * The set-your-own-password page a platform operator lands on from the
 * invitation mail. It is deliberately its own page rather than a mode of
 * `/auth/reset-password`: the two flows have different trust properties (one
 * token proves an invitation, the other proves mailbox access mid-life), a
 * different failure vocabulary (`SETUP_TOKEN_*` rather than `INVALID_TOKEN`),
 * and only one of them is allowed to create an account.
 *
 * Every refusal renders through `humanizeAuthError`, so the sentences come from
 * `lib/labels/auth-errors.catalog.ts` — which already carried the
 * `SETUP_TOKEN_INVALID` / `SETUP_TOKEN_EXPIRED` / `SETUP_TOKEN_ALREADY_USED`
 * entries and their "ask an administrator for a new one" affordances, and which
 * said 72 hours, which is what the server enforces. Nothing here invents copy
 * for a code the catalog does not have.
 */
export default function StaffInvitePage() {
  return (
    <Suspense fallback={<AuthCardSkeleton />}>
      <StaffInviteForm />
    </Suspense>
  );
}

function StaffInviteForm() {
  const { toast } = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const token = params.get("token") ?? "";

  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [errorAction, setErrorAction] = useState<AuthErrorAction | null>(null);
  const [done, setDone] = useState(false);

  /**
   * Which catalog actions this page can service.
   *
   * `contact-support` is the one that matters: a `SETUP_TOKEN_EXPIRED` or a
   * `SETUP_TOKEN_ALREADY_USED` has exactly one remedy, and it is a person, not
   * a button — this link is dead and only the administrator who sent it can
   * send another. `sign-in` covers the case where the account already exists
   * (`INVITATION_ALREADY_ACCEPTED`), which is what a double-clicked "Resend"
   * eventually produces. `retry` is never renderable: the submit button is the
   * retry.
   */
  const actionTargets = useMemo<
    Partial<Record<AuthErrorAction, AuthActionTarget>>
  >(
    () => ({
      "contact-support": {
        kind: "link",
        href: "mailto:support@familiarisenow.com",
      },
      "sign-in": { kind: "link", href: "/auth/signin" },
      "request-new-link": { kind: "link", href: "/auth/staff-invite" },
    }),
    [],
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!token) {
      setError(
        "This link is missing its setup token. Ask an administrator for a new one.",
      );
      setErrorAction("contact-support");
      return;
    }
    if (password !== confirm) {
      setError("The two passwords don't match.");
      toast({ title: "Passwords do not match", variant: "destructive" });
      return;
    }
    // Matches `minPasswordLength` / `maxPasswordLength` in lib/auth.ts, and is
    // re-checked server-side by `hashStaffPassword`. Client-side only so the
    // person finds out before a round trip — never the enforcement.
    if (password.length < 8 || password.length > 128) {
      setError("Use between 8 and 128 characters.");
      return;
    }

    setIsLoading(true);
    setError("");
    setErrorAction(null);
    const settle = pendingToast({ title: "Setting up your account…" });

    try {
      const response = await fetch("/api/auth/staff-invitation/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password, name: name || undefined }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: string;
        code?: string;
      } | null;

      if (!response.ok) {
        // The route answers `{ error, code }`; the catalog owns the sentence,
        // so a code added server-side reaches the page without an edit here.
        const copy = humanizeAuthError("signup", {
          code: payload?.code,
          error: payload?.error,
          status: response.status,
        });
        setError(payload?.error ?? copy.description);
        setErrorAction(copy.action ?? null);
        settle({
          title: copy.title,
          description: copy.description,
          variant: "destructive",
        });
        return;
      }

      setDone(true);
      settle({
        title: "Your account is ready",
        description: "Sign in with the password you just chose.",
      });
      // Deliberately NOT signing in on their behalf. The accept transaction
      // mints no session (see the route header), and landing them on the sign
      // -in form means the first thing they do with the account is the thing
      // they will do every day — including the 2FA challenge the console will
      // ask for.
      setTimeout(() => router.push("/auth/signin"), 2500);
    } catch (cause) {
      console.error("Staff invitation accept failed:", cause);
      const copy = humanizeAuthError("signup", { status: 0 });
      setError(copy.description);
      setErrorAction(copy.action ?? null);
      settle({
        title: copy.title,
        description: copy.description,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950 p-6 text-white">
      <div className="mx-auto flex w-full max-w-md flex-col">
        <div className="text-center">
          <h2 className="text-fluid-3xl font-semibold tracking-tight">
            Choose your password
          </h2>
          <p className="mt-2 text-sm text-zinc-400 md:text-base">
            You have been invited to work on Familiarise. Nobody has set a
            password for you.
          </p>
        </div>

        {error && (
          <div
            className="relative mt-8 rounded border border-red-400 bg-red-100 px-4 py-3 text-red-700"
            role="alert"
          >
            <span className="block sm:inline">{error}</span>
            <AuthErrorAffordance
              action={errorAction ?? undefined}
              target={errorAction ? actionTargets[errorAction] : undefined}
              className="mt-2 inline-block text-sm font-medium text-red-800 underline-offset-4 hover:underline"
            />
          </div>
        )}

        {!done && (
          <form className="mt-8 space-y-6" onSubmit={handleSubmit}>
            <div className="grid gap-2">
              <Label htmlFor="name">Your name (optional)</Label>
              <Input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                placeholder="How your colleagues will see you"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={isLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="password">New password</Label>
              <Input
                id="password"
                name="password"
                type="password"
                required
                autoComplete="new-password"
                placeholder="At least 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="confirm-password">Confirm new password</Label>
              <Input
                id="confirm-password"
                name="confirm-password"
                type="password"
                required
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                disabled={isLoading}
              />
            </div>

            <Button
              type="submit"
              className="w-full bg-white text-black hover:bg-white/90"
              disabled={isLoading || !token}
            >
              {isLoading ? "Setting up…" : "Set my password"}
            </Button>

            {/* Said here, not discovered later. The console answers 428
                TWO_FACTOR_REQUIRED until `twoFactorEnabled` is true, and
                finding that out as your first error after choosing a password
                reads as a bug rather than as a requirement. */}
            <p className="text-center text-sm text-zinc-400">
              Two-factor authentication is required before you can use the
              console. You will be asked to set it up straight after signing in.
            </p>
          </form>
        )}

        {done && (
          <p className="mt-8 text-center text-sm text-green-400">
            Your account is ready. Taking you to sign in…
          </p>
        )}

        <div className="mt-6 text-center text-sm">
          <Link
            href="/auth/signin"
            className="font-medium text-zinc-300 underline-offset-4 hover:text-white hover:underline"
          >
            Back to sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
